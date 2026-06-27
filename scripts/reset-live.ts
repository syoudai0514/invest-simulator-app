/**
 * 本番ライブ運用の初期化（月曜開始前に1回実行）。
 *   npx tsx --env-file=.env.local scripts/reset-live.ts
 * - 米国・日本の各口座を初期100万円にリセット（保有・取引履歴・スナップショットを市場別に消去）
 * - ベンチマーク基準株数を「100万円÷現在指数(円価)」で記録（US=SPY, JP=^N225）
 * - ログ（decision_log/cycle_log）・クールダウン・BUY実行日をクリア
 */
import { getDb, setSetting } from "../lib/db";
import { resetAccount } from "../lib/trading";
import { getQuotes, type Market } from "../lib/yahoo";

const INITIAL = 1_000_000;
const BENCH: Record<Market, string> = { US: "SPY", JP: "^N225" };

async function main() {
  const db = getDb();
  for (const market of ["US", "JP"] as Market[]) {
    resetAccount(market, INITIAL);
    let benchShares = 0;
    try {
      const [q] = await getQuotes([BENCH[market]]);
      if (q && q.priceJpy > 0) benchShares = INITIAL / q.priceJpy;
    } catch { /* 取得失敗時は0（ベンチ非表示） */ }
    setSetting(`bench_shares_${market}`, String(benchShares));
    db.prepare("DELETE FROM settings WHERE key = ?").run(`last_buy_${market}`);
    setSetting(`cooldown_${market}`, "{}");
    console.log(`[reset-live] ${market}: 口座 ${INITIAL.toLocaleString()}円 / ベンチ${BENCH[market]}基準 ${benchShares.toFixed(4)}株`);
  }
  db.exec("DELETE FROM decision_log; DELETE FROM cycle_log;");
  console.log(`[reset-live] decision_log / cycle_log をクリア`);
  console.log(`[reset-live] 完了。各市場の開場後、最初のサイクルから運用開始されます。`);
}

main().catch((e) => { console.error("[reset-live] エラー:", (e as Error).message); process.exit(1); });
