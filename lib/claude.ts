import Groq from "groq-sdk";
import { getChart, getQuotes, type Quote } from "./yahoo";
import {
  executeBuy,
  executeSell,
  getCash,
  getHoldings,
  getPortfolioSummary,
  recordEquitySnapshot,
  type TradeResult,
} from "./trading";
import { runScreener, getScreenedTickers } from "./screener";
import { summarize } from "./indicators";
import { getNewsForTickers, type NewsByTicker } from "./news";

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export interface AiDecision {
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  shares: number;
  reasoning: string;
}

export interface AiTradeCycleResult {
  ranAt: string;
  decisions: AiDecision[];
  executed: TradeResult[];
  summaryNote: string;
}

function getClient(): Groq {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY が未設定です。");
  return new Groq({ apiKey });
}

/** RSIから状態ラベルを付ける（売られすぎ/買われすぎの目安）。 */
function rsiLabel(rsi: number | null): string {
  if (rsi === null) return "—";
  if (rsi <= 30) return `${rsi.toFixed(0)}（売られすぎ）`;
  if (rsi >= 70) return `${rsi.toFixed(0)}（買われすぎ）`;
  return rsi.toFixed(0);
}

/** SMA20とSMA50の関係からトレンド向きを判定。 */
function trendLabel(
  price: number,
  sma20: number | null,
  sma50: number | null,
): string {
  if (sma20 === null || sma50 === null) return "—";
  if (sma20 > sma50 && price > sma20) return "上昇トレンド（価格>SMA20>SMA50）";
  if (sma20 < sma50 && price < sma20) return "下降トレンド（価格<SMA20<SMA50）";
  if (price > sma20) return "SMA20上抜け（短期強含み）";
  if (price < sma20) return "SMA20下抜け（短期弱含み）";
  return "中立";
}

async function buildMarketContext(
  quotes: Quote[],
  news: NewsByTicker,
): Promise<string> {
  const parts: string[] = [];
  for (const q of quotes) {
    // SMA50算出のため3ヶ月分の終値を取得
    let indicatorText = "（チャート取得失敗）";
    let monthTrend = "";
    try {
      const chart = await getChart(q.ticker, "3mo");
      const closes = chart.map((c) => c.close);
      if (closes.length >= 2) {
        const { sma20, sma50, rsi14 } = summarize(closes);
        // 直近1ヶ月（≈21営業日）の騰落率
        const lookback = Math.min(21, closes.length - 1);
        const monthAgo = closes[closes.length - 1 - lookback];
        const latest = closes[closes.length - 1];
        const monthPct = (((latest - monthAgo) / monthAgo) * 100).toFixed(2);
        monthTrend = `1ヶ月 ${monthPct}%`;
        indicatorText =
          `RSI14: ${rsiLabel(rsi14)} | ` +
          `SMA20: ${sma20?.toFixed(2) ?? "—"} | SMA50: ${sma50?.toFixed(2) ?? "—"} | ` +
          `判定: ${trendLabel(q.price, sma20, sma50)}`;
      }
    } catch {
      indicatorText = "（チャート取得失敗）";
    }

    const headlines = news[q.ticker] ?? [];
    const newsText =
      headlines.length > 0
        ? headlines.map((h) => `      ・${h.title}（${h.publisher}）`).join("\n")
        : "      ・（直近ニュースなし）";

    parts.push(
      `- ${q.ticker} (${q.name}) 現在値 $${q.price} ` +
        `(円換算 ${Math.round(q.priceJpy).toLocaleString()}円) ` +
        `本日 ${q.changePercent?.toFixed(2) ?? "?"}%${monthTrend ? " | " + monthTrend : ""}\n` +
        `    指標: ${indicatorText}\n` +
        `    ニュース:\n${newsText}`,
    );
  }
  return parts.join("\n");
}

const DECISION_TOOL: Groq.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_decisions",
    description: "各銘柄に対する売買判断を提出する。",
    parameters: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              action: { type: "string", enum: ["BUY", "SELL", "HOLD"] },
              shares: { type: "number" },
              reasoning: { type: "string" },
            },
            required: ["ticker", "action", "shares", "reasoning"],
          },
        },
      },
      required: ["decisions"],
    },
  },
};

export async function getAiDecisions(): Promise<AiDecision[]> {
  // 1時間に1度スクリーニングを実行して対象銘柄を更新
  await runScreener();
  let tickers = getScreenedTickers();

  // スクリーナー結果がない場合はウォッチリストにフォールバック
  if (tickers.length === 0) {
    console.log("[claude] スクリーナー結果なし、ウォッチリストを使用");
    const { getDb } = await import("./db");
    const wl = getDb().prepare("SELECT ticker FROM watchlist").all() as { ticker: string }[];
    tickers = wl.map((w) => w.ticker);
  }
  if (tickers.length === 0) return [];

  const quotes = await getQuotes(tickers);
  if (quotes.length === 0) return [];

  // 1日1度ニュースを取得（キャッシュ）
  const news = await getNewsForTickers(quotes.map((q) => q.ticker));

  const marketContext = await buildMarketContext(quotes, news);
  const summary = await getPortfolioSummary();
  const cash = getCash();
  const holdings = getHoldings();
  const holdingsText =
    holdings.length > 0
      ? holdings
          .map(
            (h) =>
              `- ${h.ticker}: ${h.shares}株（平均取得単価 ${Math.round(h.avgCostJpy).toLocaleString()}円/株）`,
          )
          .join("\n")
      : "（保有なし）";

  const client = getClient();
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2000,
    tools: [DECISION_TOOL],
    tool_choice: { type: "function", function: { name: "submit_decisions" } },
    messages: [
      {
        role: "user",
        content: `あなたは仮想資金で運用するデイトレーダーです。以下の情報をもとに、各銘柄に対する売買判断を行ってください。

# 現在の状況
- 利用可能な現金: ${Math.round(cash).toLocaleString()}円
- 総資産評価額: ${Math.round(summary.totalValueJpy).toLocaleString()}円
- トータル損益: ${Math.round(summary.totalPnlJpy).toLocaleString()}円 (${summary.totalPnlPct.toFixed(2)}%)

# 現在の保有銘柄
${holdingsText}

# 本日の注目銘柄（ボラティリティ×出来高スコア上位）
各銘柄に、テクニカル指標（RSI14・SMA20・SMA50・トレンド判定）と直近ニュース見出しを付与しています。
${marketContext}

# 判断ルール（テクニカル指標の解釈）
- RSI14 ≤ 30（売られすぎ）: 反発狙いの BUY 候補。
- RSI14 ≥ 70（買われすぎ）: 利確・反落狙いの SELL 候補。
- 「上昇トレンド」判定かつ RSI が極端でない: 順張り BUY を検討。
- 「下降トレンド」判定: 保有していれば SELL を検討、新規 BUY は避ける。
- ニュース見出しに好材料（決算上振れ・新製品・提携・格上げ等）があれば BUY 方向、悪材料（業績悪化・訴訟・格下げ・調査等）があれば SELL 方向に補正。
- 指標とニュースが一致したときに確信度を高め、矛盾する場合は HOLD 寄りに。

# 落ちるナイフ・リスク回避（バックテスト検証で損失の主因と判明）
- 「売られすぎRSI」でも、直近1ヶ月のモメンタムが大きくマイナス（概ね −12% 以下）で急落中の銘柄は“落ちるナイフ”。新規BUYしない。
- 1株あたりの価格が極端に低い低位株（米国株で概ね $10 未満）は値動きが荒く一晩で大きく下落しやすい。BUYは避ける。
- 直前に損切りした銘柄を同日〜数日で買い戻さない（リベンジ買いの連敗を防ぐ）。
- 強い悪材料ニュースがある銘柄は、指標が良くても新規BUYを見送る。

# 指示
- デイトレ目的で短期の値動きを狙ってください。
- 上記の判断ルールに沿って、各 BUY/SELL の reasoning に「どの指標・ニュースを根拠にしたか」を必ず具体的に記載してください（例: "RSI28で売られすぎ＋好決算報道"）。
- BUY は現金残高の範囲内、1銘柄あたり総資産の20%以内にしてください（超過分は自動で縮小されます）。株価×株数が枠に収まる現実的な株数を出すこと。
- SELL は保有株数以内にしてください。
- 根拠が薄い、または指標とニュースが矛盾する場合はHOLDで構いません。
- 必ず submit_decisions ツールで結果を提出してください。`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return [];
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as { decisions?: AiDecision[] };
    return parsed.decisions ?? [];
  } catch {
    return [];
  }
}

// 1銘柄あたりの上限（総資産の20%）と維持する現金下限（10%）。
const MAX_POSITION_PCT = 0.2;
const MIN_CASH_PCT = 0.1;

export async function runAiTradeCycle(): Promise<AiTradeCycleResult> {
  const ranAt = new Date().toISOString();
  const decisions = await getAiDecisions();
  const executed: TradeResult[] = [];

  // BUYに渡すポジション上限・現金下限（executeBuy側でこの枠に株数をクランプする）
  const preSummary = await getPortfolioSummary();
  const limits = {
    maxPositionJpy: preSummary.totalValueJpy * MAX_POSITION_PCT,
    minCashJpy: preSummary.totalValueJpy * MIN_CASH_PCT,
  };

  for (const d of decisions) {
    if (d.action === "HOLD" || d.shares <= 0) continue;
    try {
      const result =
        d.action === "BUY"
          ? await executeBuy(d.ticker, d.shares, "AI", d.reasoning, limits)
          : await executeSell(d.ticker, d.shares, "AI", d.reasoning);
      executed.push(result);
    } catch (e) {
      executed.push({
        ok: false,
        message: `${d.ticker} の${d.action}に失敗: ${(e as Error).message}`,
      });
    }
  }

  try {
    const summary = await getPortfolioSummary();
    recordEquitySnapshot(summary.totalValueJpy, summary.cashJpy);
  } catch {
    // スナップショット失敗は無視
  }

  const successCount = executed.filter((e) => e.ok).length;
  return {
    ranAt,
    decisions,
    executed,
    summaryNote: `${decisions.length}件の判断、${successCount}件の売買を実行しました`,
  };
}
