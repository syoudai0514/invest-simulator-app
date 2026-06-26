import { NextRequest, NextResponse } from "next/server";
import { getQuote, getChart } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const range = req.nextUrl.searchParams.get("range") ?? "3mo";
  try {
    const [quote, chart] = await Promise.all([
      getQuote(ticker),
      getChart(ticker, range),
    ]);
    return NextResponse.json({ quote, chart });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 404 },
    );
  }
}
