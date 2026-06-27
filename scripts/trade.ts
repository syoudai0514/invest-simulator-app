/**
 * GitHub Actions / standalone 実行用トレードスクリプト
 * npm run trade で呼び出される。
 *
 * 本番は検証済みの決定論ルールエンジン（lib/rule-trade）で動かす。GROQ不要。
 * （旧LLM経路 lib/claude は実験・比較用に残置）
 */
import { runRuleTradeCycle } from "../lib/rule-trade";

async function main() {
  console.log(`[trade] 開始 ${new Date().toISOString()}`);

  const result = await runRuleTradeCycle();

  console.log(`[trade] 市場: ${result.marketOpen ? "開場" : "休場"} / レジーム: ${result.riskOff ? "リスクオフ(新規BUY停止)" : "通常"}`);
  console.log(`[trade] 判断数: ${result.decisions}`);
  for (const e of result.trades) {
    console.log(`  ${e.ok ? "✓" : "✗"} ${e.message}`);
  }
  console.log(`[trade] ${result.note}`);
  console.log(`[trade] 完了 ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("[trade] エラー:", err);
  process.exit(1);
});
