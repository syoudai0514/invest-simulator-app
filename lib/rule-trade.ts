/**
 * 本番ライブ売買サイクル（決定論ルールエンジン版・米国/日本 両対応）。
 *
 * 複数期間バックテストで最も頑健だった設定（利確+10% / 損切り-8% / レジームフィルタ /
 * 1営業日1回の新規BUY）をそのままライブに適用する。GROQ(LLM)不要・再現性あり。
 * 市場(US/JP)ごとに独立した口座・ユニバース・ベンチ・取引時間で動く。
 *
 * GitHub Actions が各市場の時間帯に5分ごと呼び出す前提:
 *   - 毎サイクル: 保有のリスク管理（損切り/利確）とスナップショット記録。
 *   - 1営業日に1度: スクリーニング→ruleDecideで新規BUY。リスクオフ(指数<SMA20)時は停止。
 */
import { getQuotes, getChart, type Quote, type Market } from "./yahoo";
import { runScreener, getScreenedTickers } from "./screener";
import { summarize, sma } from "./indicators";
import { ruleDecide, TUNED_PARAMS, type Candidate } from "./strategy";
import {
  executeBuy,
  executeSell,
  getCash,
  getPortfolioSummary,
  recordEquitySnapshot,
  type TradeResult,
} from "./trading";
import { getNewsForTickers } from "./news";
import { getMarketStatus } from "./market";
import { getSetting, setSetting, logDecision, logCycle } from "./db";

const STOP_LOSS_PCT = -8;
const TAKE_PROFIT_PCT = 10;
const MAX_POSITION_PCT = 0.2;
const MIN_CASH_PCT = 0.1;
const REGIME_SMA = 20;
const COOLDOWN_DAYS = 5;
const TOP_N = 12;

interface MarketConfig {
  bench: string; // レジーム判定・ベンチ用の指数ティッカー
  tz: string; // 1営業日判定に使うタイムゾーン
}
const MARKET_CFG: Record<Market, MarketConfig> = {
  US: { bench: "SPY", tz: "America/New_York" },
  JP: { bench: "^N225", tz: "Asia/Tokyo" },
};

export interface RuleCycleResult {
  market: Market;
  ranAt: string;
  marketOpen: boolean;
  riskOff: boolean;
  decisions: number;
  executed: number;
  trades: TradeResult[];
  note: string;
}

function dayKey(tz: string, d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

async function isRiskOff(bench: string): Promise<boolean> {
  try {
    const closes = (await getChart(bench, "3mo")).map((c) => c.close);
    const s = sma(closes, REGIME_SMA);
    const last = closes[closes.length - 1];
    return s != null && last < s;
  } catch {
    return false;
  }
}

/* ---------- 損切り後クールダウン（市場別 settings JSON） ---------- */
function cooldownKey(market: Market) { return `cooldown_${market}`; }
function getCooldownMap(market: Market): Record<string, string> {
  try { return JSON.parse(getSetting(cooldownKey(market)) ?? "{}"); } catch { return {}; }
}
function setCooldown(market: Market, ticker: string, tz: string): void {
  const m = getCooldownMap(market);
  m[ticker] = dayKey(tz);
  setSetting(cooldownKey(market), JSON.stringify(m));
}
function makeInCooldown(market: Market, tz: string) {
  const m = getCooldownMap(market);
  return (ticker: string): boolean => {
    const d = m[ticker];
    if (!d) return false;
    return (Date.parse(dayKey(tz)) - Date.parse(d)) / 86_400_000 < COOLDOWN_DAYS;
  };
}

/* ---------- ベンチマーク(指数 buy&hold)評価額 ---------- */
async function benchmarkValueJpy(market: Market, bench: string): Promise<number | null> {
  const shares = Number(getSetting(`bench_shares_${market}`) ?? "0");
  if (!shares) return null;
  try {
    const [q] = await getQuotes([bench]);
    return q ? q.priceJpy * shares : null;
  } catch { return null; }
}

/** 1市場の売買サイクルを1回実行する。 */
export async function runRuleTradeCycle(market: Market): Promise<RuleCycleResult> {
  const ranAt = new Date().toISOString();
  const cfg = MARKET_CFG[market];
  const status = getMarketStatus(market);
  const trades: TradeResult[] = [];
  let decisionCount = 0;
  let executedCount = 0;

  if (!status.isOpen) {
    const cash = getCash(market);
    const summary = await getPortfolioSummary(market).catch(() => null);
    logCycle({
      market, engine: "rule", riskOff: false, marketOpen: false, screened: [],
      decisions: 0, executed: 0,
      totalValueJpy: summary?.totalValueJpy ?? cash, cashJpy: cash,
      note: `休場: ${status.reason}`,
    });
    return { market, ranAt, marketOpen: false, riskOff: false, decisions: 0, executed: 0, trades, note: status.reason };
  }

  const riskOff = await isRiskOff(cfg.bench);

  // 1) リスク管理: 保有の損切り/利確（毎サイクル）
  const summary = await getPortfolioSummary(market);
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
    if (r.ok) { executedCount++; if (reason.startsWith("自動損切り")) setCooldown(market, h.ticker, cfg.tz); }
    trades.push(r);
    logDecision({
      market, ticker: h.ticker, action: "SELL", shares: h.shares, executed: r.ok,
      rejectReason: r.ok ? null : r.message, reasoning: reason,
      priceJpy: h.currentPriceJpy, pnlPct: h.unrealizedPnlPct,
    });
  }

  // 2) 新規BUY: 1営業日に1度だけ
  const today = dayKey(cfg.tz);
  const lastBuyKey = `last_buy_${market}`;
  let screened: string[] = [];
  if (getSetting(lastBuyKey) !== today) {
    setSetting(lastBuyKey, today);
    await runScreener(market, true).catch(() => {});
    screened = getScreenedTickers(market).slice(0, TOP_N);
    if (screened.length > 0) {
      const cash = getCash(market);
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
        const dayRet = ((lastClose - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
        const maxBuyShares = Math.max(0, Math.floor(limits.maxPositionJpy / q.priceJpy));
        candidates.push({
          ticker: t, lastClose: q.price, sma20, sma50, rsi14, momPct,
          maxBuyShares, heldShares: 0, avgCost: null,
          newsTitles: (news[t] ?? []).map((n) => n.title),
        });
        ctxByTicker.set(t, { rsi14, sma20, sma50, momPct, dayRet, priceJpy: q.priceJpy });
      }

      const decisions = ruleDecide(candidates, {
        cash, minCash: limits.minCashJpy, params: TUNED_PARAMS,
        inCooldown: makeInCooldown(market, cfg.tz),
      });
      for (const d of decisions) {
        if (d.action !== "BUY" || d.shares <= 0) continue;
        decisionCount++;
        const ctx = ctxByTicker.get(d.ticker);
        if (riskOff) {
          logDecision({
            market, ticker: d.ticker, action: "BUY", shares: d.shares, executed: false,
            rejectReason: `リスクオフ(${cfg.bench}<SMA20)`, reasoning: d.reasoning,
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
          market, ticker: d.ticker, action: "BUY", shares: d.shares, executed: r.ok,
          rejectReason: r.ok ? null : r.message, reasoning: d.reasoning,
          priceJpy: ctx?.priceJpy, rsi14: ctx?.rsi14, sma20: ctx?.sma20, sma50: ctx?.sma50, momPct: ctx?.momPct, dayRet: ctx?.dayRet,
        });
      }
    }
  }

  // 3) スナップショット記録（ベンチマーク込み）
  const finalSummary = await getPortfolioSummary(market).catch(() => null);
  const finalCash = getCash(market);
  const totalValue = finalSummary?.totalValueJpy ?? finalCash;
  const bench = await benchmarkValueJpy(market, cfg.bench);
  recordEquitySnapshot(market, totalValue, finalCash, bench);

  logCycle({
    market, engine: "rule", riskOff, marketOpen: true, screened,
    decisions: decisionCount, executed: executedCount,
    totalValueJpy: totalValue, cashJpy: finalCash,
    note: riskOff ? "リスクオフ(新規BUY停止)" : undefined,
  });

  return {
    market, ranAt, marketOpen: true, riskOff,
    decisions: decisionCount, executed: executedCount, trades,
    note: `${decisionCount}判断 / ${executedCount}約定${riskOff ? " / リスクオフ" : ""}`,
  };
}

/** 両市場のサイクルを順に実行（各市場は開場時のみ売買、休場は記録のみ）。 */
export async function runAllMarkets(): Promise<RuleCycleResult[]> {
  const results: RuleCycleResult[] = [];
  for (const market of ["US", "JP"] as Market[]) {
    results.push(await runRuleTradeCycle(market));
  }
  return results;
}
