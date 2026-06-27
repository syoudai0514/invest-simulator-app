/**
 * ルールベースの売買判断エンジン。
 *
 * backtest.ts の LLM プロンプトに書かれていた判断基準（RSI・トレンド・ニュース補正）を
 * 決定論的なコードとして実装したもの。LLM を介さないため、
 *  - APIトークン制限に縛られず全期間・全市場を何度でも回せる
 *  - 出力が決定的でパラメータ変更の効果を正確に比較・チューニングできる
 * という利点があり、「売買判断基準の検証・修正」に向く。
 *
 * ここでチューニングして得た良い閾値は、LLM版プロンプトのルールにも反映できる。
 */

export interface AiDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  reasoning: string;
}

/** 1銘柄の前日終値時点のスナップショット。 */
export interface Candidate {
  ticker: string;
  lastClose: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  momPct: number; // 直近約20営業日の騰落率
  maxBuyShares: number; // 20%枠で買える最大株数
  heldShares: number;
  avgCost: number | null;
  newsTitles: string[];
}

export interface RuleParams {
  rsiBuy: number; // これ以下で「売られすぎ」→反発BUY
  rsiSell: number; // これ以上で「買われすぎ」→SELL
  trendRsiMin: number; // 順張りBUYを許可するRSI下限
  trendRsiMax: number; // 順張りBUYを許可するRSI上限
  maxNewPositions: number; // 1日の新規BUY最大件数
  allocPctPerBuy: number; // 1回のBUYに充てる「利用可能現金」の割合
  newsBoost: number; // ニュースセンチメントのスコア寄与
  newsVetoNeg: number; // これ以下のセンチメントで新規BUYを見送る
  minScore: number; // BUY実行に必要な最低スコア
  minPrice: number; // この株価未満の銘柄は対象外（ペニー株除外）
  momFloorOversold: number; // 20日モメンタムがこれ未満なら「売られすぎ反発」買いを見送る（落ちるナイフ回避）
  momCeiling: number; // 20日モメンタムがこれを超える過熱(パラボリック)は新規BUY見送り
}

/** 既定パラメータ（元プロンプトのルールを素直に数値化した初期値）。 */
export const DEFAULT_PARAMS: RuleParams = {
  rsiBuy: 30,
  rsiSell: 70,
  trendRsiMin: 40,
  trendRsiMax: 65,
  maxNewPositions: 3,
  allocPctPerBuy: 0.5,
  newsBoost: 0.4,
  newsVetoNeg: -0.5,
  minScore: 0.3,
  minPrice: 0,
  momFloorOversold: -100,
  momCeiling: 100000,
};

/** チューニング後の推奨パラメータ（落ちるナイフ・ペニー株を抑制）。 */
export const TUNED_PARAMS: RuleParams = {
  rsiBuy: 30,
  rsiSell: 70,
  trendRsiMin: 45,
  trendRsiMax: 68,
  maxNewPositions: 3,
  allocPctPerBuy: 0.4,
  newsBoost: 0.4,
  newsVetoNeg: -0.5,
  minScore: 0.5,
  minPrice: 10,
  momFloorOversold: -12,
  momCeiling: 80,
};

const POS_WORDS = [
  "beat", "beats", "surge", "soar", "jump", "rally", "record", "upgrade",
  "raises", "raised", "boost", "strong", "wins", "deal", "partnership",
  "approval", "approve", "buyback", "growth", "outperform", "bullish",
  "好決算", "上方修正", "増益", "最高益", "提携", "格上げ", "新製品", "受注",
  "急騰", "上昇", "好調",
];
const NEG_WORDS = [
  "miss", "misses", "plunge", "plummet", "drop", "fall", "slump", "cut",
  "cuts", "downgrade", "lawsuit", "probe", "investigation", "recall",
  "warning", "weak", "loss", "bearish", "halt", "fraud", "decline",
  "下方修正", "減益", "赤字", "訴訟", "調査", "格下げ", "リコール", "不正",
  "急落", "下落", "低迷", "懸念",
];

/** 見出し群から -1..+1 のセンチメントを推定（単純キーワード集計）。 */
export function classifyNews(titles: string[]): number {
  if (titles.length === 0) return 0;
  let pos = 0;
  let neg = 0;
  for (const raw of titles) {
    const t = raw.toLowerCase();
    for (const w of POS_WORDS) if (t.includes(w.toLowerCase())) pos++;
    for (const w of NEG_WORDS) if (t.includes(w.toLowerCase())) neg++;
  }
  if (pos + neg === 0) return 0;
  return (pos - neg) / (pos + neg);
}

function isUptrend(c: Candidate): boolean {
  return (
    c.sma20 !== null &&
    c.sma50 !== null &&
    c.sma20 > c.sma50 &&
    c.lastClose > c.sma20
  );
}

function isDowntrend(c: Candidate): boolean {
  return (
    c.sma20 !== null &&
    c.sma50 !== null &&
    c.sma20 < c.sma50 &&
    c.lastClose < c.sma20
  );
}

export interface RuleContext {
  cash: number;
  minCash: number;
  params: RuleParams;
  /** 直近に損切りした銘柄（再エントリーのクールダウン中）。 */
  inCooldown?: (ticker: string) => boolean;
}

/**
 * 判断基準を適用して当日の売買判断を返す。
 * SELL（保有の手仕舞い）を先に評価し、その後スコア上位を新規BUY。
 */
export function ruleDecide(
  candidates: Candidate[],
  ctx: RuleContext,
): AiDecision[] {
  const p = ctx.params;
  const decisions: AiDecision[] = [];

  // 1) 保有銘柄の手仕舞い判断
  for (const c of candidates) {
    if (c.heldShares <= 0) continue;
    const sent = classifyNews(c.newsTitles);
    const reasons: string[] = [];
    if (c.rsi14 !== null && c.rsi14 >= p.rsiSell)
      reasons.push(`RSI${c.rsi14.toFixed(0)}で買われすぎ`);
    if (isDowntrend(c)) reasons.push("下降トレンド");
    if (sent <= p.newsVetoNeg) reasons.push("悪材料ニュース");
    if (reasons.length > 0) {
      decisions.push({
        ticker: c.ticker,
        action: "SELL",
        shares: c.heldShares,
        reasoning: `手仕舞い: ${reasons.join("・")}`,
      });
    } else {
      decisions.push({
        ticker: c.ticker,
        action: "HOLD",
        shares: 0,
        reasoning: "保有継続（手仕舞いシグナルなし）",
      });
    }
  }

  // 2) 新規BUY候補のスコアリング
  const heldSet = new Set(
    candidates.filter((c) => c.heldShares > 0).map((c) => c.ticker),
  );
  const scored: { c: Candidate; score: number; why: string[] }[] = [];
  for (const c of candidates) {
    if (heldSet.has(c.ticker)) continue;
    if (c.rsi14 === null) continue;
    if (c.lastClose < p.minPrice) continue; // ペニー株除外
    if (ctx.inCooldown?.(c.ticker)) continue; // 損切り直後の再エントリー禁止
    if (isDowntrend(c)) continue; // 下降トレンドは新規回避
    if (c.momPct > p.momCeiling) continue; // 過熱(パラボリック)は新規回避
    const sent = classifyNews(c.newsTitles);
    if (sent <= p.newsVetoNeg) continue; // 悪材料は見送り
    let score = 0;
    const why: string[] = [];
    if (c.rsi14 <= p.rsiBuy) {
      // 売られすぎ反発。ただし急落中（モメンタムが床割れ）は落ちるナイフなので見送る。
      if (c.momPct >= p.momFloorOversold) {
        score += (p.rsiBuy - c.rsi14) / p.rsiBuy + 0.5;
        why.push(`RSI${c.rsi14.toFixed(0)}売られすぎ`);
      }
    }
    if (
      isUptrend(c) &&
      c.rsi14 >= p.trendRsiMin &&
      c.rsi14 <= p.trendRsiMax
    ) {
      score += 0.6; // 順張り
      why.push("上昇トレンド順張り");
    }
    if (sent > 0) {
      score += p.newsBoost * sent;
      why.push(`好材料ニュース(${sent.toFixed(1)})`);
    } else if (sent < 0) {
      score += p.newsBoost * sent; // 軽い減点
    }
    if (score >= p.minScore && c.maxBuyShares >= 1) {
      scored.push({ c, score, why });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // 3) 上位に資金配分（現金を順次減らす）
  let avail = ctx.cash - ctx.minCash;
  let opened = 0;
  for (const { c, score, why } of scored) {
    if (opened >= p.maxNewPositions) break;
    if (avail <= 0) break;
    const budget = Math.min(
      avail * p.allocPctPerBuy,
      c.maxBuyShares * c.lastClose,
    );
    const shares = Math.floor(budget / c.lastClose);
    if (shares < 1) continue;
    decisions.push({
      ticker: c.ticker,
      action: "BUY",
      shares,
      reasoning: `${why.join("・")}（スコア${score.toFixed(2)}）`,
    });
    avail -= shares * c.lastClose;
    opened++;
  }

  return decisions;
}
