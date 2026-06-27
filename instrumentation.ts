/**
 * Next.js のサーバー起動時に1度だけ実行される。
 *
 * 本番の自動売買は GitHub Actions（npm run trade＝ルールエンジン）が担当する。
 * ローカルの `npm run dev` は原則「ダッシュボード閲覧専用」とし、二重稼働・トークン消費を防ぐ。
 * どうしてもローカルでも売買を回したい場合のみ ENABLE_LOCAL_TRADER=1 で有効化できる
 * （その場合も本番と同じルールエンジン runAllMarkets を使う）。
 */
export async function register() {
  // Node.js ランタイムでのみ（Edge では node:sqlite 等が使えない）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // 既定ではローカル自動売買は無効（本番＝GitHub Actions と二重稼働させない）
  if (process.env.ENABLE_LOCAL_TRADER !== "1") {
    console.log(
      "[auto-trade] ローカルの自動売買は無効です（本番は GitHub Actions が担当）。" +
        "ローカルでも回す場合は ENABLE_LOCAL_TRADER=1 を設定してください。",
    );
    return;
  }

  const cron = (await import("node-cron")).default;
  const { getSetting } = await import("./lib/db");
  const { runAllMarkets } = await import("./lib/rule-trade");

  let lastRun = 0;
  let running = false;

  cron.schedule("* * * * *", async () => {
    if (running) return;
    if (getSetting("auto_enabled") !== "true") return;

    const intervalMin = Number(getSetting("interval_minutes") ?? "5");
    const elapsedMin = (Date.now() - lastRun) / 60000;
    if (elapsedMin < intervalMin) return;

    running = true;
    try {
      console.log(`[auto-trade(local)] サイクル開始 ${new Date().toISOString()}`);
      const results = await runAllMarkets();
      for (const r of results) console.log(`  [${r.market}] ${r.marketOpen ? r.note : "休場"}`);
      lastRun = Date.now();
    } catch (e) {
      console.error("[auto-trade(local)] エラー:", (e as Error).message);
    } finally {
      running = false;
    }
  });

  console.log("[auto-trade(local)] ローカル売買スケジューラを起動（ENABLE_LOCAL_TRADER=1・ルールエンジン）");
}
