import yahooFinance from "./yf";

let _cached: { rate: number; ts: number } | null = null;
const CACHE_MS = 5 * 60 * 1000; // 5分キャッシュ

/**
 * USD→JPY の為替レートを取得する（5分キャッシュ）。
 * 取得に失敗した場合は妥当なフォールバック値を返す。
 */
export async function getUsdJpyRate(): Promise<number> {
  if (_cached && Date.now() - _cached.ts < CACHE_MS) {
    return _cached.rate;
  }
  try {
    const q = (await yahooFinance.quote("JPY=X")) as {
      regularMarketPrice?: number;
    };
    const rate = q?.regularMarketPrice;
    if (typeof rate === "number" && rate > 0) {
      _cached = { rate, ts: Date.now() };
      return rate;
    }
  } catch {
    // フォールバックへ
  }
  return _cached?.rate ?? 150;
}

/** 銘柄がどの通貨建てかを通貨コードから判定し、JPY換算レートを返す。 */
export async function toJpyRate(currency: string | undefined): Promise<number> {
  if (!currency || currency === "JPY") return 1;
  if (currency === "USD") return getUsdJpyRate();
  // その他通貨は簡易的にUSD扱い（必要なら拡張）
  return getUsdJpyRate();
}
