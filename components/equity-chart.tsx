"use client";

import {
  Area,
  Line,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import type { EquitySnapshot } from "@/lib/types";
import { fmtDate, jpy } from "@/lib/format";

// dataviz ダークパレット（検証済み）: 戦略=blue, ベンチ=muted参照線
const C = {
  strategy: "#3987e5",
  bench: "#898781",
  grid: "#2c2c2a",
  axis: "#898781",
  good: "#0ca30c",
  bad: "#e66767",
};

export function EquityChart({
  snapshots,
  initialCash,
  benchLabel = "ベンチ",
}: {
  snapshots: EquitySnapshot[];
  initialCash: number;
  benchLabel?: string;
}) {
  if (!snapshots || snapshots.length < 2) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
        資産推移は売買サイクル実行後に表示されます
      </div>
    );
  }

  const data = snapshots.map((s) => ({
    time: fmtDate(s.createdAt),
    total: Math.round(s.total),
    bench: s.benchmark != null ? Math.round(s.benchmark) : null,
  }));
  const hasBench = data.some((d) => d.bench != null);
  const last = data[data.length - 1];

  return (
    <div>
      {/* 凡例（2系列なので必須・チップ形式） */}
      <div className="mb-1 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: C.strategy }} />
          戦略
        </span>
        {hasBench && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-4 border-t-2 border-dashed"
              style={{ borderColor: C.bench }}
            />
            {benchLabel}（買い持ち）
          </span>
        )}
        <span className="ml-auto tabular-nums">
          現在 <b style={{ color: last.total >= initialCash ? C.good : C.bad }}>{jpy(last.total)}</b>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={230}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eqStrat" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={C.strategy} stopOpacity={0.35} />
              <stop offset="95%" stopColor={C.strategy} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={C.grid} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 10, fill: C.axis }}
            stroke="transparent"
            minTickGap={48}
          />
          <YAxis
            tick={{ fontSize: 10, fill: C.axis, fontVariant: "tabular-nums" } as never}
            stroke="transparent"
            width={52}
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${(v / 10000).toFixed(0)}万`}
          />
          <Tooltip
            formatter={(v, name) => [jpy(Number(v)), name === "total" ? "戦略" : benchLabel]}
            labelStyle={{ color: "#c3c2b7", fontSize: 11 }}
            contentStyle={{
              background: "#1a1a19",
              border: "1px solid rgba(255,255,255,0.10)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine
            y={initialCash}
            stroke={C.axis}
            strokeOpacity={0.5}
            strokeDasharray="2 4"
          />
          {hasBench && (
            <Line
              type="monotone"
              dataKey="bench"
              stroke={C.bench}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              connectNulls
            />
          )}
          <Area
            type="monotone"
            dataKey="total"
            stroke={C.strategy}
            strokeWidth={2}
            fill="url(#eqStrat)"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
