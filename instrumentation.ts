/**
 * Next.js のサーバー起動時に1度だけ実行される。
 * node-cron で毎分チェックし、自動売買が有効かつ実行間隔を超えていれば
 * Claude による売買サイクルを回す。
 */
export async function register() {
  // Node.js ランタイムでのみ起動（Edge では node:sqlite 等が使えない）
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const cron = (await import("node-cron")).default;
  const { getSetting } = await import("./lib/db");
  const { runAiTradeCycle } = await import("./lib/claude");

  let lastRun = 0;
  let running = false;

  cron.schedule("* * * * *", async () => {
    if (running) return;
    if (getSetting("auto_enabled") !== "true") return;

    const intervalMin = Number(getSetting("interval_minutes") ?? "60");
    const elapsedMin = (Date.now() - lastRun) / 60000;
    if (elapsedMin < intervalMin) return;

    running = true;
    try {
      console.log(`[auto-trade] サイクル開始 ${new Date().toISOString()}`);
      const result = await runAiTradeCycle();
      console.log(`[auto-trade] ${result.summaryNote}`);
      lastRun = Date.now();
    } catch (e) {
      console.error("[auto-trade] エラー:", (e as Error).message);
    } finally {
      running = false;
    }
  });

  console.log("[auto-trade] スケジューラを起動しました（毎分チェック）");
}
