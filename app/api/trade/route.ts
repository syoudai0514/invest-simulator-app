import { NextRequest, NextResponse } from "next/server";
import { executeBuy, executeSell } from "@/lib/trading";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { ticker, action, shares } = body as {
      ticker?: string;
      action?: string;
      shares?: number;
    };
    if (!ticker || (action !== "BUY" && action !== "SELL") || !shares) {
      return NextResponse.json(
        { error: "ticker, action(BUY/SELL), shares は必須です" },
        { status: 400 },
      );
    }
    const result =
      action === "BUY"
        ? await executeBuy(ticker, Number(shares), "MANUAL")
        : await executeSell(ticker, Number(shares), "MANUAL");
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 },
    );
  }
}
