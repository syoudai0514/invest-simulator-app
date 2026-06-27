/**
 * 本番ライブ運用のフィードバックレポート（日次・週次・市場別）。
 *   npx tsx --env-file=.env.local scripts/report.ts [days]
 * 既定は過去7日。米国・日本それぞれで損益・対指数・勝率・売買明細・却下理由・保有を集計。
 */
import { getDb, getSetting } from "../lib/db";
import { getPortfolioSummary, initialCashKey } from "../lib/trading";
import type { Market } from "../lib/yahoo";

const days = Number(process.argv[2]) || 7;
const n = (x: number) => Math.round(x).toLocaleString();
const BENCH: Record<Market, string> = { US: "SPY", JP: "N225" };

async function reportMarket(market: Market) {
  const db = getDb();
  const since = `datetime('now', '-${days} days')`;
  const initial = Number(getSetting(initialCashKey(market)) ?? "1000000");
  const summary = await getPortfolioSummary(market);
  const totalPnl = summary.totalValueJpy - initial;

  const snap = db.prepare(
    "SELECT benchmark_value_jpy FROM equity_snapshots WHERE market = ? ORDER BY id DESC LIMIT 1",
  ).get(market) as { benchmark_value_jpy: number | null } | undefined;
  const benchPnlPct = snap?.benchmark_value_jpy ? ((snap.benchmark_value_jpy - initial) / initial) * 100 : null;

  console.log(`\n========== ${market} 運用レポート（過去${days}日） ==========`);
  console.log(`初期 ${n(initial)}円 → 現在 ${n(summary.totalValueJpy)}円（現金 ${n(summary.cashJpy)}）`);
  console.log(`損益 ${n(totalPnl)}円（${summary.totalPnlPct.toFixed(2)}%）｜ ベンチ${BENCH[market]} ${benchPnlPct === null ? "—" : benchPnlPct.toFixed(2) + "%"}` +
    (benchPnlPct !== null ? `（差 ${(summary.totalPnlPct - benchPnlPct >= 0 ? "+" : "") + (summary.totalPnlPct - benchPnlPct).toFixed(2)}pt）` : ""));

  const sells = db.prepare(
    `SELECT realized_pnl_jpy AS pnl FROM transactions WHERE market = ? AND action='SELL' AND created_at >= ${since}`,
  ).all(market) as { pnl: number | null }[];
  const realized = sells.reduce((s, x) => s + (x.pnl ?? 0), 0);
  const wins = sells.filter((x) => (x.pnl ?? 0) > 0).length;
  const losses = sells.filter((x) => (x.pnl ?? 0) < 0).length;
  const winRate = sells.length ? (wins / sells.length) * 100 : null;
  console.log(`確定 ${sells.length}回 / 勝率 ${winRate === null ? "—" : winRate.toFixed(0) + "%"}（${wins}勝${losses}敗）/ 確定損益 ${n(realized)}円`);

  const txs = db.prepare(
    `SELECT created_at, action, ticker, shares, price_jpy, realized_pnl_jpy, ai_reasoning
     FROM transactions WHERE market = ? AND created_at >= ${since} ORDER BY id`,
  ).all(market) as { created_at: string; action: string; ticker: string; shares: number; price_jpy: number; realized_pnl_jpy: number | null; ai_reasoning: string | null }[];
  if (txs.length) {
    console.log(`--- 取引明細（${txs.length}件） ---`);
    for (const t of txs) {
      const pnl = t.realized_pnl_jpy == null ? "" : ` 確定${n(t.realized_pnl_jpy)}`;
      console.log(`  [${t.created_at}] ${t.action} ${t.ticker} ${t.shares}@${n(t.price_jpy)}${pnl}  ${(t.ai_reasoning ?? "").slice(0, 46)}`);
    }
  }

  const rejects = db.prepare(
    `SELECT reject_reason AS r, COUNT(*) AS c FROM decision_log
     WHERE market = ? AND executed=0 AND reject_reason IS NOT NULL AND ran_at >= ${since} GROUP BY reject_reason ORDER BY c DESC`,
  ).all(market) as { r: string; c: number }[];
  if (rejects.length) console.log(`却下理由: ` + rejects.map((r) => `${r.r}×${r.c}`).join(", "));

  const reg = db.prepare(
    `SELECT SUM(risk_off) AS off, COUNT(*) AS total FROM cycle_log WHERE market = ? AND market_open=1 AND ran_at >= ${since}`,
  ).get(market) as { off: number | null; total: number | null };
  if (reg.total) console.log(`レジーム: 開場${reg.total}回中リスクオフ${reg.off ?? 0}回（新規BUY停止）`);

  if (summary.holdings.length) {
    console.log(`--- 保有（${summary.holdings.length}） ---`);
    for (const h of summary.holdings) {
      console.log(`  ${h.ticker}: ${h.shares}株 平均${n(h.avgCostJpy)}→現在${n(h.currentPriceJpy)} ／ ${h.unrealizedPnlPct >= 0 ? "+" : ""}${h.unrealizedPnlPct.toFixed(1)}%`);
    }
  } else {
    console.log(`保有なし`);
  }
  return { totalValue: summary.totalValueJpy, initial };
}

async function main() {
  let totalNow = 0, totalInit = 0;
  for (const market of ["US", "JP"] as Market[]) {
    const r = await reportMarket(market);
    totalNow += r.totalValue; totalInit += r.initial;
  }
  console.log(`\n========== 合算 ==========`);
  console.log(`合計 ${n(totalInit)}円 → ${n(totalNow)}円（${(((totalNow - totalInit) / totalInit) * 100).toFixed(2)}%）`);
}

main().catch((e) => { console.error("[report] エラー:", (e as Error).message); process.exit(1); });
