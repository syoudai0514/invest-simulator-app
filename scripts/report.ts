/**
 * 本番ライブ運用のフィードバックレポート（日次・週次）。
 *   npx tsx --env-file=.env.local scripts/report.ts [days]
 * 既定は過去7日。損益・対SPY・勝率・売買明細・却下理由・保有・レジーム稼働を集計。
 */
import { getDb, getSetting } from "../lib/db";
import { getPortfolioSummary } from "../lib/trading";

const days = Number(process.argv[2]) || 7;
const n = (x: number) => Math.round(x).toLocaleString();

async function main() {
  const db = getDb();
  const since = `datetime('now', '-${days} days')`;
  const initial = Number(getSetting("initial_cash") ?? "1000000");

  const summary = await getPortfolioSummary();
  const totalPnl = summary.totalValueJpy - initial;

  // ベンチマーク: 最新スナップショットの benchmark_value
  const snap = db.prepare(
    "SELECT total_value_jpy, benchmark_value_jpy, created_at FROM equity_snapshots ORDER BY id DESC LIMIT 1",
  ).get() as { total_value_jpy: number; benchmark_value_jpy: number | null; created_at: string } | undefined;
  const benchPnlPct = snap?.benchmark_value_jpy ? ((snap.benchmark_value_jpy - initial) / initial) * 100 : null;

  console.log(`===== ライブ運用レポート（過去${days}日） =====`);
  console.log(`初期資金   : ${n(initial)}円`);
  console.log(`現在総資産 : ${n(summary.totalValueJpy)}円（現金 ${n(summary.cashJpy)}）`);
  console.log(`トータル損益: ${n(totalPnl)}円（${summary.totalPnlPct.toFixed(2)}%）`);
  console.log(`ベンチSPY  : ${benchPnlPct === null ? "—" : benchPnlPct.toFixed(2) + "%"}` +
    (benchPnlPct !== null ? `（差 ${(summary.totalPnlPct - benchPnlPct >= 0 ? "+" : "") + (summary.totalPnlPct - benchPnlPct).toFixed(2)}pt）` : ""));

  // 期間内の確定売買・勝率
  const sells = db.prepare(
    `SELECT realized_pnl_jpy AS pnl FROM transactions WHERE action='SELL' AND created_at >= ${since}`,
  ).all() as { pnl: number | null }[];
  const realized = sells.reduce((s, x) => s + (x.pnl ?? 0), 0);
  const wins = sells.filter((x) => (x.pnl ?? 0) > 0).length;
  const losses = sells.filter((x) => (x.pnl ?? 0) < 0).length;
  const winRate = sells.length ? (wins / sells.length) * 100 : null;
  console.log(`\n--- 期間の確定売買 ---`);
  console.log(`確定 ${sells.length}回 / 勝率 ${winRate === null ? "—" : winRate.toFixed(0) + "%"}（${wins}勝${losses}敗）/ 確定損益 ${n(realized)}円`);

  // 取引明細
  const txs = db.prepare(
    `SELECT created_at, action, ticker, shares, price_jpy, realized_pnl_jpy, ai_reasoning
     FROM transactions WHERE created_at >= ${since} ORDER BY id`,
  ).all() as { created_at: string; action: string; ticker: string; shares: number; price_jpy: number; realized_pnl_jpy: number | null; ai_reasoning: string | null }[];
  console.log(`\n--- 取引明細（${txs.length}件） ---`);
  for (const t of txs) {
    const pnl = t.realized_pnl_jpy == null ? "" : ` 確定${n(t.realized_pnl_jpy)}`;
    console.log(`  [${t.created_at}] ${t.action} ${t.ticker} ${t.shares}@${n(t.price_jpy)}${pnl}  ${(t.ai_reasoning ?? "").slice(0, 50)}`);
  }

  // 却下理由の内訳
  const rejects = db.prepare(
    `SELECT reject_reason AS r, COUNT(*) AS c FROM decision_log
     WHERE executed=0 AND reject_reason IS NOT NULL AND ran_at >= ${since} GROUP BY reject_reason ORDER BY c DESC`,
  ).all() as { r: string; c: number }[];
  if (rejects.length) {
    console.log(`\n--- 却下理由の内訳 ---`);
    for (const r of rejects) console.log(`  ${r.r} × ${r.c}`);
  }

  // レジーム稼働状況
  const reg = db.prepare(
    `SELECT SUM(risk_off) AS off, COUNT(*) AS total FROM cycle_log WHERE market_open=1 AND ran_at >= ${since}`,
  ).get() as { off: number | null; total: number | null };
  if (reg.total) {
    console.log(`\n--- レジーム ---`);
    console.log(`開場サイクル ${reg.total} 回中 リスクオフ ${reg.off ?? 0} 回（新規BUY停止）`);
  }

  // 現在の保有
  console.log(`\n--- 現在の保有（${summary.holdings.length}銘柄） ---`);
  for (const h of summary.holdings) {
    console.log(`  ${h.ticker}: ${h.shares}株 平均${n(h.avgCostJpy)} → 現在${n(h.currentPriceJpy)} ／ 含み損益 ${h.unrealizedPnlPct >= 0 ? "+" : ""}${h.unrealizedPnlPct.toFixed(1)}%`);
  }
}

main().catch((e) => { console.error("[report] エラー:", (e as Error).message); process.exit(1); });
