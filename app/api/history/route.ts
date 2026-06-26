import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get("source"); // AI | MANUAL | null
  const ticker = req.nextUrl.searchParams.get("ticker");

  const conditions: string[] = [];
  const args: string[] = [];
  if (source === "AI" || source === "MANUAL") {
    conditions.push("source = ?");
    args.push(source);
  }
  if (ticker) {
    conditions.push("ticker = ?");
    args.push(ticker.toUpperCase());
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = getDb()
    .prepare(
      `SELECT id, ticker, action, shares, price, price_jpy AS priceJpy,
              total_jpy AS totalJpy, source, ai_reasoning AS aiReasoning,
              created_at AS createdAt
         FROM transactions ${where}
        ORDER BY id DESC LIMIT 500`,
    )
    .all(...args);

  return NextResponse.json({ transactions: rows });
}
