/**
 * 日足ベースのバックテスト（過去相場での検証）。
 *
 * 制約: この環境の yahoo-finance2 では日中(intraday)データが取得できないため
 * 粒度は日次。先読みバイアスを避けるため、各営業日の判断には「その日より前」の
 * データのみを使い、約定は当日始値、評価は当日終値で行う。ニュースは過去再現が
 * 不可能なため使わない（指標のみ）。
 *
 * 意思決定ログ(decisionLog): HOLDや却下された判断も含め全件を記録し、
 * 「なぜ動かなかったか」を後から検証できるようにする。
 */
import Groq from "groq-sdk";
import yahooFinance from "./yf";
import { summarize, sma } from "./indicators";
import {
  ruleDecide,
  DEFAULT_PARAMS,
  type Candidate,
  type RuleParams,
} from "./strategy";

export interface DailyBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BtTrade {
  date: string;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  fee: number;
  realizedPnl: number | null;
  reasoning: string;
}

/** 全判断の記録（実行・HOLD・却下すべて）。 */
export interface BtDecision {
  date: string;
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  reasoning: string;
  executed: boolean;
  rejectReason?: string; // 却下された場合の理由
}

export interface BtEquityPoint {
  date: string;
  total: number;
  cash: number;
}

export interface BacktestMetrics {
  realizedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnl: number;
  totalFee: number;
  maxDrawdownPct: number | null;
}

export interface DecisionSummary {
  buy: number;
  sell: number;
  hold: number;
  executed: number;
  rejected: number;
  rejectReasons: Record<string, number>;
}

export interface BacktestResult {
  market: "US" | "JP";
  currency: string;
  startDate: string;
  endDate: string;
  initialCash: number;
  finalValue: number;
  pnl: number;
  pnlPct: number;
  benchmarkPnlPct: number | null;
  benchmarkTicker: string;
  trades: BtTrade[];
  decisionLog: BtDecision[];
  decisionSummary: DecisionSummary;
  equity: BtEquityPoint[];
  metrics: BacktestMetrics;
  tradingDays: string[];
  note: string;
}

export interface BacktestConfig {
  market: "US" | "JP";
  currency: string;
  tickers: string[];
  benchmarkTicker: string;
  startDate: string;
  endDate: string;
  initialCash: number;
  topN?: number;
  useNews?: boolean; // 取得可能なニュースを併用する（過去日では部分的）
  strategy?: "llm" | "rule"; // 判断エンジン（既定: llm）
  params?: RuleParams; // rule戦略のチューニングパラメータ
}

const TRADE_COST_RATE = 0.0015;
// バックテストはトークン消費が大きいため、BT_MODEL で軽量モデルに切替可能。
const MODEL =
  process.env.BT_MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
// ニュースの鮮度窓（判断日からこの日数より古い見出しは使わない）。
const NEWS_FRESH_DAYS = 7;
const MAX_POSITION_PCT = Number(process.env.BT_MAXPOS_PCT) || 0.2;
const MIN_CASH_PCT = process.env.BT_MINCASH_PCT ? Number(process.env.BT_MINCASH_PCT) : 0.1;
const STOP_LOSS_PCT = process.env.BT_STOP ? Number(process.env.BT_STOP) : -8;
// 利確は10%が既定。複数期間検証で勝率が最も高く(約62%)、かつ全窓プラスを維持した水準。
const TAKE_PROFIT_PCT = process.env.BT_TP ? Number(process.env.BT_TP) : 10;
// トレーリングストップ（ピークからこの%下落で手仕舞い）。0なら無効。
const TRAIL_PCT = process.env.BT_TRAIL ? Number(process.env.BT_TRAIL) : 0;
// マーケット・レジームフィルタ: ベンチ(SPY)が自身のSMA20を下回る局面は新規BUYを停止。
// 複数期間(2024-2026の4半年窓)の検証で、全窓プラス・全窓SPY以上・最大DD半減と
// 最も頑健な改善だったため既定でON（BT_REGIME=0 で無効化可）。
const REGIME_ON = process.env.BT_REGIME !== "0";
const REGIME_SMA = Number(process.env.BT_REGIME_SMA) || 20;
// 「好材料急騰で売り→押し目で買い戻し」オーバーレイ。BT_SURGE_EXIT=0 で無効。
// 保有株が前日に +SURGE_EXIT% 急騰したら翌寄りで売り、売値から REBUY_DROP% 下げたら
// REBUY_DAYS 営業日以内に買い戻す（来なければ見送り）。
const SURGE_EXIT_PCT = process.env.BT_SURGE_EXIT ? Number(process.env.BT_SURGE_EXIT) : 0;
const REBUY_DROP_PCT = process.env.BT_REBUY_DROP ? Number(process.env.BT_REBUY_DROP) : 5;
const REBUY_DAYS = process.env.BT_REBUY_DAYS ? Number(process.env.BT_REBUY_DAYS) : 5;

interface AiDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  reasoning: string;
}

const DECISION_TOOL: Groq.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_decisions",
    description: "各銘柄に対する売買判断を提出する。",
    parameters: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              action: { type: "string", enum: ["BUY", "SELL", "HOLD"] },
              shares: { type: "number" },
              reasoning: { type: "string" },
            },
            required: ["ticker", "action", "shares", "reasoning"],
          },
        },
      },
      required: ["decisions"],
    },
  },
};

function isoDate(d: Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

async function getDailyBars(
  ticker: string,
  period1: Date,
  period2: Date,
): Promise<DailyBar[]> {
  const retries = 2;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const c = await yahooFinance.chart(ticker, {
        period1,
        period2,
        interval: "1d",
      });
      const quotes = (c.quotes ?? []) as {
        date: Date;
        open: number | null;
        high: number | null;
        low: number | null;
        close: number | null;
        volume: number | null;
      }[];
      return quotes
        .filter(
          (q) =>
            q.open != null && q.close != null && q.high != null && q.low != null,
        )
        .map((q) => ({
          date: new Date(q.date),
          open: q.open as number,
          high: q.high as number,
          low: q.low as number,
          close: q.close as number,
          volume: q.volume ?? 0,
        }));
    } catch {
      if (attempt < retries)
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return [];
}

function getClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY が未設定です。");
  return new Groq({ apiKey });
}

interface NewsItem {
  title: string;
  publisher: string;
  publishedAt: Date | null;
}

/**
 * 銘柄ごとのニュース見出しを取得（実行内で1度だけ・キャッシュ）。
 * 注意: yahoo-finance2 の search() は直近ニュースしか返さないため、過去日の
 * バックテストでは「判断日より前 かつ 鮮度窓内」の見出ししか残らない（＝部分的）。
 * 先読みバイアスを避けるため日付フィルタは day 側で行う。
 */
async function fetchNews(
  ticker: string,
  cache: Map<string, NewsItem[]>,
): Promise<NewsItem[]> {
  const hit = cache.get(ticker);
  if (hit) return hit;
  let items: NewsItem[] = [];
  try {
    const res = (await yahooFinance.search(ticker, {
      newsCount: 8,
      quotesCount: 0,
    })) as {
      news?: { title?: string; publisher?: string; providerPublishTime?: Date | string }[];
    };
    items = (res?.news ?? [])
      .filter((n) => n.title)
      .map((n) => ({
        title: n.title as string,
        publisher: n.publisher ?? "",
        publishedAt: n.providerPublishTime
          ? new Date(n.providerPublishTime)
          : null,
      }));
  } catch {
    items = [];
  }
  cache.set(ticker, items);
  return items;
}

/** 判断日より前・鮮度窓内のニュース見出しを最大3件返す。 */
function newsForDay(items: NewsItem[], dayDate: Date): NewsItem[] {
  const cutoffOld = new Date(
    dayDate.getTime() - NEWS_FRESH_DAYS * 24 * 60 * 60 * 1000,
  );
  return items
    .filter(
      (n) => n.publishedAt && n.publishedAt < dayDate && n.publishedAt >= cutoffOld,
    )
    .sort((a, b) => (b.publishedAt!.getTime() - a.publishedAt!.getTime()))
    .slice(0, 3);
}

function rsiLabel(rsi: number | null): string {
  if (rsi === null) return "—";
  if (rsi <= 30) return `${rsi.toFixed(0)}（売られすぎ）`;
  if (rsi >= 70) return `${rsi.toFixed(0)}（買われすぎ）`;
  return rsi.toFixed(0);
}

function trendLabel(
  price: number,
  sma20: number | null,
  sma50: number | null,
): string {
  if (sma20 === null || sma50 === null) return "—";
  if (sma20 > sma50 && price > sma20) return "上昇トレンド";
  if (sma20 < sma50 && price < sma20) return "下降トレンド";
  if (price > sma20) return "SMA20上抜け";
  if (price < sma20) return "SMA20下抜け";
  return "中立";
}

export async function runBacktest(
  config: BacktestConfig,
): Promise<BacktestResult> {
  const topN = config.topN ?? 12;
  const start = new Date(config.startDate + "T00:00:00Z");
  const end = new Date(config.endDate + "T23:59:59Z");
  const fetchFrom = new Date(start.getTime() - 90 * 24 * 60 * 60 * 1000);
  const fetchTo = new Date(end.getTime() + 2 * 24 * 60 * 60 * 1000);

  const allTickers = [...new Set([...config.tickers, config.benchmarkTicker])];
  const barsByTicker = new Map<string, DailyBar[]>();
  for (let i = 0; i < allTickers.length; i += 20) {
    const batch = allTickers.slice(i, i + 20);
    const results = await Promise.all(
      batch.map((t) => getDailyBars(t, fetchFrom, fetchTo)),
    );
    batch.forEach((t, j) => barsByTicker.set(t, results[j]));
    if (i + 20 < allTickers.length)
      await new Promise((r) => setTimeout(r, 300));
  }

  const benchBars = barsByTicker.get(config.benchmarkTicker) ?? [];
  const tradingDays = benchBars
    .map((b) => b.date)
    .filter((d) => d >= start && d <= end)
    .map(isoDate);

  if (tradingDays.length === 0)
    return emptyResult(config, "対象期間に取引日が見つかりませんでした。");

  const positions = new Map<string, { shares: number; avgCost: number }>();
  let cash = config.initialCash;
  const trades: BtTrade[] = [];
  const decisionLog: BtDecision[] = [];
  const equity: BtEquityPoint[] = [];
  const newsCache = new Map<string, NewsItem[]>();
  let newsHitDays = 0; // ニュースが1件以上付いた銘柄日数（カバレッジ確認用）
  const stoppedAtIdx = new Map<string, number>(); // 損切りした銘柄→その営業日インデックス
  const COOLDOWN_DAYS = 5; // 損切り後、再エントリーを禁止する営業日数
  const peakByTicker = new Map<string, number>(); // 保有中の最高値（トレーリング用）
  // 「好材料急騰で売り→押し目で買い戻し」の買い戻し待ち（ticker→売値・売却日・株数）
  const rebuyWatch = new Map<string, { sellOpen: number; idx: number; shares: number }>();
  let dayIdx = -1;

  for (const day of tradingDays) {
    dayIdx++;
    const dayDate = new Date(day + "T00:00:00Z");
    const todayBar = (t: string): DailyBar | null =>
      (barsByTicker.get(t) ?? []).find((b) => isoDate(b.date) === day) ?? null;

    // マーケット・レジーム判定（前日までのベンチがSMAを下回る＝リスクオフ）
    let riskOff = false;
    if (REGIME_ON) {
      const benchPast = benchBars.filter((b) => b.date < dayDate).map((b) => b.close);
      const benchSma = sma(benchPast, REGIME_SMA);
      const benchPrev = benchPast[benchPast.length - 1];
      riskOff = benchSma != null && benchPrev != null && benchPrev < benchSma;
    }

    // 1) リスク管理（損切り/利確/トレーリング）: 当日始値で評価・約定
    for (const [ticker, pos] of [...positions.entries()]) {
      const bar = todayBar(ticker);
      if (!bar) continue;
      const peak = Math.max(peakByTicker.get(ticker) ?? pos.avgCost, bar.open);
      peakByTicker.set(ticker, peak);
      const pnlPct = ((bar.open - pos.avgCost) / pos.avgCost) * 100;
      const fromPeakPct = ((bar.open - peak) / peak) * 100;
      // 前日の単日リターン（好材料急騰の代理シグナル）
      let surge = 0;
      if (SURGE_EXIT_PCT > 0) {
        const past = (barsByTicker.get(ticker) ?? []).filter((b) => b.date < dayDate);
        if (past.length >= 2) {
          const a = past[past.length - 1], b = past[past.length - 2];
          surge = ((a.close - b.close) / b.close) * 100;
        }
      }
      let reason = "";
      let isSurge = false;
      if (pnlPct <= STOP_LOSS_PCT) reason = `自動損切り(${pnlPct.toFixed(1)}%)`;
      else if (TRAIL_PCT > 0 && pnlPct > 0 && fromPeakPct <= -TRAIL_PCT)
        reason = `トレーリング手仕舞い(ピーク比${fromPeakPct.toFixed(1)}%)`;
      else if (SURGE_EXIT_PCT > 0 && surge >= SURGE_EXIT_PCT) {
        reason = `好材料急騰に売り(+${surge.toFixed(1)}%)`;
        isSurge = true;
      } else if (pnlPct >= TAKE_PROFIT_PCT) reason = `自動利確(${pnlPct.toFixed(1)}%)`;
      if (reason) {
        const soldShares = pos.shares;
        const r = sell(ticker, pos.shares, bar.open, day, reason);
        if (r.ok && reason.startsWith("自動損切り")) stoppedAtIdx.set(ticker, dayIdx);
        if (r.ok && isSurge) rebuyWatch.set(ticker, { sellOpen: bar.open, idx: dayIdx, shares: soldShares });
        decisionLog.push({
          date: day,
          ticker,
          action: "SELL",
          shares: pos.shares,
          reasoning: reason,
          executed: r.ok,
          rejectReason: r.ok ? undefined : r.reason,
        });
      }
    }

    // 2) スクリーニング（前日まで）
    // BT_SCREEN=mom: 20日リターン上位（モメンタムファクター）/ breakout: 上昇×出来高増
    // / 既定 vol: |前日変動率|×log(出来高)（急変動型）
    const screenMode = process.env.BT_SCREEN || "vol";
    const candidates: { ticker: string; score: number }[] = [];
    for (const t of config.tickers) {
      const bars = barsByTicker.get(t) ?? [];
      const past = bars.filter((b) => b.date < dayDate);
      if (past.length < 2) continue;
      const last = past[past.length - 1];
      const prev = past[past.length - 2];
      // 流動性フロア（ペニー株・薄商い除外）— 全モード共通
      if (last.close < 5 || last.close * last.volume < 5_000_000) continue;
      let score: number;
      if (screenMode === "mom") {
        // 20日リターン（上昇基調の強さ）
        const lb = Math.min(20, past.length - 1);
        const ago = past[past.length - 1 - lb].close;
        score = ((last.close - ago) / ago) * 100;
      } else if (screenMode === "breakout") {
        // 上昇かつ出来高増（ブレイクアウト候補）。下落・薄商いは弱める
        const lb = Math.min(20, past.length - 1);
        const ago = past[past.length - 1 - lb].close;
        const mom = ((last.close - ago) / ago) * 100;
        const volWin = past.slice(-21, -1);
        const avgVol = volWin.length ? volWin.reduce((s, b) => s + b.volume, 0) / volWin.length : last.volume;
        const volRatio = avgVol > 0 ? last.volume / avgVol : 1;
        score = mom > 0 ? mom * Math.min(volRatio, 3) : mom;
      } else {
        const changePct = ((last.close - prev.close) / prev.close) * 100;
        score = Math.abs(changePct) * Math.log10(Math.max(last.volume, 1));
      }
      candidates.push({ ticker: t, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const screened = candidates.slice(0, topN).map((c) => c.ticker);
    const targetTickers = [...new Set([...screened, ...positions.keys()])];

    // ポジション上限（1銘柄あたり）— AIに最大株数を提示するため先に算出
    const totalValue = evalTotal(day, todayBar);
    const limits = {
      maxPositionJpy: totalValue * MAX_POSITION_PCT,
      minCashJpy: totalValue * MIN_CASH_PCT,
    };

    // 1.5) 買い戻し処理（好材料急騰で売った銘柄が押し目を付けたら買い戻す）
    if (SURGE_EXIT_PCT > 0 && rebuyWatch.size > 0) {
      for (const [ticker, w] of [...rebuyWatch.entries()]) {
        if (dayIdx - w.idx > REBUY_DAYS) { rebuyWatch.delete(ticker); continue; } // 期限切れ
        const bar = todayBar(ticker);
        if (!bar) continue;
        const target = w.sellOpen * (1 - REBUY_DROP_PCT / 100);
        if (bar.open <= target) {
          const r = buy(ticker, w.shares, bar.open, day, `押し目買い戻し(売値${w.sellOpen.toFixed(2)}→${bar.open.toFixed(2)})`, limits);
          decisionLog.push({
            date: day, ticker, action: "BUY", shares: w.shares,
            reasoning: `押し目買い戻し`, executed: r.ok, rejectReason: r.ok ? undefined : r.reason,
          });
          rebuyWatch.delete(ticker);
        }
      }
    }

    // 3) 指標＋ニュースの構造化スナップショット
    const snapshots: Candidate[] = [];
    const contextLines: string[] = [];
    for (const t of targetTickers) {
      const bars = barsByTicker.get(t) ?? [];
      const past = bars.filter((b) => b.date < dayDate);
      if (past.length < 2) continue;
      const closes = past.map((b) => b.close);
      const { sma20, sma50, rsi14 } = summarize(closes);
      const lastClose = closes[closes.length - 1];
      const lookback = Math.min(20, closes.length - 1);
      const monthAgo = closes[closes.length - 1 - lookback];
      const momPct = ((lastClose - monthAgo) / monthAgo) * 100;
      // 前日の単日リターンと出来高比（キャピチュレーション判定用）
      const prevClose2 = closes.length >= 2 ? closes[closes.length - 2] : lastClose;
      const dayRet = prevClose2 ? ((lastClose - prevClose2) / prevClose2) * 100 : 0;
      const volWindow = past.slice(-21, -1);
      const avgVol = volWindow.length ? volWindow.reduce((s, b) => s + b.volume, 0) / volWindow.length : 0;
      const volRatio = avgVol > 0 ? past[past.length - 1].volume / avgVol : 0;
      const held = positions.get(t);
      const heldText = held
        ? ` [保有${held.shares}株 平均${held.avgCost.toFixed(2)}]`
        : "";
      // 前日終値ベースの最大購入可能株数（20%枠）。過大注文を防ぐ。
      const maxBuyShares = Math.max(
        0,
        Math.floor(limits.maxPositionJpy / lastClose),
      );
      let newsTitles: string[] = [];
      let newsText = "";
      if (config.useNews) {
        const items = newsForDay(await fetchNews(t, newsCache), dayDate);
        if (items.length > 0) {
          newsHitDays++;
          newsTitles = items.map((n) => n.title);
          newsText =
            "\n    ニュース: " +
            items.map((n) => `「${n.title}」(${n.publisher})`).join(" / ");
        } else {
          newsText = "\n    ニュース: （該当期間の見出しなし）";
        }
      }
      snapshots.push({
        ticker: t,
        lastClose,
        sma20,
        sma50,
        rsi14,
        momPct,
        maxBuyShares,
        heldShares: held?.shares ?? 0,
        avgCost: held?.avgCost ?? null,
        newsTitles,
        dayRet,
        volRatio,
      });
      contextLines.push(
        `- ${t} 前日終値 ${lastClose.toFixed(2)} | RSI14 ${rsiLabel(rsi14)} | ` +
          `SMA20 ${sma20?.toFixed(2) ?? "—"} SMA50 ${sma50?.toFixed(2) ?? "—"} | ` +
          `判定 ${trendLabel(lastClose, sma20, sma50)} | 20日 ${momPct.toFixed(1)}% | ` +
          `最大購入 ${maxBuyShares}株${heldText}${newsText}`,
      );
    }
    if (snapshots.length === 0) {
      equity.push({ date: day, total: evalTotal(day, todayBar), cash });
      continue;
    }

    // 4) 判断（rule: 決定論エンジン / llm: GROQ）
    let decisions: AiDecision[] = [];
    if ((config.strategy ?? "llm") === "rule") {
      decisions = ruleDecide(snapshots, {
        cash,
        minCash: limits.minCashJpy,
        params: config.params ?? DEFAULT_PARAMS,
        inCooldown: (t) => {
          const idx = stoppedAtIdx.get(t);
          return idx !== undefined && dayIdx - idx < COOLDOWN_DAYS;
        },
      });
    } else {
      const holdingsText =
        positions.size > 0
          ? [...positions.entries()]
              .map(([t, p]) => `- ${t}: ${p.shares}株（平均${p.avgCost.toFixed(2)}）`)
              .join("\n")
          : "（保有なし）";
      try {
        decisions = await askAi({
          currency: config.currency,
          cash,
          totalValue,
          holdingsText,
          contextText: contextLines.join("\n"),
          useNews: !!config.useNews,
        });
      } catch (e) {
        console.error(`[backtest] ${day} AI判断失敗:`, (e as Error).message);
      }
    }

    // 5) 約定（当日始値）＋ 全判断を記録
    for (const d of decisions) {
      const bar = todayBar(d.ticker);
      // リスクオフ局面（SPYがSMA割れ）では新規BUYを停止。保有の手仕舞いSELLは通す。
      if (d.action === "BUY" && riskOff) {
        decisionLog.push({
          date: day,
          ticker: d.ticker,
          action: d.action,
          shares: d.shares,
          reasoning: d.reasoning,
          executed: false,
          rejectReason: "リスクオフ(SPY<SMA)",
        });
        continue;
      }
      if (d.action === "HOLD" || d.shares <= 0) {
        decisionLog.push({
          date: day,
          ticker: d.ticker,
          action: d.action,
          shares: d.shares,
          reasoning: d.reasoning,
          executed: false,
          rejectReason: d.action === "HOLD" ? undefined : "数量0",
        });
        continue;
      }
      if (!bar) {
        decisionLog.push({
          date: day,
          ticker: d.ticker,
          action: d.action,
          shares: d.shares,
          reasoning: d.reasoning,
          executed: false,
          rejectReason: "当日バーなし",
        });
        continue;
      }
      const r =
        d.action === "BUY"
          ? buy(d.ticker, d.shares, bar.open, day, d.reasoning, limits)
          : sell(d.ticker, d.shares, bar.open, day, d.reasoning);
      decisionLog.push({
        date: day,
        ticker: d.ticker,
        action: d.action,
        shares: d.shares,
        reasoning:
          r.ok && r.clampedFrom
            ? `${d.reasoning}（株数を${r.clampedFrom}→上限内に調整）`
            : d.reasoning,
        executed: r.ok,
        rejectReason: r.ok ? undefined : r.reason,
      });
    }

    equity.push({ date: day, total: evalTotal(day, todayBar), cash });
  }

  const lastDay = tradingDays[tradingDays.length - 1];
  const lastBar = (t: string): DailyBar | null =>
    (barsByTicker.get(t) ?? []).find((b) => isoDate(b.date) === lastDay) ?? null;
  const finalValue = evalTotalClose(lastBar);
  const pnl = finalValue - config.initialCash;
  const pnlPct = (pnl / config.initialCash) * 100;

  let benchmarkPnlPct: number | null = null;
  const firstBenchBar = benchBars.find((b) => isoDate(b.date) === tradingDays[0]);
  const lastBenchBar = benchBars.find((b) => isoDate(b.date) === lastDay);
  if (firstBenchBar && lastBenchBar)
    benchmarkPnlPct =
      ((lastBenchBar.close - firstBenchBar.open) / firstBenchBar.open) * 100;

  return {
    market: config.market,
    currency: config.currency,
    startDate: config.startDate,
    endDate: config.endDate,
    initialCash: config.initialCash,
    finalValue,
    pnl,
    pnlPct,
    benchmarkPnlPct,
    benchmarkTicker: config.benchmarkTicker,
    trades,
    decisionLog,
    decisionSummary: summarizeDecisions(decisionLog),
    equity,
    metrics: computeMetrics(trades, equity),
    tradingDays,
    note:
      `戦略=${config.strategy ?? "llm"}・日次・約定は当日始値・先読み回避（判断は前日まで）` +
      (config.useNews
        ? `／指標＋取得可能ニュース併用（判断日より前かつ${NEWS_FRESH_DAYS}日以内の見出しのみ・銘柄日カバレッジ${newsHitDays}件）`
        : "／指標のみ（ニュース不使用）"),
  };

  // ---- クロージャ: ポートフォリオ操作 ----
  function buy(
    ticker: string,
    shares: number,
    price: number,
    day: string,
    reasoning: string,
    limits: { maxPositionJpy: number; minCashJpy: number },
  ): { ok: boolean; reason?: string; clampedFrom?: number } {
    // AIは株価を無視した固定株数を出しがちなので、ここで上限・現金・現金下限に
    // 収まる最大株数までクランプする（従来は超過＝全却下で一度も約定しなかった）。
    const unit = price * (1 + TRADE_COST_RATE); // 1株あたりの実質流出額
    const existingValue = (positions.get(ticker)?.shares ?? 0) * price;
    const roomByPosition = (limits.maxPositionJpy - existingValue) / price;
    const roomByCash = cash / unit;
    const roomByMinCash = (cash - limits.minCashJpy) / unit;
    const maxShares = Math.floor(
      Math.min(shares, roomByPosition, roomByCash, roomByMinCash),
    );
    if (maxShares < 1) {
      if (roomByPosition < 1) return { ok: false, reason: "20%上限で0株" };
      return { ok: false, reason: "資金不足で0株" };
    }
    const clampedFrom = maxShares < shares ? shares : undefined;
    shares = maxShares;
    const cost = price * shares;
    const fee = cost * TRADE_COST_RATE;
    const outflow = cost + fee;
    const unitCost = price * (1 + TRADE_COST_RATE); // 買い手数料込みの取得原価
    const existing = positions.get(ticker);
    if (existing) {
      const newShares = existing.shares + shares;
      existing.avgCost =
        (existing.avgCost * existing.shares + unitCost * shares) / newShares;
      existing.shares = newShares;
    } else {
      positions.set(ticker, { shares, avgCost: unitCost });
    }
    cash -= outflow;
    trades.push({
      date: day,
      ticker,
      action: "BUY",
      shares,
      price,
      fee,
      realizedPnl: null,
      reasoning,
    });
    return { ok: true, clampedFrom };
  }

  function sell(
    ticker: string,
    shares: number,
    price: number,
    day: string,
    reasoning: string,
  ): { ok: boolean; reason?: string; clampedFrom?: number } {
    const pos = positions.get(ticker);
    if (!pos || pos.shares < shares)
      return { ok: false, reason: "保有不足" };
    const fee = price * shares * TRADE_COST_RATE;
    const proceeds = price * shares - fee;
    const realizedPnl = (price - pos.avgCost) * shares - fee;
    cash += proceeds;
    pos.shares -= shares;
    if (pos.shares <= 0) {
      positions.delete(ticker);
      peakByTicker.delete(ticker);
    }
    trades.push({
      date: day,
      ticker,
      action: "SELL",
      shares,
      price,
      fee,
      realizedPnl,
      reasoning,
    });
    return { ok: true };
  }

  function evalTotal(day: string, barOf: (t: string) => DailyBar | null): number {
    let v = cash;
    for (const [t, p] of positions) {
      const bar = barOf(t);
      v += (bar?.open ?? p.avgCost) * p.shares;
    }
    return v;
  }

  function evalTotalClose(barOf: (t: string) => DailyBar | null): number {
    let v = cash;
    for (const [t, p] of positions) {
      const bar = barOf(t);
      v += (bar?.close ?? p.avgCost) * p.shares;
    }
    return v;
  }
}

/** GROQの429（レート制限）を指数バックオフでリトライする。 */
async function withRetry<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number; message?: string };
      if (err.status !== 429 || attempt >= retries) throw e;
      // メッセージ内の "try again in Xs" を尊重、無ければ指数バックオフ
      const m = /try again in ([\d.]+)s/.exec(err.message ?? "");
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 2000 * 2 ** attempt;
      console.warn(`[backtest] 429 レート制限 — ${waitMs}ms 待機して再試行 (${attempt + 1}/${retries})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function askAi(input: {
  currency: string;
  cash: number;
  totalValue: number;
  holdingsText: string;
  contextText: string;
  useNews: boolean;
}): Promise<AiDecision[]> {
  const client = getClient();
  const newsIntro = input.useNews
    ? "テクニカル指標と、取得できた直近ニュース見出しをもとに"
    : "テクニカル指標のみをもとに";
  const newsRule = input.useNews
    ? "- ニュースに好材料（好決算・新製品・提携・格上げ等）があればBUY方向、悪材料（業績悪化・訴訟・格下げ・調査等）があればSELL方向に補正。指標とニュースが一致したら確信度を上げ、矛盾すればHOLD寄りに。見出しが無い銘柄は指標のみで判断。\n"
    : "";
  const response = await withRetry(() =>
    client.chat.completions.create({
    model: MODEL,
    max_tokens: 1500,
    tools: [DECISION_TOOL],
    tool_choice: { type: "function", function: { name: "submit_decisions" } },
    messages: [
      {
        role: "user",
        content: `あなたは仮想資金で運用するスウィングトレーダーです（数日〜数週間の保有を想定）。${newsIntro}各銘柄の売買判断を行ってください。

# 現在の状況（通貨: ${input.currency}）
- 利用可能な現金: ${Math.round(input.cash).toLocaleString()}
- 総資産評価額: ${Math.round(input.totalValue).toLocaleString()}

# 現在の保有銘柄
${input.holdingsText}

# 注目銘柄と指標（前日終値時点）
${input.contextText}

# 判断ルール
- RSI14 ≤ 30（売られすぎ）: 反発狙いのBUY候補。
- RSI14 ≥ 70（買われすぎ）: 利確・反落狙いのSELL候補。
- 上昇トレンドかつRSIが極端でない: 順張りBUYを積極的に検討（現金を遊ばせない）。
- 下降トレンド: 保有していればSELL検討、新規BUYは避ける。
- 売られすぎRSIでも20日モメンタムが大きくマイナス（概ね−12%以下）の急落中銘柄は“落ちるナイフ”。新規BUYしない。
- 極端な低位株（概ね$10未満）は値動きが荒く避ける。
${newsRule}
# 指示
- 短期の値動きを狙ってください。明確な上昇シグナルがあれば現金を遊ばせず買ってください。
- 【重要】BUYの株数は各銘柄に示した「最大購入N株」を絶対に超えないこと。超えると注文が縮小・却下されます。複数銘柄を買う場合は現金配分も考慮し、現実的な株数を出してください。
- 総資産の10%は現金として残す。売買には片道0.15%のコストがかかる点を考慮（薄い値幅の回転は避ける）。
- 各 BUY/SELL の reasoning に根拠の指標${input.useNews ? "・ニュース" : ""}を必ず記載。
- 根拠が薄ければHOLD。
- 必ず submit_decisions ツールで提出。`,
      },
    ],
    }),
  );
  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return [];
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as {
      decisions?: AiDecision[];
    };
    return parsed.decisions ?? [];
  } catch {
    return [];
  }
}

function summarizeDecisions(log: BtDecision[]): DecisionSummary {
  const s: DecisionSummary = {
    buy: 0,
    sell: 0,
    hold: 0,
    executed: 0,
    rejected: 0,
    rejectReasons: {},
  };
  for (const d of log) {
    if (d.action === "BUY") s.buy++;
    else if (d.action === "SELL") s.sell++;
    else s.hold++;
    if (d.executed) s.executed++;
    else if (d.rejectReason) {
      s.rejected++;
      s.rejectReasons[d.rejectReason] =
        (s.rejectReasons[d.rejectReason] ?? 0) + 1;
    }
  }
  return s;
}

function computeMetrics(
  trades: BtTrade[],
  equity: BtEquityPoint[],
): BacktestMetrics {
  let wins = 0;
  let losses = 0;
  let realizedTrades = 0;
  let realizedPnl = 0;
  let totalFee = 0;
  for (const t of trades) {
    totalFee += t.fee;
    if (t.action === "SELL") {
      realizedTrades++;
      const pnl = t.realizedPnl ?? 0;
      realizedPnl += pnl;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }
  }
  let maxDd: number | null = null;
  if (equity.length >= 2) {
    let peak = equity[0].total;
    maxDd = 0;
    for (const e of equity) {
      if (e.total > peak) peak = e.total;
      if (peak > 0) {
        const dd = ((e.total - peak) / peak) * 100;
        if (dd < (maxDd as number)) maxDd = dd;
      }
    }
  }
  return {
    realizedTrades,
    wins,
    losses,
    winRate: realizedTrades > 0 ? (wins / realizedTrades) * 100 : null,
    realizedPnl,
    totalFee,
    maxDrawdownPct: maxDd,
  };
}

function emptyResult(config: BacktestConfig, note: string): BacktestResult {
  return {
    market: config.market,
    currency: config.currency,
    startDate: config.startDate,
    endDate: config.endDate,
    initialCash: config.initialCash,
    finalValue: config.initialCash,
    pnl: 0,
    pnlPct: 0,
    benchmarkPnlPct: null,
    benchmarkTicker: config.benchmarkTicker,
    trades: [],
    decisionLog: [],
    decisionSummary: {
      buy: 0,
      sell: 0,
      hold: 0,
      executed: 0,
      rejected: 0,
      rejectReasons: {},
    },
    equity: [],
    metrics: {
      realizedTrades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      realizedPnl: 0,
      totalFee: 0,
      maxDrawdownPct: null,
    },
    tradingDays: [],
    note,
  };
}
