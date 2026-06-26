import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    autoEnabled: getSetting("auto_enabled") === "true",
    intervalMinutes: Number(getSetting("interval_minutes") ?? "60"),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    autoEnabled?: boolean;
    intervalMinutes?: number;
  };
  if (typeof body.autoEnabled === "boolean") {
    setSetting("auto_enabled", body.autoEnabled ? "true" : "false");
  }
  if (
    typeof body.intervalMinutes === "number" &&
    body.intervalMinutes >= 1
  ) {
    setSetting("interval_minutes", String(Math.floor(body.intervalMinutes)));
  }
  return NextResponse.json({
    autoEnabled: getSetting("auto_enabled") === "true",
    intervalMinutes: Number(getSetting("interval_minutes") ?? "60"),
  });
}
