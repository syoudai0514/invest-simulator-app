import { getDb, getSetting } from "./db";
import { getQuote, getQuotes, detectMarket, type Market } from "./yahoo";

export type TradeAction = "BUY" | "SELL";
export type TradeSource = "AI" | "MANUAL";

/** 初期資金の設定キー（市場別）。 */
export function initialCashKey(market: Market): string {
  return `initial_cash_${market}`;
}

/** 売買コスト（手数料＋スプレッド）の片道レート。 */
export const TRADE_COST_RATE = 0.0015;

/** AI売買に課す制約（1銘柄あたり上限・維持する現金下限）。任意。 */
export interface TradeLimits {
  maxPositionJpy?: number;
  minCashJpy?: number;
}

/**
 * 約定価格の明示指定。過去日シミュレーションで getQuote（現在値）の代わりに
 * その日の始値などを使うために用いる。省略時は従来どおり現在値で約定する。
 */
export interface PriceOverride {
  price: number; // 現地通貨建ての約定単価
  priceJpy: number; // 円換算した約定単価
  market?: string; // 市場（省略時はティッカーから推定）
}

export interface PortfolioHolding {
  ticker: string;
  shares: number;
  avgCostJpy: number;
  market: string;
}

export interface HoldingValuation extends PortfolioHolding {
  name: string;
  currentPriceJpy: number;
  marketValueJpy: number;
  costBasisJpy: number;
  unrealizedPnlJpy: number;
  unrealizedPnlPct: number;
}

export interface PortfolioSummary {
  cashJpy: number;
  holdings: HoldingValuation[];
  holdingsValueJpy: number;
  totalValueJpy: number;
  initialCash: number;
  totalPnlJpy: number;
  totalPnlPct: number;
}

export interface TradeResult {
  ok: boolean;
  message: string;
  action?: TradeAction;
  ticker?: string;
  shares?: number;
  totalJpy?: number;
}

/* ---------- 残高・保有 ---------- */

export function getCash(market: Market): number {
  const row = getDb()
    .prepare("SELECT cash_jpy FROM accounts WHERE market = ?")
    .get(market) as { cash_jpy: number } | undefined;
  return row?.cash_jpy ?? 0;
}

function setCash(market: Market, value: number): void {
  getDb()
    .prepare(
      "INSERT INTO accounts (market, cash_jpy) VALUES (?, ?) ON CONFLICT(market) DO UPDATE SET cash_jpy = excluded.cash_jpy",
    )
    .run(market, value);
}

export function getHoldings(market: Market): PortfolioHolding[] {
  const rows = getDb()
    .prepare(
      "SELECT ticker, shares, avg_cost_jpy AS avgCostJpy, market FROM portfolio WHERE shares > 0 AND market = ? ORDER BY ticker",
    )
    .all(market) as PortfolioHolding[];
  return rows;
}

/* ---------- 売買実行 ---------- */

/**
 * 買い注文。円換算した株価で残高チェックし、ポートフォリオと取引履歴を更新する。
 */
export async function executeBuy(
  rawTicker: string,
  shares: number,
  source: TradeSource,
  reasoning?: string,
  limits?: TradeLimits,
  priceOverride?: PriceOverride,
): Promise<TradeResult> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!Number.isFinite(shares) || shares <= 0) {
    return { ok: false, message: "数量が不正です" };
  }
  const quote = priceOverride
    ? {
        price: priceOverride.price,
        priceJpy: priceOverride.priceJpy,
        market: (priceOverride.market as Market) ?? detectMarket(ticker),
      }
    : await getQuote(ticker);
  const market = quote.market as Market;
  const cash = getCash(market);

  // AIは株価を無視した株数を出しがちなので、却下せず「上限・現金・現金下限に
  // 収まる最大株数」までクランプする（バックテストの検証で全却下→0取引の不具合を確認）。
  const requested = shares;
  const unit = quote.priceJpy * (1 + TRADE_COST_RATE); // 1株あたりの実質流出額
  const existingValueJpy = (() => {
    const e = getDb()
      .prepare("SELECT shares FROM portfolio WHERE ticker = ?")
      .get(ticker) as { shares: number } | undefined;
    return (e?.shares ?? 0) * quote.priceJpy;
  })();
  const caps = [shares, cash / unit];
  if (limits?.maxPositionJpy !== undefined) {
    caps.push((limits.maxPositionJpy - existingValueJpy) / quote.priceJpy);
  }
  if (limits?.minCashJpy !== undefined) {
    caps.push((cash - limits.minCashJpy) / unit);
  }
  shares = Math.floor(Math.min(...caps));
  if (shares < 1) {
    return {
      ok: false,
      message: `資金/上限の制約で約定できませんでした（${ticker} 要求 ${requested}株 / 残高 ${Math.round(cash).toLocaleString()}円）`,
    };
  }
  const totalJpy = quote.priceJpy * shares;
  const feeJpy = totalJpy * TRADE_COST_RATE;
  const outflow = totalJpy + feeJpy; // 現金からの実際の流出額

  const db = getDb();
  const existing = db
    .prepare("SELECT shares, avg_cost_jpy AS avgCostJpy FROM portfolio WHERE ticker = ?")
    .get(ticker) as { shares: number; avgCostJpy: number } | undefined;

  // 平均取得原価は買い手数料込み（= unit）で記録する。これにより SELL 時の確定損益が
  // 買い・売り両方のコストを正しく反映し、実際の現金増減と一致する。
  if (existing) {
    const newShares = existing.shares + shares;
    const newAvg =
      (existing.avgCostJpy * existing.shares + unit * shares) / newShares;
    db.prepare(
      "UPDATE portfolio SET shares = ?, avg_cost_jpy = ? WHERE ticker = ?",
    ).run(newShares, newAvg, ticker);
  } else {
    db.prepare(
      "INSERT INTO portfolio (ticker, shares, avg_cost_jpy, market) VALUES (?, ?, ?, ?)",
    ).run(ticker, shares, unit, quote.market);
  }

  setCash(market, cash - outflow);
  recordTransaction({
    market,
    ticker,
    action: "BUY",
    shares,
    price: quote.price,
    priceJpy: quote.priceJpy,
    totalJpy,
    feeJpy,
    realizedPnlJpy: null,
    source,
    reasoning,
  });

  return {
    ok: true,
    message: `${ticker} を ${shares} 株購入しました（手数料 ${Math.round(feeJpy).toLocaleString()}円）`,
    action: "BUY",
    ticker,
    shares,
    totalJpy,
  };
}

/**
 * 売り注文。保有数チェック後、ポートフォリオと取引履歴を更新する。
 */
export async function executeSell(
  rawTicker: string,
  shares: number,
  source: TradeSource,
  reasoning?: string,
  priceOverride?: PriceOverride,
): Promise<TradeResult> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!Number.isFinite(shares) || shares <= 0) {
    return { ok: false, message: "数量が不正です" };
  }
  const db = getDb();
  const existing = db
    .prepare("SELECT shares, avg_cost_jpy AS avgCostJpy FROM portfolio WHERE ticker = ?")
    .get(ticker) as { shares: number; avgCostJpy: number } | undefined;
  if (!existing || existing.shares < shares) {
    return {
      ok: false,
      message: `保有株が不足しています（保有 ${existing?.shares ?? 0} 株）`,
    };
  }

  const market = (priceOverride?.market as Market) ?? detectMarket(ticker);
  const quote = priceOverride
    ? { price: priceOverride.price, priceJpy: priceOverride.priceJpy }
    : await getQuote(ticker);
  const totalJpy = quote.priceJpy * shares;
  const feeJpy = totalJpy * TRADE_COST_RATE;
  const proceeds = totalJpy - feeJpy; // 手数料控除後の受取額
  // 確定損益 = (売却単価 - 平均取得単価) × 株数 − 売却コスト
  const realizedPnlJpy = (quote.priceJpy - existing.avgCostJpy) * shares - feeJpy;

  const remaining = existing.shares - shares;
  if (remaining > 0) {
    db.prepare("UPDATE portfolio SET shares = ? WHERE ticker = ?").run(
      remaining,
      ticker,
    );
  } else {
    db.prepare("DELETE FROM portfolio WHERE ticker = ?").run(ticker);
  }

  setCash(market, getCash(market) + proceeds);
  recordTransaction({
    market,
    ticker,
    action: "SELL",
    shares,
    price: quote.price,
    priceJpy: quote.priceJpy,
    totalJpy,
    feeJpy,
    realizedPnlJpy,
    source,
    reasoning,
  });

  return {
    ok: true,
    message: `${ticker} を ${shares} 株売却しました（確定損益 ${Math.round(realizedPnlJpy).toLocaleString()}円）`,
    action: "SELL",
    ticker,
    shares,
    totalJpy,
  };
}

function recordTransaction(t: {
  market: Market;
  ticker: string;
  action: TradeAction;
  shares: number;
  price: number;
  priceJpy: number;
  totalJpy: number;
  feeJpy: number;
  realizedPnlJpy: number | null;
  source: TradeSource;
  reasoning?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO transactions
        (market, ticker, action, shares, price, price_jpy, total_jpy, fee_jpy, realized_pnl_jpy, source, ai_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.market,
      t.ticker,
      t.action,
      t.shares,
      t.price,
      t.priceJpy,
      t.totalJpy,
      t.feeJpy,
      t.realizedPnlJpy,
      t.source,
      t.reasoning ?? null,
    );
}

/* ---------- 評価・サマリ ---------- */

/** ポートフォリオを時価評価し、損益込みのサマリを返す。 */
export async function getPortfolioSummary(market: Market): Promise<PortfolioSummary> {
  const cashJpy = getCash(market);
  const holdings = getHoldings(market);
  const initialCash = Number(getSetting(initialCashKey(market)) ?? "1000000");

  let valuations: HoldingValuation[] = [];
  if (holdings.length > 0) {
    const quotes = await getQuotes(holdings.map((h) => h.ticker));
    const priceMap = new Map(quotes.map((q) => [q.ticker, q.priceJpy]));
    const nameMap = new Map(quotes.map((q) => [q.ticker, q.name]));
    valuations = holdings.map((h) => {
      const currentPriceJpy = priceMap.get(h.ticker) ?? h.avgCostJpy;
      const marketValueJpy = currentPriceJpy * h.shares;
      const costBasisJpy = h.avgCostJpy * h.shares;
      const unrealizedPnlJpy = marketValueJpy - costBasisJpy;
      const unrealizedPnlPct =
        costBasisJpy > 0 ? (unrealizedPnlJpy / costBasisJpy) * 100 : 0;
      return {
        ...h,
        name: nameMap.get(h.ticker) ?? h.ticker,
        currentPriceJpy,
        marketValueJpy,
        costBasisJpy,
        unrealizedPnlJpy,
        unrealizedPnlPct,
      };
    });
  }

  const holdingsValueJpy = valuations.reduce(
    (s, v) => s + v.marketValueJpy,
    0,
  );
  const totalValueJpy = cashJpy + holdingsValueJpy;
  const totalPnlJpy = totalValueJpy - initialCash;
  const totalPnlPct = initialCash > 0 ? (totalPnlJpy / initialCash) * 100 : 0;

  return {
    cashJpy,
    holdings: valuations,
    holdingsValueJpy,
    totalValueJpy,
    initialCash,
    totalPnlJpy,
    totalPnlPct,
  };
}

/** 現在の総資産を equity_snapshots に記録する（市場別・ベンチマーク評価額は任意）。 */
export function recordEquitySnapshot(
  market: Market,
  totalValueJpy: number,
  cashJpy: number,
  benchmarkValueJpy?: number | null,
) {
  getDb()
    .prepare(
      "INSERT INTO equity_snapshots (market, total_value_jpy, cash_jpy, benchmark_value_jpy) VALUES (?, ?, ?, ?)",
    )
    .run(market, totalValueJpy, cashJpy, benchmarkValueJpy ?? null);
}

/** 指定市場の資金をリセットして、その市場の保有・履歴を消去する。 */
export function resetAccount(market: Market, initialCash: number) {
  const db = getDb();
  db.prepare("DELETE FROM portfolio WHERE market = ?").run(market);
  db.prepare("DELETE FROM transactions WHERE market = ?").run(market);
  db.prepare("DELETE FROM equity_snapshots WHERE market = ?").run(market);
  setCash(market, initialCash);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(initialCashKey(market), String(initialCash));
}

export { detectMarket };
