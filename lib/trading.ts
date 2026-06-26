import { getDb, getSetting } from "./db";
import { getQuote, getQuotes, detectMarket } from "./yahoo";

export type TradeAction = "BUY" | "SELL";
export type TradeSource = "AI" | "MANUAL";

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

export function getCash(): number {
  const row = getDb()
    .prepare("SELECT cash_jpy FROM account WHERE id = 1")
    .get() as { cash_jpy: number } | undefined;
  return row?.cash_jpy ?? 0;
}

function setCash(value: number): void {
  getDb().prepare("UPDATE account SET cash_jpy = ? WHERE id = 1").run(value);
}

export function getHoldings(): PortfolioHolding[] {
  const rows = getDb()
    .prepare(
      "SELECT ticker, shares, avg_cost_jpy AS avgCostJpy, market FROM portfolio WHERE shares > 0 ORDER BY ticker",
    )
    .all() as PortfolioHolding[];
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
): Promise<TradeResult> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!Number.isFinite(shares) || shares <= 0) {
    return { ok: false, message: "数量が不正です" };
  }
  const quote = await getQuote(ticker);
  const totalJpy = quote.priceJpy * shares;
  const cash = getCash();
  if (totalJpy > cash) {
    return {
      ok: false,
      message: `残高不足です（必要 ${Math.round(totalJpy).toLocaleString()}円 / 残高 ${Math.round(cash).toLocaleString()}円）`,
    };
  }

  const db = getDb();
  const existing = db
    .prepare("SELECT shares, avg_cost_jpy AS avgCostJpy FROM portfolio WHERE ticker = ?")
    .get(ticker) as { shares: number; avgCostJpy: number } | undefined;

  if (existing) {
    const newShares = existing.shares + shares;
    const newAvg =
      (existing.avgCostJpy * existing.shares + quote.priceJpy * shares) /
      newShares;
    db.prepare(
      "UPDATE portfolio SET shares = ?, avg_cost_jpy = ? WHERE ticker = ?",
    ).run(newShares, newAvg, ticker);
  } else {
    db.prepare(
      "INSERT INTO portfolio (ticker, shares, avg_cost_jpy, market) VALUES (?, ?, ?, ?)",
    ).run(ticker, shares, quote.priceJpy, quote.market);
  }

  setCash(cash - totalJpy);
  recordTransaction({
    ticker,
    action: "BUY",
    shares,
    price: quote.price,
    priceJpy: quote.priceJpy,
    totalJpy,
    source,
    reasoning,
  });

  return {
    ok: true,
    message: `${ticker} を ${shares} 株購入しました`,
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
): Promise<TradeResult> {
  const ticker = rawTicker.trim().toUpperCase();
  if (!Number.isFinite(shares) || shares <= 0) {
    return { ok: false, message: "数量が不正です" };
  }
  const db = getDb();
  const existing = db
    .prepare("SELECT shares FROM portfolio WHERE ticker = ?")
    .get(ticker) as { shares: number } | undefined;
  if (!existing || existing.shares < shares) {
    return {
      ok: false,
      message: `保有株が不足しています（保有 ${existing?.shares ?? 0} 株）`,
    };
  }

  const quote = await getQuote(ticker);
  const totalJpy = quote.priceJpy * shares;
  const remaining = existing.shares - shares;
  if (remaining > 0) {
    db.prepare("UPDATE portfolio SET shares = ? WHERE ticker = ?").run(
      remaining,
      ticker,
    );
  } else {
    db.prepare("DELETE FROM portfolio WHERE ticker = ?").run(ticker);
  }

  setCash(getCash() + totalJpy);
  recordTransaction({
    ticker,
    action: "SELL",
    shares,
    price: quote.price,
    priceJpy: quote.priceJpy,
    totalJpy,
    source,
    reasoning,
  });

  return {
    ok: true,
    message: `${ticker} を ${shares} 株売却しました`,
    action: "SELL",
    ticker,
    shares,
    totalJpy,
  };
}

function recordTransaction(t: {
  ticker: string;
  action: TradeAction;
  shares: number;
  price: number;
  priceJpy: number;
  totalJpy: number;
  source: TradeSource;
  reasoning?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO transactions
        (ticker, action, shares, price, price_jpy, total_jpy, source, ai_reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.ticker,
      t.action,
      t.shares,
      t.price,
      t.priceJpy,
      t.totalJpy,
      t.source,
      t.reasoning ?? null,
    );
}

/* ---------- 評価・サマリ ---------- */

/** ポートフォリオを時価評価し、損益込みのサマリを返す。 */
export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const cashJpy = getCash();
  const holdings = getHoldings();
  const initialCash = Number(getSetting("initial_cash") ?? "1000000");

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

/** 現在の総資産を equity_snapshots に記録する。 */
export function recordEquitySnapshot(totalValueJpy: number, cashJpy: number) {
  getDb()
    .prepare(
      "INSERT INTO equity_snapshots (total_value_jpy, cash_jpy) VALUES (?, ?)",
    )
    .run(totalValueJpy, cashJpy);
}

/** 資金をリセットして全保有・履歴を消去する。 */
export function resetAccount(initialCash: number) {
  const db = getDb();
  db.exec("DELETE FROM portfolio; DELETE FROM transactions; DELETE FROM equity_snapshots;");
  db.prepare("UPDATE account SET cash_jpy = ? WHERE id = 1").run(initialCash);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('initial_cash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(initialCash));
}

export { detectMarket };
