// API レスポンスのクライアント側型定義

export interface HoldingValuation {
  ticker: string;
  name: string;
  shares: number;
  avgCostJpy: number;
  market: string;
  currentPriceJpy: number;
  marketValueJpy: number;
  costBasisJpy: number;
  unrealizedPnlJpy: number;
  unrealizedPnlPct: number;
}

export interface EquitySnapshot {
  total: number;
  cash: number;
  benchmark?: number | null;
  createdAt: string;
}

export interface NewsStatus {
  checkedToday: boolean;
  lastChecked: string | null;
  tickerCount: number;
}

/** 1市場ぶんのポートフォリオ＋資産推移。 */
export interface MarketBlock {
  market: "US" | "JP";
  cashJpy: number;
  holdings: HoldingValuation[];
  holdingsValueJpy: number;
  totalValueJpy: number;
  initialCash: number;
  totalPnlJpy: number;
  totalPnlPct: number;
  snapshots: EquitySnapshot[];
}

/** 両市場の合算サマリ（ダッシュボード上部）。 */
export interface CombinedSummary {
  totalValueJpy: number;
  cashJpy: number;
  holdingsValueJpy: number;
  initialCash: number;
  totalPnlJpy: number;
  totalPnlPct: number;
}

export interface PortfolioResponse {
  combined: CombinedSummary;
  markets: { US: MarketBlock; JP: MarketBlock };
  newsStatus: NewsStatus;
}

export interface Transaction {
  id: number;
  ticker: string;
  action: "BUY" | "SELL";
  shares: number;
  price: number;
  priceJpy: number;
  totalJpy: number;
  source: "AI" | "MANUAL";
  aiReasoning: string | null;
  createdAt: string;
}

export interface WatchlistItem {
  ticker: string;
  market: string;
  addedAt: string;
}

export interface AiDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  reasoning: string;
}

export interface AiTradeCycleResult {
  ranAt: string;
  decisions: AiDecision[];
  executed: { ok: boolean; message: string }[];
  summaryNote: string;
}
