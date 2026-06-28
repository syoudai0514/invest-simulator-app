/**
 * イベントスタディ: ニュース材料の代理（出来高急増を伴う急騰/急落）を起点に、
 * 「いつ買うべきか」をフォワードリターンで検証する。
 *   npx tsx --env-file=.env.local scripts/event-study.ts SMH
 * モード:
 *   surge … 急騰(+2%/高出来高)を検出し、0〜5日待って買った場合を比較（追いかけ vs 押し目待ち）
 *   dip   … 急落(-2%/高出来高=キャピチュレーション)後に買った場合（逆張り/平均回帰）
 * 既定は両方を表示。ベースライン=全営業日に買った場合の平均。
 */
import yahooFinance from "../lib/yf";

const ticker = process.argv[2] || "SMH";
const UP = 2.0, DOWN = -2.0, VOL_MULT = 1.5;
const HORIZONS = [3, 5, 10, 20];

interface Bar { date: string; open: number; close: number; volume: number }

async function load(): Promise<Bar[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 730 * 24 * 60 * 60 * 1000);
  const c = (await yahooFinance.chart(ticker, { period1: from, period2: to, interval: "1d" })) as {
    quotes?: { date: Date; open: number | null; close: number | null; volume: number | null }[];
  };
  return (c.quotes ?? [])
    .filter((q) => q.open != null && q.close != null && q.volume != null)
    .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), open: q.open as number, close: q.close as number, volume: q.volume as number }));
}

async function main() {
  const bars = await load();
  // entry: 指定indexの始値で約定 → n営業日保有して終値で手仕舞い
  const fwd = (entryIdx: number, n: number): number | null => {
    const exitIdx = entryIdx + n - 1;
    if (entryIdx >= bars.length || exitIdx >= bars.length) return null;
    return ((bars[exitIdx].close - bars[entryIdx].open) / bars[entryIdx].open) * 100;
  };
  const stat = (entries: number[], n: number) => {
    const rs = entries.map((i) => fwd(i, n)).filter((x): x is number => x !== null);
    if (!rs.length) return "  n/a ";
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const win = (rs.filter((r) => r > 0).length / rs.length) * 100;
    return `${(avg >= 0 ? "+" : "") + avg.toFixed(2)}%/${win.toFixed(0)}%`;
  };

  const surge: number[] = [], dip: number[] = [];
  for (let i = 20; i < bars.length - 1; i++) {
    const ret = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
    const avgVol = bars.slice(i - 20, i).reduce((s, b) => s + b.volume, 0) / 20;
    if (bars[i].volume > avgVol * VOL_MULT) {
      if (ret > UP) surge.push(i);
      if (ret < DOWN) dip.push(i);
    }
  }
  const allIdx = Array.from({ length: bars.length }, (_, i) => i).filter((i) => i >= 21);

  console.log(`=== ${ticker} イベントスタディ（過去2年・${bars.length}営業日） ===`);
  console.log(`急騰日 ${surge.length} / 急落日 ${dip.length}（しきい値 ±${UP}% & 出来高×${VOL_MULT}）`);
  console.log(`ベースライン(全営業日に買い): ` + HORIZONS.map((n) => `${n}日 ${stat(allIdx, n)}`).join("  "));

  console.log(`\n--- 急騰を「N日待って」買う（追いかけ vs 押し目待ち）---`);
  console.log(`待ち日数  ` + HORIZONS.map((n) => `${n}日後`.padStart(13)).join(""));
  for (const wait of [1, 2, 3, 5]) {
    const entries = surge.map((i) => i + wait);
    console.log(`+${wait}日で買い  ` + HORIZONS.map((n) => stat(entries, n).padStart(13)).join(""));
  }

  console.log(`\n--- 逆張り: 急落(キャピチュレーション)の翌日始値で買う ---`);
  console.log(`保有       ` + HORIZONS.map((n) => `${n}日後`.padStart(13)).join(""));
  console.log(`翌日買い   ` + HORIZONS.map((n) => stat(dip.map((i) => i + 1), n).padStart(13)).join(""));
}
main().catch((e) => { console.error("エラー:", (e as Error).message); process.exit(1); });
