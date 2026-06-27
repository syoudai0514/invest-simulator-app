/**
 * GitHub Actions / standalone 実行用トレードスクリプト
 * npm run trade で呼び出される。
 *
 * 本番は検証済みの決定論ルールエンジン（lib/rule-trade）で米国・日本の両市場を動かす。
 * 各市場は自分の取引時間に開場している時だけ売買し、休場時は記録のみ。GROQ不要。
 */
import { runAllMarkets } from "../lib/rule-trade";

async function main() {
  console.log(`[trade] 開始 ${new Date().toISOString()}`);

  const results = await runAllMarkets();

  for (const r of results) {
    console.log(`\n[${r.market}] 市場: ${r.marketOpen ? "開場" : "休場"} / レジーム: ${r.riskOff ? "リスクオフ(新規BUY停止)" : "通常"}`);
    for (const e of r.trades) console.log(`  ${e.ok ? "✓" : "✗"} ${e.message}`);
    console.log(`  → ${r.note}`);
  }
  console.log(`\n[trade] 完了 ${new Date().toISOString()}`);
}

main().catch((err) => {
  console.error("[trade] エラー:", err);
  process.exit(1);
});
