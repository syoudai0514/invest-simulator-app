/**
 * ニュース取得: スクリーニング後の銘柄に関する直近ニュースの見出しを取得。
 * - yahoo-finance2 の search() が返す news 配列を利用
 * - 1日に1度だけ取得（DBの last_news 設定で管理）し、news_cache に保存
 */
import yahooFinance from "./yf";
import { getDb } from "./db";

const NEWS_PER_TICKER = 4;

export interface NewsHeadline {
  title: string;
  publisher: string;
  publishedAt: string; // ISO
}

export type NewsByTicker = Record<string, NewsHeadline[]>;

export interface NewsStatus {
  checkedToday: boolean; // 本日（JST）ニュースを確認済みか
  lastChecked: string | null; // 最終確認時刻（ISO）
  tickerCount: number; // 確認した銘柄数
}

/** Date を JST の暦日キー（YYYY-MM-DD）に変換。 */
function jstDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function getLastNews(): Date | null {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'last_news'")
    .get() as { value: string } | undefined;
  return row ? new Date(row.value) : null;
}

/** 本日（JST）ニュースを確認済みかどうかの状況を返す。UI表示用。 */
export function getNewsStatus(): NewsStatus {
  const last = getLastNews();
  const cache = getCachedNews();
  return {
    checkedToday: last ? jstDateKey(last) === jstDateKey(new Date()) : false,
    lastChecked: last ? last.toISOString() : null,
    tickerCount: Object.keys(cache).length,
  };
}

function saveNews(cache: NewsByTicker) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_news', ?)",
  ).run(now);
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('news_cache', ?)",
  ).run(JSON.stringify(cache));
}

export function getCachedNews(): NewsByTicker {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'news_cache'")
    .get() as { value: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.value) as NewsByTicker;
  } catch {
    return {};
  }
}

interface RawNews {
  title?: string;
  publisher?: string;
  providerPublishTime?: Date | string;
}

async function fetchHeadlines(ticker: string): Promise<NewsHeadline[]> {
  try {
    const res = (await yahooFinance.search(ticker, {
      newsCount: NEWS_PER_TICKER,
      quotesCount: 0,
    })) as { news?: RawNews[] };
    const news = res?.news ?? [];
    return news
      .filter((n) => n.title)
      .map((n) => ({
        title: n.title as string,
        publisher: n.publisher ?? "",
        publishedAt: n.providerPublishTime
          ? new Date(n.providerPublishTime).toISOString()
          : "",
      }));
  } catch (e) {
    console.warn(`[news] ${ticker} のニュース取得失敗:`, e);
    return [];
  }
}

/**
 * 対象銘柄のニュースを取得（1日1回キャッシュ）。
 * 取得済みで24時間以内ならキャッシュを返す。
 */
export async function getNewsForTickers(
  tickers: string[],
  force = false,
): Promise<NewsByTicker> {
  const last = getLastNews();

  // 同じJST暦日に取得済みならキャッシュを返す（日付が変われば取り直す）
  if (!force && last && jstDateKey(last) === jstDateKey(new Date())) {
    console.log(`[news] 本日取得済みのためスキップ（前回: ${last.toISOString()}）`);
    return getCachedNews();
  }

  console.log(`[news] 本日初回 — ${tickers.length}銘柄のニュース取得開始...`);
  const cache: NewsByTicker = {};
  for (const ticker of tickers) {
    cache[ticker] = await fetchHeadlines(ticker);
    // レート制限対策の軽い待機
    await new Promise((r) => setTimeout(r, 200));
  }
  saveNews(cache);
  return cache;
}
