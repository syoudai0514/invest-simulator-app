import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import type { Market } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

function activityFor(market: Market) {
  const db = getDb();
  const regime = db
    .prepare(
      "SELECT risk_off AS riskOff, ran_at AS ranAt FROM cycle_log WHERE market = ? AND market_open = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(market) as { riskOff: number; ranAt: string } | undefined;

  const lastCycle = db
    .prepare(
      "SELECT ran_at AS ranAt, market_open AS marketOpen, decisions, executed, note FROM cycle_log WHERE market = ? ORDER BY id DESC LIMIT 1",
    )
    .get(market) as
    | { ranAt: string; marketOpen: number; decisions: number; executed: number; note: string | null }
    | undefined;

  const decisions = db
    .prepare(
      `SELECT ran_at AS ranAt, ticker, action, shares, executed, reject_reason AS rejectReason,
              reasoning, rsi14, mom_pct AS momPct, pnl_pct AS pnlPct
       FROM decision_log WHERE market = ? ORDER BY id DESC LIMIT 20`,
    )
    .all(market);

  const trades = db
    .prepare(
      `SELECT created_at AS createdAt, action, ticker, shares, price_jpy AS priceJpy,
              realized_pnl_jpy AS realizedPnlJpy, ai_reasoning AS reasoning
       FROM transactions WHERE market = ? ORDER BY id DESC LIMIT 12`,
    )
    .all(market);

  return {
    regime: regime ? { riskOff: !!regime.riskOff, ranAt: regime.ranAt } : null,
    lastCycle: lastCycle
      ? { ...lastCycle, marketOpen: !!lastCycle.marketOpen }
      : null,
    decisions,
    trades,
  };
}

export async function GET() {
  try {
    return NextResponse.json({ US: activityFor("US"), JP: activityFor("JP") });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
