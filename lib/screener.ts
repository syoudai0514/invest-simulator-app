/**
 * スクリーナー: 300銘柄ユニバースから上位20銘柄を選定
 * - 1時間に1度だけ実行（DBのlast_screened設定で管理）
 * - 選定基準: 当日変動率の絶対値 × 出来高スコア
 */
import { getDb } from "./db";
import { getQuotes, type Market } from "./yahoo";
import { UNIVERSE_TICKERS } from "./universe";
import { JP_TICKERS } from "./universe-jp";

function universeFor(market: Market): string[] {
  return market === "JP"
    ? JP_TICKERS
    : UNIVERSE_TICKERS.filter((t) => !t.endsWith(".T"));
}

const SCREEN_INTERVAL_MS = 60 * 60 * 1000; // 1時間
const TOP_N = 20;
const BATCH_SIZE = 50; // Yahoo Financeのレート制限対策
// 低位株（ペニー株）と低流動性銘柄を候補から除外する下限。
// 1日シミュレーションで、スコア上位がほぼ過熱・低位株・低流動の「フロス」で占められ
// 良質なセットアップが埋もれることを確認したため追加。
const MIN_PRICE = 5; // 現地通貨建ての最低株価
const MIN_DOLLAR_VOLUME = 5_000_000; // 価格×出来高の最低額（流動性）

export interface ScreenedStock {
  ticker: string;
  score: number;
  changePercent: number;
  volume: number;
}

function getLastScreened(market: Market): Date | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`last_screened_${market}`) as { value: string } | undefined;
  if (!row) return null;
  return new Date(row.value);
}

function saveScreened(market: Market, tickers: string[]) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`last_screened_${market}`, now);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(`screened_tickers_${market}`, JSON.stringify(tickers));
}

export function getScreenedTickers(market: Market): string[] {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(`screened_tickers_${market}`) as { value: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.value) as string[];
  } catch {
    return [];
  }
}

export async function runScreener(market: Market, force = false): Promise<string[]> {
  const lastScreened = getLastScreened(market);
  const now = Date.now();

  if (!force && lastScreened && now - lastScreened.getTime() < SCREEN_INTERVAL_MS) {
    console.log(`[screener:${market}] スキップ（前回: ${lastScreened.toISOString()}）`);
    return getScreenedTickers(market);
  }

  console.log(`[screener:${market}] スクリーニング開始...`);
  const scores: ScreenedStock[] = [];
  const universe = universeFor(market);

  // バッチで取得（レート制限対策）
  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await getQuotes(batch);
      for (const q of quotes) {
        if (!q.changePercent || !q.volume) continue;
        // 低位株・低流動性を除外（フロス排除）
        if (q.price < MIN_PRICE) continue;
        if (q.price * q.volume < MIN_DOLLAR_VOLUME) continue;
        // スコア = |変動率| × log(出来高) — 動いていて流動性が高い銘柄を優先
        const score = Math.abs(q.changePercent) * Math.log10(Math.max(q.volume, 1));
        scores.push({ ticker: q.ticker, score, changePercent: q.changePercent, volume: q.volume });
      }
    } catch (e) {
      console.warn(`[screener:${market}] バッチ ${i}-${i + BATCH_SIZE} 取得失敗:`, e);
    }
    // バッチ間に少し待機
    if (i + BATCH_SIZE < universe.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // スコア降順でTOP_N件
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, TOP_N);

  console.log(`[screener:${market}] トップ銘柄:`);
  for (const s of top) {
    console.log(`  ${s.ticker}: score=${s.score.toFixed(2)} change=${s.changePercent.toFixed(2)}% vol=${s.volume.toLocaleString()}`);
  }

  const tickers = top.map((s) => s.ticker);
  saveScreened(market, tickers);
  return tickers;
}
