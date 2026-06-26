import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { detectMarket, getQuote } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = getDb()
    .prepare(
      "SELECT ticker, market, added_at AS addedAt FROM watchlist ORDER BY ticker",
    )
    .all();
  return NextResponse.json({ watchlist: rows });
}

export async function POST(req: NextRequest) {
  try {
    const { ticker } = (await req.json()) as { ticker?: string };
    if (!ticker) {
      return NextResponse.json({ error: "ticker は必須です" }, { status: 400 });
    }
    const t = ticker.trim().toUpperCase();
    // 実在チェック（取得できなければ追加しない）
    await getQuote(t);
    getDb()
      .prepare(
        "INSERT INTO watchlist (ticker, market) VALUES (?, ?) ON CONFLICT(ticker) DO NOTHING",
      )
      .run(t, detectMarket(t));
    return NextResponse.json({ ok: true, ticker: t });
  } catch (e) {
    return NextResponse.json(
      { error: `銘柄を追加できませんでした: ${(e as Error).message}` },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get("ticker");
  if (!ticker) {
    return NextResponse.json({ error: "ticker は必須です" }, { status: 400 });
  }
  getDb()
    .prepare("DELETE FROM watchlist WHERE ticker = ?")
    .run(ticker.toUpperCase());
  return NextResponse.json({ ok: true });
}
