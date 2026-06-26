/**
 * GitHub Actions / standalone 実行用トレードスクリプト
 * npm run trade で呼び出される
 */
import { runAiTradeCycle } from "../lib/claude";

async function main() {
  console.log(`[trade] 開始 ${new Date().toISOString()}`);

  const result = await runAiTradeCycle();

  console.log(`[trade] 判断数: ${result.decisions.length}`);
  for (const d of result.decisions) {
    console.log(`  ${d.ticker} → ${d.action} ${d.shares}株 | ${d.reasoning}`);
  }

  console.log(`[trade] 実行数: ${result.executed.length}`);
  for (const e of result.executed) {
    console.log(`  ${e.ok ? "✓" : "✗"} ${e.message}`);
  }

  console.log(`[trade] ${result.summaryNote}`);
  console.log(`[trade] 完了 ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("[trade] エラー:", err);
  process.exit(1);
});
