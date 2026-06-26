import yahooFinance from "./yf";
import { toJpyRate } from "./currency";

export type Market = "US" | "JP";

// yahoo-finance2 の quote() 戻り値のうち利用するフィールド
interface RawQuote {
  regularMarketPrice?: number;
  regularMarketPreviousClose?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  currency?: string;
  shortName?: string;
  longName?: string;
}

export interface Quote {
  ticker: string;
  name: string;
  market: Market;
  currency: string;
  price: number; // 現地通貨建ての現在値
  priceJpy: number; // 円換算した現在値
  jpyRate: number; // 円換算に使用したレート
  previousClose: number | null;
  changePercent: number | null;
  volume: number | null;
}

export interface ChartPoint {
  date: string; // ISO日付
  close: number; // 現地通貨建て終値
}

/** ティッカーから市場を推定（`.T` 付きは日本株）。 */
export function detectMarket(ticker: string): Market {
  return ticker.toUpperCase().endsWith(".T") ? "JP" : "US";
}

/** 現在値を取得し、円換算値を付与して返す。 */
export async function getQuote(rawTicker: string): Promise<Quote> {
  const ticker = rawTicker.trim().toUpperCase();
  const q = (await yahooFinance.quote(ticker)) as RawQuote;
  if (!q || typeof q.regularMarketPrice !== "number") {
    throw new Error(`株価を取得できませんでした: ${ticker}`);
  }
  const currency = q.currency ?? (detectMarket(ticker) === "JP" ? "JPY" : "USD");
  const jpyRate = await toJpyRate(currency);
  const price = q.regularMarketPrice;
  return {
    ticker,
    name: q.shortName ?? q.longName ?? ticker,
    market: detectMarket(ticker),
    currency,
    price,
    priceJpy: price * jpyRate,
    jpyRate,
    previousClose: q.regularMarketPreviousClose ?? null,
    changePercent: q.regularMarketChangePercent ?? null,
    volume: q.regularMarketVolume ?? null,
  };
}

/** 複数銘柄をまとめて取得（失敗銘柄はスキップ）。 */
export async function getQuotes(tickers: string[]): Promise<Quote[]> {
  const results = await Promise.allSettled(tickers.map((t) => getQuote(t)));
  return results
    .filter(
      (r): r is PromiseFulfilledResult<Quote> => r.status === "fulfilled",
    )
    .map((r) => r.value);
}

/** チャート用の終値時系列を取得。range は "1mo" | "3mo" | "6mo" | "1y" など。 */
export async function getChart(
  rawTicker: string,
  range: string = "3mo",
): Promise<ChartPoint[]> {
  const ticker = rawTicker.trim().toUpperCase();
  const interval = range === "1y" ? "1wk" : "1d";
  const result = (await yahooFinance.chart(ticker, {
    period1: rangeToPeriod1(range),
    interval: interval as "1d" | "1wk",
  })) as { quotes?: { date: Date; close: number | null }[] };
  const quotes = result?.quotes ?? [];
  return quotes
    .filter((p) => typeof p.close === "number")
    .map((p) => ({
      date: new Date(p.date).toISOString().slice(0, 10),
      close: p.close as number,
    }));
}

function rangeToPeriod1(range: string): Date {
  const now = new Date();
  const d = new Date(now);
  switch (range) {
    case "1mo":
      d.setMonth(d.getMonth() - 1);
      break;
    case "6mo":
      d.setMonth(d.getMonth() - 6);
      break;
    case "1y":
      d.setFullYear(d.getFullYear() - 1);
      break;
    case "3mo":
    default:
      d.setMonth(d.getMonth() - 3);
      break;
  }
  return d;
}
