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
import { getQuotes, type Quote, type Market } from "./yahoo";
import yahooFinance from "./yf";
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
import { llmNewsSentiment } from "./news-llm";
import { getMarketStatus } from "./market";
import { getSetting, setSetting, logDecision, logCycle } from "./db";

const STOP_LOSS_PCT = -8;
const TAKE_PROFIT_PCT = 10;
// 緊急ストップ: 日次判定を待たずに即時手仕舞いする急落閾値（災害保険。通常は発火しない）
const DISASTER_STOP_PCT = -15;
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

/**
 * リスクオフ判定: ベンチ(指数)が短期SMA(20)または長期SMA(200)を下回る局面か。
 * - SMA20: 短期の下落で新規買いを一時停止（ヒゲ回避）
 * - SMA200: 長期下落（弱気相場）では新規買いを全停止（Meb Faber等の確立ルール）
 *
 * 【重要】バックテストと同じく「前日までの確定終値」だけで判定する。取引時間中の
 * 当日バー（動いている途中値）を含めると、寄りの瞬間的な上ヒゲでリスクオンに誤判定
 * → 買い→失速、のむち打ちが起きる（ライブ初週の米国6連敗の主因）。
 * SMA200算出のため日足を約400日分取得する。取得失敗時は false（通常運用）。
 */
async function isRiskOff(bench: string, tz: string): Promise<boolean> {
  try {
    const closes = await completedCloses(bench, tz, 400);
    if (closes.length < REGIME_SMA + 1) return false;
    const last = closes[closes.length - 1];
    const s20 = sma(closes, REGIME_SMA);
    const s200 = sma(closes, 200);
    if (s20 != null && last < s20) return true; // 短期下落
    if (s200 != null && last < s200) return true; // 長期下落（弱気相場）
    return false;
  } catch {
    return false;
  }
}

/**
 * 「当日の途中バー」を除いた確定日足の終値列を返す（古→新）。
 * バックテストの「判断は前日までのデータのみ」をライブでも厳密に再現するための共通関数。
 */
async function completedCloses(ticker: string, tz: string, days: number): Promise<number[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const c = (await yahooFinance.chart(ticker, { period1: from, period2: to, interval: "1d" })) as {
    quotes?: { date: Date; close: number | null }[];
  };
  const today = dayKey(tz);
  return (c.quotes ?? [])
    .filter((q) => q.close != null && dayKey(tz, new Date(q.date)) !== today)
    .map((q) => q.close as number);
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

  const riskOff = await isRiskOff(cfg.bench, cfg.tz);

  // 1) リスク管理: 損切り/利確の判定は「1営業日1回」（バックテストと同じ日次粒度）。
  //    5分ごとの判定は検証していない高回転を生み、寄り直後のノイズで刈られる実害が出たため
  //    （初週: 購入10分後に-8.8%損切り等）、日次に統一。ただし毎サイクル、-15%超の
  //    急落だけは緊急ストップとして即時手仕舞いする（日次判定より悪化を防ぐ保護のみ）。
  const summary = await getPortfolioSummary(market);
  const limits = {
    maxPositionJpy: summary.totalValueJpy * MAX_POSITION_PCT,
    minCashJpy: summary.totalValueJpy * MIN_CASH_PCT,
  };
  const today = dayKey(cfg.tz);
  const riskDayKey = `last_risk_${market}`;
  const isDailyRiskCheck = getSetting(riskDayKey) !== today;
  if (isDailyRiskCheck) setSetting(riskDayKey, today);
  for (const h of summary.holdings) {
    let reason = "";
    if (h.unrealizedPnlPct <= DISASTER_STOP_PCT)
      reason = `緊急ストップ(${h.unrealizedPnlPct.toFixed(1)}%)`;
    else if (isDailyRiskCheck && h.unrealizedPnlPct <= STOP_LOSS_PCT)
      reason = `自動損切り(${h.unrealizedPnlPct.toFixed(1)}%)`;
    else if (isDailyRiskCheck && h.unrealizedPnlPct >= TAKE_PROFIT_PCT)
      reason = `自動利確(${h.unrealizedPnlPct.toFixed(1)}%)`;
    if (!reason) continue;
    decisionCount++;
    const r = await executeSell(h.ticker, h.shares, "AI", reason).catch(
      (e) => ({ ok: false, message: (e as Error).message }) as TradeResult,
    );
    // クールダウンは損切り・利確どちらの手仕舞い後も適用（利確→翌日買い直し→損切りの
    // 往復チャーンを防ぐ。フルサイクル+3.1pt/OOS+4.5ptの改善を検証済み）。
    if (r.ok) { executedCount++; setCooldown(market, h.ticker, cfg.tz); }
    trades.push(r);
    logDecision({
      market, ticker: h.ticker, action: "SELL", shares: h.shares, executed: r.ok,
      rejectReason: r.ok ? null : r.message, reasoning: reason,
      priceJpy: h.currentPriceJpy, pnlPct: h.unrealizedPnlPct,
    });
  }

  // 2) 日次判断: スクリーニング＋保有銘柄を対象に ruleDecide（1営業日に1度だけ）。
  //    バックテスト同様、保有銘柄も実際の保有数で候補に含める。これにより
  //    「下降トレンド転換・RSI過熱・悪材料でのトレンド手仕舞い」が本番でも機能し、
  //    保有銘柄の誤った買い増しも防がれる（初週は heldShares=0 固定のバグで両方が死んでいた）。
  const lastBuyKey = `last_buy_${market}`;
  let screened: string[] = [];
  if (getSetting(lastBuyKey) !== today) {
    setSetting(lastBuyKey, today);
    await runScreener(market, true).catch(() => {});
    screened = getScreenedTickers(market).slice(0, TOP_N);
    const heldNow = getHoldings(market); // 直前の損切り/利確を反映した最新の保有
    const heldBy = new Map(heldNow.map((h) => [h.ticker, h]));
    const targets = [...new Set([...screened, ...heldNow.map((h) => h.ticker)])];
    if (targets.length > 0) {
      const cash = getCash(market);
      const quotes = await getQuotes(targets);
      const quoteMap = new Map<string, Quote>(quotes.map((q) => [q.ticker, q]));
      // force=true: 市場ごとに自分の銘柄のニュースを必ず取得する。
      // （getNewsForTickers の1日1回キャッシュは市場共通のため、US/JPが同JST日に動くと
      //  後の市場が先の市場のキャッシュを掴む不具合を回避）
      let news: Record<string, { title: string }[]> = {};
      try { news = await getNewsForTickers(targets, true); } catch { /* 指標のみで継続 */ }

      const candidates: Candidate[] = [];
      const ctxByTicker = new Map<string, { rsi14: number | null; sma20: number | null; sma50: number | null; momPct: number; dayRet: number; priceJpy: number }>();
      for (const t of targets) {
        const q = quoteMap.get(t);
        if (!q) continue;
        // 指標は「前日までの確定終値」で計算（当日の途中値を混ぜない＝バックテストと同条件）
        let closes: number[] = [];
        try { closes = await completedCloses(t, cfg.tz, 130); } catch { /* skip */ }
        if (closes.length < 2) continue;
        const { sma20, sma50, rsi14 } = summarize(closes);
        const lastClose = closes[closes.length - 1];
        const lookback = Math.min(20, closes.length - 1);
        const monthAgo = closes[closes.length - 1 - lookback];
        const momPct = ((lastClose - monthAgo) / monthAgo) * 100;
        const dayRet = ((lastClose - closes[closes.length - 2]) / closes[closes.length - 2]) * 100;
        const maxBuyShares = Math.max(0, Math.floor(limits.maxPositionJpy / q.priceJpy));
        const held = heldBy.get(t);
        candidates.push({
          ticker: t, lastClose, sma20, sma50, rsi14, momPct,
          maxBuyShares, heldShares: held?.shares ?? 0, avgCost: held?.avgCostJpy ?? null,
          newsTitles: (news[t] ?? []).map((n) => n.title),
        });
        ctxByTicker.set(t, { rsi14, sma20, sma50, momPct, dayRet, priceJpy: q.priceJpy });
      }

      // ニュースの読解はLLM(GROQ)に任せる。中核の指標・レジーム・執行はコードのまま。
      // 失敗時はキーワード方式（classifyNews）に自動フォールバック（newsSentiment未設定のまま）。
      try {
        const verdicts = await llmNewsSentiment(
          candidates.map((c) => ({ ticker: c.ticker, titles: c.newsTitles })),
        );
        for (const c of candidates) {
          const v = verdicts[c.ticker];
          if (v) { c.newsSentiment = v.score; c.newsReason = v.reason; }
        }
      } catch (e) {
        console.warn(`[rule-trade:${market}] ニュースLLM失敗→キーワード方式に切替: ${(e as Error).message}`);
      }

      const newsReasonBy = new Map(candidates.map((c) => [c.ticker, c.newsReason]));
      const decisions = ruleDecide(candidates, {
        cash, minCash: limits.minCashJpy, params: TUNED_PARAMS,
        inCooldown: makeInCooldown(market, cfg.tz),
      });
      for (const d of decisions) {
        // トレンド手仕舞い（下降トレンド転換・RSI過熱・悪材料）: バックテスト同様、
        // リスクオフ中でもSELLは常に実行する。手仕舞い後はクールダウン適用。
        if (d.action === "SELL" && d.shares > 0) {
          decisionCount++;
          const ctxS = ctxByTicker.get(d.ticker);
          const rS = await executeSell(d.ticker, d.shares, "AI", d.reasoning).catch(
            (e) => ({ ok: false, message: (e as Error).message }) as TradeResult,
          );
          if (rS.ok) { executedCount++; setCooldown(market, d.ticker, cfg.tz); }
          trades.push(rS);
          logDecision({
            market, ticker: d.ticker, action: "SELL", shares: d.shares, executed: rS.ok,
            rejectReason: rS.ok ? null : rS.message, reasoning: d.reasoning,
            priceJpy: ctxS?.priceJpy, rsi14: ctxS?.rsi14, sma20: ctxS?.sma20, sma50: ctxS?.sma50, momPct: ctxS?.momPct, dayRet: ctxS?.dayRet,
          });
          continue;
        }
        if (d.action !== "BUY" || d.shares <= 0) continue;
        decisionCount++;
        const ctx = ctxByTicker.get(d.ticker);
        const nr = newsReasonBy.get(d.ticker);
        const reasoning = nr && nr !== "ニュースなし" ? `${d.reasoning}／ニュース: ${nr}` : d.reasoning;
        if (riskOff) {
          logDecision({
            market, ticker: d.ticker, action: "BUY", shares: d.shares, executed: false,
            rejectReason: `リスクオフ(${cfg.bench}<SMA20)`, reasoning,
            priceJpy: ctx?.priceJpy, rsi14: ctx?.rsi14, sma20: ctx?.sma20, sma50: ctx?.sma50, momPct: ctx?.momPct, dayRet: ctx?.dayRet,
          });
          continue;
        }
        const r = await executeBuy(d.ticker, d.shares, "AI", reasoning, limits).catch(
          (e) => ({ ok: false, message: (e as Error).message }) as TradeResult,
        );
        if (r.ok) executedCount++;
        trades.push(r);
        logDecision({
          market, ticker: d.ticker, action: "BUY", shares: d.shares, executed: r.ok,
          rejectReason: r.ok ? null : r.message, reasoning,
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
