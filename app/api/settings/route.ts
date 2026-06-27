import { NextRequest, NextResponse } from "next/server";
import { resetAccount, initialCashKey } from "@/lib/trading";
import { getSetting } from "@/lib/db";
import { DEFAULT_INITIAL_CASH } from "@/lib/db";
import type { Market } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    initialCashUS: Number(getSetting(initialCashKey("US")) ?? DEFAULT_INITIAL_CASH),
    initialCashJP: Number(getSetting(initialCashKey("JP")) ?? DEFAULT_INITIAL_CASH),
  });
}

/** 資金リセット（指定市場の保有・履歴を消去して現金を初期化。market省略時は両市場）。 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    initialCash?: number;
    market?: Market;
  };
  const initialCash =
    typeof body.initialCash === "number" && body.initialCash > 0
      ? Math.floor(body.initialCash)
      : DEFAULT_INITIAL_CASH;
  const markets: Market[] = body.market ? [body.market] : ["US", "JP"];
  for (const m of markets) resetAccount(m, initialCash);
  return NextResponse.json({ ok: true, initialCash, markets });
}
