import { NextResponse } from "next/server";
import { getPortfolioSummary } from "@/lib/trading";
import { getDb } from "@/lib/db";
import { getNewsStatus } from "@/lib/news";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const summary = await getPortfolioSummary();
    const snapshots = getDb()
      .prepare(
        "SELECT total_value_jpy AS total, cash_jpy AS cash, created_at AS createdAt FROM equity_snapshots ORDER BY id DESC LIMIT 100",
      )
      .all()
      .reverse();
    return NextResponse.json({ ...summary, snapshots, newsStatus: getNewsStatus() });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
