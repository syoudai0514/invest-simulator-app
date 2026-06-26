"use client";

import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function StockChart({
  data,
  currency,
}: {
  data: { date: string; close: number }[];
  currency: string;
}) {
  if (!data || data.length < 2) {
    return (
      <div className="flex h-[300px] items-center justify-center text-sm text-muted-foreground">
        チャートデータがありません
      </div>
    );
  }
  const up = data[data.length - 1].close >= data[0].close;
  const color = up ? "#10b981" : "#f43f5e";
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          stroke="currentColor"
          className="text-muted-foreground"
          minTickGap={40}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          stroke="currentColor"
          className="text-muted-foreground"
          width={60}
          domain={["auto", "auto"]}
        />
        <Tooltip
          formatter={(v) => [
            `${Number(v).toLocaleString()} ${currency}`,
            "終値",
          ]}
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Line
          type="monotone"
          dataKey="close"
          stroke={color}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
