/**
 * プロジェクト状態の検証スクリプト（混入対策）。
 *   node scripts/verify.mjs
 *
 * ツール出力に偽テキストが混入する事故があったため、主要ファイルの実在・
 * サイズ、tsc のエラー件数、git HEAD を「実際に」確認する。
 * セッション開始時・作業の節目で実行し、幻の進捗を防ぐ。
 *
 * 注意: 実行は PowerShell で
 *   $env:PATH = "C:\\Program Files\\nodejs;" + $env:PATH; node scripts/verify.mjs
 */
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";

// 実在を確認したい主要ファイル
const FILES = [
  "lib/backtest.ts",
  "lib/universe-jp.ts",
  "lib/universe.ts",
  "scripts/backtest.ts",
  "lib/trading.ts",
  "lib/claude.ts",
  "lib/news.ts",
  "lib/market.ts",
  "lib/screener.ts",
  "lib/indicators.ts",
  "lib/db.ts",
];

console.log("=== ファイル実在チェック ===");
let missing = 0;
for (const f of FILES) {
  if (existsSync(f)) {
    console.log(`  OK       ${f}  ${statSync(f).size}B`);
  } else {
    console.log(`  MISSING  ${f}`);
    missing++;
  }
}
console.log(missing === 0 ? "→ 全ファイル実在" : `→ ${missing}件が欠落！`);

console.log("\n=== tsc（型チェック）===");
try {
  execSync("npx tsc --noEmit", { stdio: "pipe" });
  console.log("  tsc: PASS（error 0件）");
} catch (e) {
  const out = (e.stdout?.toString() || "") + (e.stderr?.toString() || "");
  const errs = (out.match(/error TS/g) || []).length;
  console.log(`  tsc: FAIL（error ${errs}件）`);
  console.log(
    out
      .split("\n")
      .filter((l) => l.includes("error TS"))
      .slice(0, 10)
      .map((l) => "    " + l)
      .join("\n"),
  );
}

console.log("\n=== git HEAD ===");
try {
  const head = execSync('git log -1 --format="%h %s"', { stdio: "pipe" })
    .toString()
    .trim();
  console.log("  " + head);
  const dirty = execSync("git status --porcelain", { stdio: "pipe" })
    .toString()
    .trim()
    .split("\n")
    .filter((l) => l && !l.includes("sim.db")).length;
  console.log(`  未コミットの変更（sim.db除く）: ${dirty}件`);
} catch {
  console.log("  （git情報を取得できませんでした）");
}
