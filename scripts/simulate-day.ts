/**
 * 「1ヶ月前の米国市場でアプリを1日動かす」検証ハーネス。
 *
 * 本番フロー（screener→指標→ニュース→AI判断→約定→評価）を、対象日の過去データに
 * 差し替えて1サイクルだけ回す。GROQの代わりに Claude が判断する2段階構成:
 *
 *   1) build : npx tsx --env-file=.env.local scripts/simulate-day.ts build 2026-05-27
 *      → 本番sim.dbを初期100万円にリセットし、対象日の市場文脈を出力（MD+JSON）。
 *        この文脈を Claude が読み、判断JSON（decisions）を作成する。
 *   2) execute : npx tsx scripts/simulate-day.ts execute 2026-05-27 <decisions.json>
 *      → 対象日の始値で約定（本番sim.dbに記録）、終値で評価して1日収支を表示。
 *
 * 前提: 日中データが無いため約定=当日始値・評価=当日終値の日足近似。先読み回避のため
 * 指標・スクリーニングは「対象日より前」のバーのみを使う。ニュースは取得できた分のみ。
 */
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import yahooFinance from "../lib/yf";
import { summarize } from "../lib/indicators";
import { getUsdJpyRate } from "../lib/currency";
import { getNewsForTickers } from "../lib/news";
import { UNIVERSE_TICKERS } from "../lib/universe";
import {
  resetAccount,
  executeBuy,
  executeSell,
  getCash,
  getHoldings,
  recordEquitySnapshot,
} from "../lib/trading";
import { setSetting } from "../lib/db";

const INITIAL_CASH = 1_000_000;
const TOP_N = 15;
const MAX_POSITION_PCT = 0.2;
const MIN_CASH_PCT = 0.1;
const NEWS_FRESH_DAYS = 7;
// スクリーニングのフロス除外（本番screener.tsと同基準）
const MIN_PRICE = 5; // 最低株価（ペニー株除外）
const MIN_DOLLAR_VOLUME = 5_000_000; // 最低売買代金（流動性）
const GAP_UP_MAX = 0.03; // 寄りが前日終値からこの率を超えて上ギャップしたBUYは見送る
const SCRATCH =
  process.env.SIMDAY_DIR ||
  "C:/Users/syoud/AppData/Local/Temp/claude/c--dev-invest-simulator-app/b03211e9-517d-47f9-b664-b6ade7900286/scratchpad";
const CTX_JSON = path.join(SCRATCH, "simday-context.json");
const CTX_MD = path.join(SCRATCH, "simday-context.md");
const DEC_DEFAULT = path.join(SCRATCH, "simday-decisions.json");

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Candidate {
  ticker: string;
  prevClose: number;
  open: number; // 対象日の始値（約定用）
  close: number; // 対象日の終値（評価用）
  rsi14: number | null;
  sma20: number | null;
  sma50: number | null;
  momPct: number;
  maxBuyShares: number;
  trend: string;
  news: string[];
}

interface ContextFile {
  targetDay: string;
  rate: number;
  initialCash: number;
  candidates: Candidate[];
}

async function getDailyBars(ticker: string, from: Date, to: Date): Promise<Bar[]> {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const c = await yahooFinance.chart(ticker, { period1: from, period2: to, interval: "1d" });
      const quotes = (c.quotes ?? []) as {
        date: Date; open: number | null; high: number | null; low: number | null; close: number | null; volume: number | null;
      }[];
      return quotes
        .filter((q) => q.open != null && q.close != null && q.high != null && q.low != null)
        .map((q) => ({
          date: new Date(q.date).toISOString().slice(0, 10),
          open: q.open as number, high: q.high as number, low: q.low as number,
          close: q.close as number, volume: q.volume ?? 0,
        }));
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  return [];
}

function rsiLabel(rsi: number | null): string {
  if (rsi === null) return "—";
  if (rsi <= 30) return `${rsi.toFixed(0)}（売られすぎ）`;
  if (rsi >= 70) return `${rsi.toFixed(0)}（買われすぎ）`;
  return rsi.toFixed(0);
}
function trendLabel(price: number, sma20: number | null, sma50: number | null): string {
  if (sma20 === null || sma50 === null) return "—";
  if (sma20 > sma50 && price > sma20) return "上昇トレンド";
  if (sma20 < sma50 && price < sma20) return "下降トレンド";
  if (price > sma20) return "SMA20上抜け";
  if (price < sma20) return "SMA20下抜け";
  return "中立";
}

async function build(targetDay: string) {
  const tickers = UNIVERSE_TICKERS.filter((t) => !t.endsWith(".T"));
  const limit = Number(process.env.SIMDAY_LIMIT) || tickers.length;
  const universe = tickers.slice(0, limit);
  const day = targetDay;
  const dayDate = new Date(day + "T00:00:00Z");
  const from = new Date(dayDate.getTime() - 90 * 24 * 60 * 60 * 1000);
  const to = new Date(dayDate.getTime() + 2 * 24 * 60 * 60 * 1000);

  console.log(`[simulate-day:build] 対象日=${day} ／ 米国ユニバース${universe.length}銘柄の日足を取得中...`);
  const barsByTicker = new Map<string, Bar[]>();
  for (let i = 0; i < universe.length; i += 20) {
    const batch = universe.slice(i, i + 20);
    const res = await Promise.all(batch.map((t) => getDailyBars(t, from, to)));
    batch.forEach((t, j) => barsByTicker.set(t, res[j]));
    if (i + 20 < universe.length) await new Promise((r) => setTimeout(r, 300));
  }

  // 対象日が実際に取引日か確認（SPYで判定）
  const spy = await getDailyBars("SPY", from, to);
  const isTradingDay = spy.some((b) => b.date === day);
  if (!isTradingDay) {
    console.error(`[simulate-day:build] ${day} は米国の取引日ではないようです（SPYにバーなし）。平日の取引日を指定してください。`);
    process.exit(1);
  }

  const rate = await getUsdJpyRate();
  console.log(`[simulate-day:build] USDJPY≈${rate.toFixed(2)} ／ 口座を初期${INITIAL_CASH.toLocaleString()}円にリセット`);
  resetAccount(INITIAL_CASH);

  // スクリーニング（対象日より前の終値で |騰落率|×log10(出来高)）
  const scored: { ticker: string; score: number }[] = [];
  for (const t of universe) {
    const bars = barsByTicker.get(t) ?? [];
    const past = bars.filter((b) => b.date < day);
    const todayBar = bars.find((b) => b.date === day);
    if (past.length < 2 || !todayBar) continue;
    const last = past[past.length - 1];
    const prev = past[past.length - 2];
    // 低位株・低流動性を除外（フロス排除・本番screenerと同基準）
    if (last.close < MIN_PRICE) continue;
    if (last.close * last.volume < MIN_DOLLAR_VOLUME) continue;
    const chg = ((last.close - prev.close) / prev.close) * 100;
    scored.push({ ticker: t, score: Math.abs(chg) * Math.log10(Math.max(last.volume, 1)) });
  }
  scored.sort((a, b) => b.score - a.score);
  const screened = scored.slice(0, TOP_N).map((s) => s.ticker);

  // ニュース（取得できた分のみ・対象日より前かつ7日以内）
  let newsByTicker: Record<string, { title: string; publishedAt: string }[]> = {};
  try {
    const raw = await getNewsForTickers(screened, true);
    const cutoffOld = new Date(dayDate.getTime() - NEWS_FRESH_DAYS * 24 * 60 * 60 * 1000);
    for (const t of screened) {
      newsByTicker[t] = (raw[t] ?? [])
        .filter((n) => n.publishedAt && new Date(n.publishedAt) < dayDate && new Date(n.publishedAt) >= cutoffOld)
        .slice(0, 3)
        .map((n) => ({ title: n.title, publishedAt: n.publishedAt }));
    }
  } catch (e) {
    console.warn("[simulate-day:build] ニュース取得に失敗（指標のみで継続）:", (e as Error).message);
  }

  const maxPositionJpy = INITIAL_CASH * MAX_POSITION_PCT;
  const candidates: Candidate[] = [];
  for (const t of screened) {
    const bars = barsByTicker.get(t) ?? [];
    const past = bars.filter((b) => b.date < day);
    const todayBar = bars.find((b) => b.date === day)!;
    const closes = past.map((b) => b.close);
    const { sma20, sma50, rsi14 } = summarize(closes);
    const prevClose = closes[closes.length - 1];
    const lookback = Math.min(20, closes.length - 1);
    const monthAgo = closes[closes.length - 1 - lookback];
    const momPct = ((prevClose - monthAgo) / monthAgo) * 100;
    const priceJpyPrev = prevClose * rate;
    candidates.push({
      ticker: t, prevClose, open: todayBar.open, close: todayBar.close,
      rsi14, sma20, sma50, momPct,
      maxBuyShares: Math.max(0, Math.floor(maxPositionJpy / priceJpyPrev)),
      trend: trendLabel(prevClose, sma20, sma50),
      news: (newsByTicker[t] ?? []).map((n) => n.title),
    });
  }

  const ctx: ContextFile = { targetDay: day, rate, initialCash: INITIAL_CASH, candidates };
  writeFileSync(CTX_JSON, JSON.stringify(ctx, null, 2), "utf8");

  // Claudeが読む市場文脈（本番 buildMarketContext と同じ体裁）
  const lines: string[] = [];
  lines.push(`# 米国市場シミュレーション文脈（対象日: ${day}）`);
  lines.push(``);
  lines.push(`## 口座状況`);
  lines.push(`- 利用可能な現金: ${INITIAL_CASH.toLocaleString()}円（初期化済み・保有なし）`);
  lines.push(`- USDJPYレート: ${rate.toFixed(2)}`);
  lines.push(`- 1銘柄あたり上限: 総資産の20%（=${maxPositionJpy.toLocaleString()}円）／ 現金は10%以上維持`);
  lines.push(``);
  lines.push(`## 本日の注目銘柄（前日終値時点の指標 ＋ 取得できたニュース）`);
  for (const c of candidates) {
    const newsText = c.news.length > 0 ? c.news.map((n) => `「${n}」`).join(" / ") : "（該当期間の見出しなし）";
    lines.push(
      `- ${c.ticker} 前日終値 $${c.prevClose.toFixed(2)}（≈${Math.round(c.prevClose * rate).toLocaleString()}円） | ` +
      `RSI14 ${rsiLabel(c.rsi14)} | SMA20 ${c.sma20?.toFixed(2) ?? "—"} SMA50 ${c.sma50?.toFixed(2) ?? "—"} | ` +
      `判定 ${c.trend} | 20日 ${c.momPct.toFixed(1)}% | 最大購入 ${c.maxBuyShares}株\n    ニュース: ${newsText}`,
    );
  }
  lines.push(``);
  lines.push(`## 判断ルール（本番プロンプトと同じ）`);
  lines.push(`- RSI≤30=反発BUY候補 / RSI≥70=SELL候補 / 上昇トレンド順張りBUY / 下降トレンドは新規回避`);
  lines.push(`- 落ちるナイフ回避: 売られすぎでも20日モメンタムが大きくマイナス(≈-12%以下)は買わない`);
  lines.push(`- 低位株($5未満)・低流動性はスクリーニング段階で除外済み / 好材料はBUY寄り・悪材料はSELL寄り`);
  lines.push(`- 寄りで前日終値から+3%超の上ギャップ銘柄は失速を掴みやすいので新規BUY見送り（execute時に自動で弾く）`);
  lines.push(`- 地合いが悪く良質な買い場が無い日は無理に買わず現金保持でよい`);
  lines.push(`- BUYは最大購入株数以内、現金10%維持、片道0.15%コスト考慮`);
  lines.push(``);
  lines.push(`## 出力形式（このJSONを ${DEC_DEFAULT} に保存）`);
  lines.push("```json");
  lines.push(`{ "decisions": [ { "ticker": "XXXX", "action": "BUY|SELL|HOLD", "shares": 0, "reasoning": "根拠" } ] }`);
  lines.push("```");
  writeFileSync(CTX_MD, lines.join("\n"), "utf8");

  console.log(`\n[simulate-day:build] 文脈を保存: ${CTX_MD}`);
  console.log(`[simulate-day:build] 価格コンテキスト: ${CTX_JSON}`);
  console.log(`\n===== 市場文脈（ここから Claude が判断） =====\n`);
  console.log(lines.join("\n"));
}

async function execute(targetDay: string, decisionsPath: string) {
  const ctx = JSON.parse(readFileSync(CTX_JSON, "utf8")) as ContextFile;
  if (ctx.targetDay !== targetDay) {
    console.error(`[simulate-day:execute] 対象日不一致（文脈=${ctx.targetDay} / 指定=${targetDay}）。先に build を実行してください。`);
    process.exit(1);
  }
  const decRaw = JSON.parse(readFileSync(decisionsPath, "utf8")) as {
    decisions: { ticker: string; action: "BUY" | "SELL" | "HOLD"; shares: number; reasoning?: string }[];
  };
  const byTicker = new Map(ctx.candidates.map((c) => [c.ticker, c]));
  const rate = ctx.rate;
  const limits = { maxPositionJpy: INITIAL_CASH * MAX_POSITION_PCT, minCashJpy: INITIAL_CASH * MIN_CASH_PCT };

  console.log(`\n[simulate-day:execute] 対象日=${targetDay} ／ 開始現金 ${getCash().toLocaleString()}円`);
  console.log(`--- 約定（当日始値で執行） ---`);
  for (const d of decRaw.decisions) {
    if (d.action === "HOLD" || d.shares <= 0) {
      console.log(`  HOLD ${d.ticker}: ${d.reasoning ?? ""}`);
      continue;
    }
    const c = byTicker.get(d.ticker.toUpperCase());
    if (!c) { console.log(`  ✗ ${d.ticker}: 文脈に価格なし（候補外）→ スキップ`); continue; }
    // 寄りで大きく上ギャップしたBUYは「ギャップ後の失速」を掴みやすいので見送る
    if (d.action === "BUY") {
      const gap = (c.open - c.prevClose) / c.prevClose;
      if (gap > GAP_UP_MAX) {
        console.log(`  ✗ BUY ${d.ticker}: 寄り+${(gap * 100).toFixed(1)}%の上ギャップ（>${(GAP_UP_MAX * 100).toFixed(0)}%）につき見送り`);
        continue;
      }
    }
    const ov = { price: c.open, priceJpy: c.open * rate, market: "US" };
    const r = d.action === "BUY"
      ? await executeBuy(d.ticker, d.shares, "AI", d.reasoning, limits, ov)
      : await executeSell(d.ticker, d.shares, "AI", d.reasoning, ov);
    console.log(`  ${r.ok ? "✓" : "✗"} ${d.action} ${d.ticker} (始値$${c.open.toFixed(2)}): ${r.message}`);
  }

  // 当日終値で評価
  const cash = getCash();
  const holdings = getHoldings();
  let holdingsClose = 0;
  console.log(`\n--- 当日終値での保有評価 ---`);
  for (const h of holdings) {
    const c = byTicker.get(h.ticker);
    const closeJpy = c ? c.close * rate : h.avgCostJpy;
    const value = closeJpy * h.shares;
    const cost = h.avgCostJpy * h.shares;
    const pnl = value - cost;
    holdingsClose += value;
    console.log(
      `  ${h.ticker}: ${h.shares}株 平均${Math.round(h.avgCostJpy).toLocaleString()}円 → 終値${Math.round(closeJpy).toLocaleString()}円 ` +
      `／ 含み損益 ${pnl >= 0 ? "+" : ""}${Math.round(pnl).toLocaleString()}円`,
    );
  }
  const total = cash + holdingsClose;
  const pnl = total - INITIAL_CASH;
  recordEquitySnapshot(total, cash);
  setSetting("initial_cash", String(INITIAL_CASH));

  console.log(`\n========== ${targetDay} の1日収支 ==========`);
  console.log(`開始: ${INITIAL_CASH.toLocaleString()}円`);
  console.log(`終了: ${Math.round(total).toLocaleString()}円（現金 ${Math.round(cash).toLocaleString()}円 ＋ 保有時価 ${Math.round(holdingsClose).toLocaleString()}円）`);
  console.log(`1日収支: ${pnl >= 0 ? "+" : ""}${Math.round(pnl).toLocaleString()}円（${((pnl / INITIAL_CASH) * 100).toFixed(2)}%）`);
  console.log(`\nブラウザ確認: npm run dev → http://localhost:3000`);
}

async function main() {
  const mode = process.argv[2];
  const targetDay = process.argv[3];
  if (!mode || !targetDay) {
    console.error("使い方: simulate-day.ts <build|execute> <YYYY-MM-DD> [decisions.json]");
    process.exit(1);
  }
  if (mode === "build") await build(targetDay);
  else if (mode === "execute") await execute(targetDay, process.argv[4] || DEC_DEFAULT);
  else { console.error(`不明なモード: ${mode}`); process.exit(1); }
}
main().catch((e) => { console.error("[simulate-day] エラー:", (e as Error).message); process.exit(1); });
