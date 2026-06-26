import Groq from "groq-sdk";
import { getDb } from "./db";
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

// Groq 無料モデル（llama-3.1-70b は tool use 対応済み）
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
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY が未設定です。https://console.groq.com でキーを取得し .env.local に設定してください。",
    );
  }
  return new Groq({ apiKey });
}

function getWatchlist(): { ticker: string; market: string }[] {
  return getDb()
    .prepare("SELECT ticker, market FROM watchlist ORDER BY ticker")
    .all() as { ticker: string; market: string }[];
}

async function buildMarketContext(quotes: Quote[]): Promise<string> {
  const parts: string[] = [];
  for (const q of quotes) {
    let trend = "";
    try {
      const chart = await getChart(q.ticker, "1mo");
      if (chart.length >= 2) {
        const first = chart[0].close;
        const last = chart[chart.length - 1].close;
        const pct = (((last - first) / first) * 100).toFixed(2);
        trend = `直近1ヶ月: ${pct}%（${first} → ${last}）`;
      }
    } catch {
      trend = "（チャート取得失敗）";
    }
    parts.push(
      `- ${q.ticker} (${q.name}) [${q.market}/${q.currency}] 現在値 ${q.price} ` +
        `(円換算 ${Math.round(q.priceJpy).toLocaleString()}円) ` +
        `前日比 ${q.changePercent?.toFixed(2) ?? "?"}% | ${trend}`,
    );
  }
  return parts.join("\n");
}

const DECISION_TOOL: Groq.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_decisions",
    description:
      "各ウォッチリスト銘柄に対する売買判断を提出する。BUY/SELL の場合は具体的な株数を指定する。",
    parameters: {
      type: "object",
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string", description: "銘柄ティッカー" },
              action: {
                type: "string",
                enum: ["BUY", "SELL", "HOLD"],
                description: "売買アクション",
              },
              shares: {
                type: "number",
                description: "売買株数（HOLDの場合は0）",
              },
              reasoning: {
                type: "string",
                description: "その判断に至った理由（日本語、簡潔に）",
              },
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
  const watchlist = getWatchlist();
  if (watchlist.length === 0) return [];

  const quotes = await getQuotes(watchlist.map((w) => w.ticker));
  if (quotes.length === 0) return [];

  const marketContext = await buildMarketContext(quotes);
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
        content: `あなたは仮想資金で運用するポートフォリオマネージャーです。以下の情報をもとに、各銘柄に対する売買判断を行ってください。

# 現在の状況
- 利用可能な現金: ${Math.round(cash).toLocaleString()}円
- 総資産評価額: ${Math.round(summary.totalValueJpy).toLocaleString()}円
- トータル損益: ${Math.round(summary.totalPnlJpy).toLocaleString()}円 (${summary.totalPnlPct.toFixed(2)}%)

# 現在の保有銘柄
${holdingsText}

# ウォッチリスト銘柄の市場データ
${marketContext}

# 指示
- 各銘柄について BUY / SELL / HOLD を判断してください。
- BUY は現金残高の範囲内に収め、1銘柄あたり総資産の30%を超えないようにしてください。
- SELL は現在保有している株数を超えないようにしてください。
- リスク分散を意識し、根拠のある判断のみBUY/SELLしてください。確信が持てなければHOLDで構いません。
- 必ず submit_decisions ツールで結果を提出してください。`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) return [];
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as {
      decisions?: AiDecision[];
    };
    return parsed.decisions ?? [];
  } catch {
    return [];
  }
}

export async function runAiTradeCycle(): Promise<AiTradeCycleResult> {
  const ranAt = new Date().toISOString();
  const decisions = await getAiDecisions();
  const executed: TradeResult[] = [];

  for (const d of decisions) {
    if (d.action === "HOLD" || d.shares <= 0) continue;
    try {
      const result =
        d.action === "BUY"
          ? await executeBuy(d.ticker, d.shares, "AI", d.reasoning)
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
