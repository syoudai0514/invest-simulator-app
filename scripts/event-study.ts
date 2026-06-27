/**
 * 簡易イベントスタディ: 「半導体に材料が出た日に買っていたら？」をプライスアクションで近似。
 * 材料ニュースは過去再現できないため、半導体ETF(SMH)が「出来高急増を伴う急騰」をした日を
 * “好材料が出た日”の代理シグナルとし、翌営業日の始値で買って N 日後に売った場合の
 * フォワードリターンを、全営業日の平均（ベースライン）と比較する。
 *   npx tsx --env-file=.env.local scripts/event-study.ts SMH
 */
import yahooFinance from "../lib/yf";

const ticker = process.argv[2] || "SMH";
const UP_THRESHOLD = 2.0; // 当日リターンがこの%超
const VOL_MULT = 1.5; // 20日平均出来高のこの倍超
const HORIZONS = [3, 5, 10, 20];

interface Bar { date: string; open: number; close: number; volume: number }

async function main() {
  const to = new Date();
  const from = new Date(to.getTime() - 730 * 24 * 60 * 60 * 1000);
  const c = await yahooFinance.chart(ticker, { period1: from, period2: to, interval: "1d" });
  const bars: Bar[] = (c.quotes ?? [])
    .filter((q: any) => q.open != null && q.close != null && q.volume != null)
    .map((q: any) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open, close: q.close, volume: q.volume }));

  // 全営業日のフォワードリターン（翌日始値→N営業日後の終値）
  function fwd(i: number, n: number): number | null {
    const entryIdx = i + 1; // 翌営業日の始値で約定
    const exitIdx = entryIdx + n - 1;
    if (exitIdx >= bars.length) return null;
    return ((bars[exitIdx].close - bars[entryIdx].open) / bars[entryIdx].open) * 100;
  }

  // イベント日の判定
  const eventIdx: number[] = [];
  for (let i = 20; i < bars.length - 1; i++) {
    const ret = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
    const avgVol = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
    if (ret > UP_THRESHOLD && bars[i].volume > avgVol * VOL_MULT) eventIdx.push(i);
  }

  function stats(idxs: number[], n: number) {
    const rs = idxs.map((i) => fwd(i, n)).filter((x): x is number => x !== null);
    if (rs.length === 0) return { n: 0, avg: 0, win: 0 };
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const win = (rs.filter((r) => r > 0).length / rs.length) * 100;
    return { n: rs.length, avg, win };
  }

  const allIdx = Array.from({ length: bars.length - 1 }, (_, i) => i).filter((i) => i >= 20);
  console.log(`=== ${ticker} イベントスタディ（過去2年・${bars.length}営業日） ===`);
  console.log(`イベント定義: 当日 +${UP_THRESHOLD}%超 かつ 出来高>20日平均×${VOL_MULT}（=材料での急騰の代理）`);
  console.log(`該当イベント日数: ${eventIdx.length}\n`);
  console.log(`保有日数   イベント後(平均/勝率)        全営業日ベースライン(平均/勝率)   超過`);
  for (const n of HORIZONS) {
    const e = stats(eventIdx, n);
    const b = stats(allIdx, n);
    const edge = e.avg - b.avg;
    console.log(
      `${String(n).padStart(2)}日後   ` +
      `${(e.avg >= 0 ? "+" : "") + e.avg.toFixed(2)}% / 勝率${e.win.toFixed(0)}%`.padEnd(28) +
      `${(b.avg >= 0 ? "+" : "") + b.avg.toFixed(2)}% / 勝率${b.win.toFixed(0)}%`.padEnd(30) +
      `${edge >= 0 ? "+" : ""}${edge.toFixed(2)}pt`,
    );
  }
}
main().catch((e) => { console.error("エラー:", (e as Error).message); process.exit(1); });
