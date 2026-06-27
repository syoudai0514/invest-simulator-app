/**
 * ニュースのセンチメント判定（LLM版）。
 *
 * 中核の売買判断（指標・レジーム・執行）はコードのままで、ニュースの「読解」だけを
 * LLM(GROQ/llama)に任せる。キーワード方式と違い「好決算だが警告」のような文脈を読める。
 * 1営業日に1回・市場ごとの呼び出しなので無料枠に十分収まる。
 *
 * 失敗時（APIエラー・レート制限・未設定）は呼び出し側でキーワード方式にフォールバックする。
 */
import Groq from "groq-sdk";

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export interface NewsVerdict {
  score: number; // -1(強い悪材料・買い見送り) 〜 +1(強い好材料)
  reason: string; // 短い日本語の理由（ダッシュボード表示用）
}

const TOOL: Groq.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_sentiment",
    description: "各銘柄のニュース見出しを総合評価したセンチメントを提出する。",
    parameters: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              score: { type: "number", description: "-1.0〜+1.0" },
              reason: { type: "string", description: "20字程度の日本語の根拠" },
            },
            required: ["ticker", "score", "reason"],
          },
        },
      },
      required: ["results"],
    },
  },
};

/**
 * 銘柄ごとの見出しを1回のLLM呼び出しでまとめて評価する。
 * 見出しが無い銘柄は score 0（中立）として返す。
 */
export async function llmNewsSentiment(
  byTicker: { ticker: string; titles: string[] }[],
): Promise<Record<string, NewsVerdict>> {
  const withNews = byTicker.filter((b) => b.titles.length > 0);
  const out: Record<string, NewsVerdict> = {};
  for (const b of byTicker) out[b.ticker] = { score: 0, reason: "ニュースなし" };
  if (withNews.length === 0) return out;

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY 未設定");
  const client = new Groq({ apiKey });

  const lines = withNews
    .map((b) => `## ${b.ticker}\n` + b.titles.map((t) => `- ${t}`).join("\n"))
    .join("\n\n");

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1200,
    tools: [TOOL],
    tool_choice: { type: "function", function: { name: "submit_sentiment" } },
    messages: [
      {
        role: "user",
        content: `あなたは株式トレーダーのニュースアナリストです。各銘柄の見出しを「短期の株価への影響」という観点で総合評価し、-1.0〜+1.0 のセンチメントを付けてください。

# 評価方針
- 単語ではなく文脈で判断する。「好決算だが需要鈍化を警告」のように良い面と悪い面が混在する場合は、市場反応を支配しやすい方（多くは警告＝マイナス）に寄せる。
- 業績上振れ・新製品・提携・格上げ・大型受注などは + 寄り。業績悪化・訴訟・調査・格下げ・ガイダンス引き下げ・リコールなどは − 寄り。
- 強い悪材料は -0.6 以下を付ける（新規買い見送りの目安）。
- 判断材料が薄ければ 0 付近。

# 銘柄と見出し
${lines}

必ず submit_sentiment ツールで全銘柄を提出してください。`,
      },
    ],
  });

  const toolCall = response.choices[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("LLM応答にツール呼び出しなし");
  const parsed = JSON.parse(toolCall.function.arguments) as {
    results?: { ticker: string; score: number; reason: string }[];
  };
  for (const r of parsed.results ?? []) {
    const score = Math.max(-1, Math.min(1, Number(r.score) || 0));
    out[r.ticker.toUpperCase()] = { score, reason: r.reason || "" };
  }
  return out;
}
