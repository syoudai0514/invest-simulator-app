/**
 * バックテスト実行スクリプト。
 *   npx tsx scripts/backtest.ts US 2026-06-23 2026-06-26
 *   npx tsx scripts/backtest.ts JP 2026-05-25 2026-05-29
 * 結果は標準出力＋ $TEMP/backtest_<market>_<start>.json に保存。
 * BT_LIMIT で対象銘柄数を調整可。
 */
import { writeFileSync } from "node:fs";
import { runBacktest, type BacktestConfig, type BacktestResult } from "../lib/backtest";
import { UNIVERSE_TICKERS } from "../lib/universe";
import { JP_TICKERS } from "../lib/universe-jp";
import { DEFAULT_PARAMS, TUNED_PARAMS } from "../lib/strategy";

const baseParams = process.env.BT_PARAMS === "default" ? DEFAULT_PARAMS : TUNED_PARAMS;
// 個別パラメータの env オーバーライド（チューニング用）
const params = {
  ...baseParams,
  ...(process.env.BT_MAXNEW ? { maxNewPositions: Number(process.env.BT_MAXNEW) } : {}),
  ...(process.env.BT_ALLOC ? { allocPctPerBuy: Number(process.env.BT_ALLOC) } : {}),
  ...(process.env.BT_MINSCORE ? { minScore: Number(process.env.BT_MINSCORE) } : {}),
  ...(process.env.BT_MOMCEIL ? { momCeiling: Number(process.env.BT_MOMCEIL) } : {}),
  ...(process.env.BT_RSISELL ? { rsiSell: Number(process.env.BT_RSISELL) } : {}),
  ...(process.env.BT_CAPIT ? { capitDrop: Number(process.env.BT_CAPIT) } : {}),
  ...(process.env.BT_CAPITBOOST ? { capitBoost: Number(process.env.BT_CAPITBOOST) } : {}),
  ...(process.env.BT_MINPRICE ? { minPrice: Number(process.env.BT_MINPRICE) } : {}),
};

// 量子・宇宙テーマ銘柄（BT_THEME=1 でコア120に追加）
const THEME_TICKERS = [
  "IONQ", "RGTI", "QUBT", "QBTS", "ARQQ", // 量子
  "RKLB", "ASTS", "MNTS", "ASTR", "SPCE", "RDW", "SATL", // 宇宙・衛星
];

const market = (process.argv[2] ?? "US") as "US" | "JP";
const startDate = process.argv[3] ?? "2026-06-23";
const endDate = process.argv[4] ?? "2026-06-26";

function buildConfig(): BacktestConfig {
  const limit = Number(process.env.BT_LIMIT) || 0;
  const strategy = (process.env.BT_STRATEGY ?? "rule") as "llm" | "rule";
  if (market === "JP") {
    const t = limit ? JP_TICKERS.slice(0, limit) : JP_TICKERS;
    return {
      market: "JP",
      currency: "JPY",
      tickers: t,
      // 日経225指数（分割等の不正プリントが無くレジーム信号・ベンチに適する）
      benchmarkTicker: process.env.BT_BENCH || "^N225",
      startDate,
      endDate,
      initialCash: 1_000_000,
      topN: 12,
      useNews: process.env.BT_NEWS !== "0",
      strategy,
      params,
    };
  }
  const us = UNIVERSE_TICKERS.filter((t) => !t.endsWith(".T"));
  const core = us.slice(0, limit || 120);
  const tickers = process.env.BT_THEME === "1"
    ? [...new Set([...core, ...THEME_TICKERS])]
    : core;
  return {
    market: "US",
    currency: "USD",
    tickers,
    benchmarkTicker: "SPY",
    startDate,
    endDate,
    initialCash: 10_000,
    topN: Number(process.env.BT_TOPN) || 12,
    useNews: process.env.BT_NEWS !== "0",
    strategy,
    params,
  };
}

function n(x: number): string {
  return Math.round(x).toLocaleString();
}

function printResult(r: BacktestResult) {
  console.log("\n========== バックテスト結果 ==========");
  console.log(`市場: ${r.market} (${r.currency}) / 期間: ${r.startDate}〜${r.endDate}`);
  console.log(`営業日: ${r.tradingDays.length}日 [${r.tradingDays.join(", ")}]`);
  console.log(`前提: ${r.note}`);
  console.log("");
  console.log(`初期資金     : ${n(r.initialCash)} ${r.currency}`);
  console.log(`最終評価額   : ${n(r.finalValue)} ${r.currency}`);
  console.log(`トータル損益 : ${n(r.pnl)} ${r.currency} (${r.pnlPct.toFixed(2)}%)`);
  console.log(
    `ベンチ(${r.benchmarkTicker}): ${r.benchmarkPnlPct === null ? "—" : r.benchmarkPnlPct.toFixed(2) + "%"}`,
  );
  if (r.benchmarkPnlPct !== null) {
    const d = r.pnlPct - r.benchmarkPnlPct;
    console.log(`  → 指数を ${d >= 0 ? "+" : ""}${d.toFixed(2)}pt ${d >= 0 ? "上回り" : "下回り"}`);
  }
  console.log("");
  console.log("--- 評価指標 ---");
  const m = r.metrics;
  console.log(`確定売買: ${m.realizedTrades}回 / 勝率: ${m.winRate === null ? "—" : m.winRate.toFixed(0) + "%"} (${m.wins}勝${m.losses}敗)`);
  console.log(`確定損益: ${n(m.realizedPnl)} / 取引コスト累計: ${n(m.totalFee)} / 最大DD: ${m.maxDrawdownPct === null ? "—" : m.maxDrawdownPct.toFixed(2) + "%"}`);
  console.log("");
  console.log("--- 意思決定サマリ（HOLD・却下も含む全判断） ---");
  const s = r.decisionSummary;
  console.log(`BUY判断 ${s.buy} / SELL判断 ${s.sell} / HOLD ${s.hold}`);
  console.log(`約定 ${s.executed} / 却下 ${s.rejected}`);
  const rr = Object.entries(s.rejectReasons);
  if (rr.length > 0) {
    console.log("却下理由内訳: " + rr.map(([k, v]) => `${k}×${v}`).join(", "));
  }
  console.log("");
  console.log(`--- 取引履歴 (${r.trades.length}件) ---`);
  for (const t of r.trades) {
    const pnl = t.realizedPnl === null ? "" : ` 確定${n(t.realizedPnl)}`;
    console.log(`  [${t.date}] ${t.action} ${t.ticker} ${t.shares}@${t.price.toFixed(2)}${pnl}  ${t.reasoning.slice(0, 60)}`);
  }
  console.log("");
  console.log("--- 日次資産推移 ---");
  for (const e of r.equity) console.log(`  ${e.date}: ${n(e.total)} (現金 ${n(e.cash)})`);
}

async function main() {
  const config = buildConfig();
  console.log(`[backtest] 開始: ${market} ${startDate}〜${endDate} 対象${config.tickers.length}銘柄`);
  const r = await runBacktest(config);
  printResult(r);
  const out = `${process.env.TEMP || "/tmp"}/backtest_${market}_${startDate}.json`;
  writeFileSync(out, JSON.stringify(r, null, 2), "utf8");
  console.log(`\n[backtest] JSON保存: ${out}`);
}

main().catch((e) => {
  const err = e as Error;
  writeFileSync(
    `${process.env.TEMP || "/tmp"}/backtest_error.json`,
    JSON.stringify({ message: err.message, stack: err.stack }, null, 2),
    "utf8",
  );
  console.error("[backtest] エラー（詳細は backtest_error.json）:", err.message);
  process.exit(1);
});
