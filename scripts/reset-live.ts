/**
 * 本番ライブ運用の初期化（月曜開始前に1回実行）。
 *   npx tsx --env-file=.env.local scripts/reset-live.ts
 * - 口座を初期100万円にリセット（保有・取引履歴・スナップショットを消去）
 * - ベンチマーク(SPY buy&hold)の基準株数を「100万円÷現在SPY円価」で記録
 * - ログ（decision_log/cycle_log）・クールダウン・BUY実行日をクリア
 */
import { getDb, setSetting } from "../lib/db";
import { resetAccount } from "../lib/trading";
import { getQuotes } from "../lib/yahoo";

const INITIAL = 1_000_000;

async function main() {
  const db = getDb();
  resetAccount(INITIAL);

  // ベンチマーク基準: 同額をSPYでbuy&holdした株数を記録
  let benchShares = 0;
  try {
    const [spy] = await getQuotes(["SPY"]);
    if (spy && spy.priceJpy > 0) benchShares = INITIAL / spy.priceJpy;
  } catch { /* 取得失敗時は0（ベンチ非表示） */ }
  setSetting("bench_spy_shares", String(benchShares));

  // ログ・状態のクリア
  db.exec("DELETE FROM decision_log; DELETE FROM cycle_log;");
  setSetting("cooldown", "{}");
  db.prepare("DELETE FROM settings WHERE key = 'last_buy_et_day'").run();

  console.log(`[reset-live] 口座を ${INITIAL.toLocaleString()}円 にリセット`);
  console.log(`[reset-live] ベンチSPY基準株数: ${benchShares.toFixed(4)}（≈100万円分）`);
  console.log(`[reset-live] decision_log / cycle_log / cooldown / last_buy_et_day をクリア`);
  console.log(`[reset-live] 完了。月曜の市場開場後、最初のサイクルから運用開始されます。`);
}

main().catch((e) => { console.error("[reset-live] エラー:", (e as Error).message); process.exit(1); });
