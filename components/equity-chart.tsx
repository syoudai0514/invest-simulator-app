"use client";

import {
  Area,
  AreaChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { EquitySnapshot } from "@/lib/types";
import { fmtDate, jpy } from "@/lib/format";

export function EquityChart({
  snapshots,
  initialCash,
}: {
  snapshots: EquitySnapshot[];
  initialCash: number;
}) {
  if (!snapshots || snapshots.length < 2) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        資産推移はAI売買サイクル実行後に表示されます
      </div>
    );
  }

  const data = snapshots.map((s) => ({
    time: fmtDate(s.createdAt),
    total: Math.round(s.total),
  }));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11 }}
          stroke="currentColor"
          className="text-muted-foreground"
          minTickGap={40}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="currentColor"
          className="text-muted-foreground"
          width={70}
          domain={["auto", "auto"]}
          tickFormatter={(v) => `${(v / 10000).toFixed(0)}万`}
        />
        <Tooltip
          formatter={(v) => [jpy(Number(v)), "総資産"]}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <ReferenceLine
          y={initialCash}
          stroke="currentColor"
          strokeDasharray="4 4"
          className="text-muted-foreground/50"
          label={{ value: "初期", fontSize: 10, position: "insideTopLeft" }}
        />
        <Area
          type="monotone"
          dataKey="total"
          stroke="#10b981"
          strokeWidth={2}
          fill="url(#eq)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
