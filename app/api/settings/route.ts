import { NextRequest, NextResponse } from "next/server";
import { resetAccount } from "@/lib/trading";
import { getSetting } from "@/lib/db";
import { DEFAULT_INITIAL_CASH } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    initialCash: Number(getSetting("initial_cash") ?? DEFAULT_INITIAL_CASH),
  });
}

/** 資金リセット（保有・履歴を全消去して現金を初期化）。 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    initialCash?: number;
  };
  const initialCash =
    typeof body.initialCash === "number" && body.initialCash > 0
      ? Math.floor(body.initialCash)
      : DEFAULT_INITIAL_CASH;
  resetAccount(initialCash);
  return NextResponse.json({ ok: true, initialCash });
}
