import { NextResponse } from "next/server";
import { getPortfolioSummary } from "@/lib/trading";
import { getDb } from "@/lib/db";
import { getNewsStatus } from "@/lib/news";
import type { Market } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

function snapshotsFor(market: Market) {
  return getDb()
    .prepare(
      "SELECT total_value_jpy AS total, cash_jpy AS cash, benchmark_value_jpy AS benchmark, created_at AS createdAt FROM equity_snapshots WHERE market = ? ORDER BY id DESC LIMIT 100",
    )
    .all(market)
    .reverse();
}

async function marketBlock(market: Market) {
  const summary = await getPortfolioSummary(market);
  return { ...summary, market, snapshots: snapshotsFor(market) };
}

export async function GET() {
  try {
    const [us, jp] = await Promise.all([marketBlock("US"), marketBlock("JP")]);
    const combined = {
      totalValueJpy: us.totalValueJpy + jp.totalValueJpy,
      cashJpy: us.cashJpy + jp.cashJpy,
      holdingsValueJpy: us.holdingsValueJpy + jp.holdingsValueJpy,
      initialCash: us.initialCash + jp.initialCash,
      totalPnlJpy: us.totalPnlJpy + jp.totalPnlJpy,
      totalPnlPct:
        us.initialCash + jp.initialCash > 0
          ? ((us.totalPnlJpy + jp.totalPnlJpy) / (us.initialCash + jp.initialCash)) * 100
          : 0,
    };
    return NextResponse.json({
      combined,
      markets: { US: us, JP: jp },
      newsStatus: getNewsStatus(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
