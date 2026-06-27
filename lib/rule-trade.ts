/**
 * 本番ライブ売買サイクル（決定論ルールエンジン版）。
 *
 * 複数期間バックテストで「勝率約62%・全窓プラス・最大DD-14%」と最も頑健だった設定を
 * そのままライブに適用する。GROQ(LLM)不要・再現性あり。GitHub Actionsが米国市場時間に
 * 5分ごと呼び出す前提:
 *   - 毎サイクル: 保有のリスク管理（損切り-8% / 利確+10%）とスナップショット記録。
 *   - 1営業日に1度（ETの暦日が変わったら）: スクリーニング→ruleDecideで新規BUY。
 *     ただしリスクオフ局面(SPY<SMA20)では新規BUYを停止。
 *
 * フィードバック用に、全判断(decision_log)とサイクル(cycle_log)を保存する。
 */
import { getQuotes, getChart, type Quote } from "./yahoo";
import { runScreener, getScreenedTickers } from "./screener";
import { summarize, sma } from "./indicators";
import { ruleDecide, TUNED_PARAMS, type Candidate } from "./strategy";
import {
  executeBuy,
  executeSell,
  getCash,
  getHoldings,
  getPortfolioSummary,
  recordEquitySnapshot,
  type TradeResult,
} from "./trading";
import { getNewsForTickers } from "./news";
import { getUsMarketStatus } from "./market";
import { getUsdJpyRate } from "./currency";
import { getSetting, setSetting, logDecision, logCycle } from "./db";

const STOP_LOSS_PCT = -8;
const TAKE_PROFIT_PCT = 10;
const MAX_POSITION_PCT = 0.2;
const MIN_CASH_PCT = 0.1;
const REGIME_SMA = 20;
const COOLDOWN_DAYS = 5;
const TOP_N = 12;

export interface RuleCycleResult {
  ranAt: string;
  marketOpen: boolean;
  riskOff: boolean;
  decisions: number;
  executed: number;
  trades: TradeResult[];
  note: string;
}

/** ET（米東部）の暦日キー YYYY-MM-DD。1日1回のBUY判定に使う。 */
function etDayKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/** SPYが自身のSMA20を下回るリスクオフ局面か。取得失敗時はfalse（通常運用）。 */
async function isRiskOff(): Promise<boolean> {
  try {
    const spy = await getChart("SPY", "3mo");
    const closes = spy.map((c) => c.close);
    const s = sma(closes, REGIME_SMA);
    const last = closes[closes.length - 1];
    return s != null && last < s;
  } catch {
    return false;
  }
}

/* ---------- 損切り後クールダウン（settings JSONで管理） ---------- */
function getCooldownMap(): Record<string, string> {
  try { return JSON.parse(getSetting("cooldown") ?? "{}"); } catch { return {}; }
}
function setCooldown(ticker: string): void {
  const m = getCooldownMap();
  m[ticker] = etDayKey();
  setSetting("cooldown", JSON.stringify(m));
}
function inCooldown(ticker: string): boolean {
  const m = getCooldownMap();
  const d = m[ticker];
  if (!d) return false;
  const days = (Date.parse(etDayKey()) - Date.parse(d)) / (24 * 60 * 60 * 1000);
  return days < COOLDOWN_DAYS;
}

/* ---------- ベンチマーク(SPY buy&hold)評価額 ---------- */
async function benchmarkValueJpy(): Promise<number | null> {
  const shares = Number(getSetting("bench_spy_shares") ?? "0");
  if (!shares) return null;
  try {
    const [spy] = await getQuotes(["SPY"]);
    return spy ? spy.priceJpy * shares : null;
  } catch {
    return null;
  }
}

export async function runRuleTradeCycle(): Promise<RuleCycleResult> {
  const ranAt = new Date().toISOString();
  const market = getUsMarketStatus();
  const trades: TradeResult[] = [];
  let decisionCount = 0;
  let executedCount = 0;

  // 市場が閉じているサイクルは何もしない（記録のみ）
  if (!market.isOpen) {
    const cash = getCash();
    const summary = await getPortfolioSummary().catch(() => null);
    logCycle({
      engine: "rule", riskOff: false, marketOpen: false, screened: [],
      decisions: 0, executed: 0,
      totalValueJpy: summary?.totalValueJpy ?? cash, cashJpy: cash,
      note: `休場: ${market.reason}`,
    });
    return { ranAt, marketOpen: false, riskOff: false, decisions: 0, executed: 0, trades, note: market.reason };
  }

  const riskOff = await isRiskOff();

  // 1) リスク管理: 保有の損切り/利確（毎サイクル）
  const summary = await getPortfolioSummary();
  const limits = {
    maxPositionJpy: summary.totalValueJpy * MAX_POSITION_PCT,
    minCashJpy: summary.totalValueJpy * MIN_CASH_PCT,
  };
  for (const h of summary.holdings) {
    let reason = "";
    if (h.unrealizedPnlPct <= STOP_LOSS_PCT) reason = `自動損切り(${h.unrealizedPnlPct.toFixed(1)}%)`;
    else if (h.unrealizedPnlPct >= TAKE_PROFIT_PCT) reason = `自動利確(${h.unrealizedPnlPct.toFixed(1)}%)`;
    if (!reason) continue;
    decisionCount++;
    const r = await executeSell(h.ticker, h.shares, "AI", reason).catch(
      (e) => ({ ok: false, message: (e as Error).message }) as TradeResult,
    );
    if (r.ok) { executedCount++; if (reason.startsWith("自動損切り")) setCooldown(h.ticker); }
    trades.push(r);
    logDecision({
      ticker: h.ticker, action: "SELL", shares: h.shares, executed: r.ok,
      rejectReason: r.ok ? null : r.message, reasoning: reason,
      priceJpy: h.currentPriceJpy, pnlPct: h.unrealizedPnlPct,
    });
  }

  // 2) 新規BUY: 1営業日に1度だけ（ETの暦日で判定）
  const today = etDayKey();
  const lastBuyDay = getSetting("last_buy_et_day");
  let screened: string[] = [];
  if (lastBuyDay !== today) {
    setSetting("last_buy_et_day", today);
    await runScreener(true).catch(() => {});
    screened = getScreenedTickers().slice(0, TOP_N);
    if (screened.length > 0) {
      const cash = getCash();
      const quotes = await getQuotes(screened);
      const quoteMap = new Map<string, Quote>(quotes.map((q) => [q.ticker, q]));
      let news: Record<string, { title: string }[]> = {};
      try { news = await getNewsForTickers(screened); } catch { /* 指標のみで継続 */ }

      const candidates: Candidate[] = [];
      const ctxByTicker = new Map<string, { rsi14: number | null; sma20: number | null; sma50: number | null; momPct: number; dayRet: number; priceJpy: number }>();
      for (const t of screened) {
        const q = quoteMap.get(t);
        if (!q) continue;
        let closes: number[] = [];
        try { closes = (await getChart(t, "3mo")).map((c) => c.close); } catch { /* skip */ }
        if (closes.length < 2) continue;
        const { sma20, sma50, rsi14 } = summarize(closes);
        const lastClose = closes[closes.length - 1];
        const lookback = Math.min(20, closes.length - 1);
        const monthAgo = closes[closes.length - 1 - lookback];
        const momPct = ((lastClose - monthAgo) / monthAgo) * 100;
        const dayRet = closes.length >= 2 ? ((lastClose - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0;
        const maxBuyShares = Math.max(0, Math.floor(limits.maxPositionJpy / q.priceJpy));
        candidates.push({
          ticker: t, lastClose: q.price, sma20, sma50, rsi14, momPct,
          maxBuyShares, heldShares: 0, avgCost: null,
          newsTitles: (news[t] ?? []).map((n) => n.title),
        });
        ctxByTicker.set(t, { rsi14, sma20, sma50, momPct, dayRet, priceJpy: q.priceJpy });
      }

      const decisions = ruleDecide(candidates, {
        cash, minCash: limits.minCashJpy, params: TUNED_PARAMS, inCooldown,
      });
      for (const d of decisions) {
        if (d.action !== "BUY" || d.shares <= 0) continue;
        decisionCount++;
        const ctx = ctxByTicker.get(d.ticker);
        if (riskOff) {
          logDecision({
            ticker: d.ticker, action: "BUY", shares: d.shares, executed: false,
            rejectReason: "リスクオフ(SPY<SMA20)", reasoning: d.reasoning,
            priceJpy: ctx?.priceJpy, rsi14: ctx?.rsi14, sma20: ctx?.sma20, sma50: ctx?.sma50, momPct: ctx?.momPct, dayRet: ctx?.dayRet,
          });
          continue;
        }
        const r = await executeBuy(d.ticker, d.shares, "AI", d.reasoning, limits).catch(
          (e) => ({ ok: false, message: (e as Error).message }) as TradeResult,
        );
        if (r.ok) executedCount++;
        trades.push(r);
        logDecision({
          ticker: d.ticker, action: "BUY", shares: d.shares, executed: r.ok,
          rejectReason: r.ok ? null : r.message, reasoning: d.reasoning,
          priceJpy: ctx?.priceJpy, rsi14: ctx?.rsi14, sma20: ctx?.sma20, sma50: ctx?.sma50, momPct: ctx?.momPct, dayRet: ctx?.dayRet,
        });
      }
    }
  }

  // 3) スナップショット記録（ベンチマーク込み）
  const finalSummary = await getPortfolioSummary().catch(() => null);
  const finalCash = getCash();
  const totalValue = finalSummary?.totalValueJpy ?? finalCash;
  const bench = await benchmarkValueJpy();
  recordEquitySnapshot(totalValue, finalCash, bench);

  logCycle({
    engine: "rule", riskOff, marketOpen: true, screened,
    decisions: decisionCount, executed: executedCount,
    totalValueJpy: totalValue, cashJpy: finalCash,
    note: riskOff ? "リスクオフ(新規BUY停止)" : undefined,
  });

  return {
    ranAt, marketOpen: true, riskOff,
    decisions: decisionCount, executed: executedCount, trades,
    note: `${decisionCount}判断 / ${executedCount}約定${riskOff ? " / リスクオフ" : ""}`,
  };
}
