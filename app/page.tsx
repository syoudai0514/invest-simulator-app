"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EquityChart } from "@/components/equity-chart";
import { jpy, pct, signedJpy, pnlColor } from "@/lib/format";
import type { PortfolioResponse, MarketBlock } from "@/lib/types";
import { RefreshCw, Loader2, TrendingUp } from "lucide-react";

export default function Dashboard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(5);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        fetch("/api/portfolio").then((r) => r.json()),
        fetch("/api/scheduler").then((r) => r.json()),
      ]);
      if (p.error) throw new Error(p.error);
      setData(p);
      setAutoEnabled(s.autoEnabled);
      setIntervalMin(s.intervalMinutes);
    } catch (e) {
      toast.error(`読み込み失敗: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleAuto(v: boolean) {
    setAutoEnabled(v);
    await fetch("/api/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoEnabled: v }),
    });
    toast.success(v ? "自動売買をONにしました" : "自動売買をOFFにしました");
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;

  const { combined, markets } = data;

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">ダッシュボード</h1>
          <p className="text-sm text-muted-foreground">
            米国・日本の2市場をそれぞれ仮想資金100万円でルールエンジンが自動運用
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> 更新
          </Button>
          <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <span className="text-sm">{autoEnabled ? "自動売買 稼働中" : "自動売買 停止中"}</span>
            <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          </div>
        </div>
      </div>

      {/* 合算サマリ */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="合計総資産" value={jpy(combined.totalValueJpy)} sub={`初期 ${jpy(combined.initialCash)}`} />
        <SummaryCard title="合計現金" value={jpy(combined.cashJpy)} />
        <SummaryCard title="合計保有評価" value={jpy(combined.holdingsValueJpy)} />
        <SummaryCard
          title="合計損益"
          value={signedJpy(combined.totalPnlJpy)}
          sub={pct(combined.totalPnlPct)}
          color={pnlColor(combined.totalPnlJpy)}
        />
      </div>

      {/* 市場別セクション */}
      <MarketSection label="🇺🇸 米国市場" block={markets.US} interval={intervalMin} />
      <MarketSection label="🇯🇵 日本市場" block={markets.JP} interval={intervalMin} />
    </div>
  );
}

function MarketSection({ label, block, interval }: { label: string; block: MarketBlock; interval: number }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{label}</CardTitle>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground">総資産 <b className="text-foreground tabular-nums">{jpy(block.totalValueJpy)}</b></span>
            <span className="text-muted-foreground">現金 <b className="text-foreground tabular-nums">{jpy(block.cashJpy)}</b></span>
            <span className={`font-medium tabular-nums ${pnlColor(block.totalPnlJpy)}`}>
              {signedJpy(block.totalPnlJpy)}（{pct(block.totalPnlPct)}）
            </span>
          </div>
        </div>
        <CardDescription>初期 {jpy(block.initialCash)} ・ {interval}分間隔で自動判断</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5 text-emerald-500" /> 資産推移
          </div>
          <EquityChart snapshots={block.snapshots} initialCash={block.initialCash} />
        </div>
        {block.holdings.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">保有銘柄はありません</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>銘柄</TableHead>
                <TableHead className="text-right">株数</TableHead>
                <TableHead className="text-right">平均取得</TableHead>
                <TableHead className="text-right">現在値</TableHead>
                <TableHead className="text-right">評価額</TableHead>
                <TableHead className="text-right">評価損益</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.holdings.map((h) => (
                <TableRow key={h.ticker}>
                  <TableCell className="font-medium">
                    {h.ticker}
                    <span className="block text-xs font-normal text-muted-foreground">{h.name}</span>
                  </TableCell>
                  <TableCell className="text-right">{h.shares}</TableCell>
                  <TableCell className="text-right">{jpy(h.avgCostJpy)}</TableCell>
                  <TableCell className="text-right">{jpy(h.currentPriceJpy)}</TableCell>
                  <TableCell className="text-right">{jpy(h.marketValueJpy)}</TableCell>
                  <TableCell className={`text-right font-medium ${pnlColor(h.unrealizedPnlJpy)}`}>
                    {signedJpy(h.unrealizedPnlJpy)}
                    <span className="block text-xs">{pct(h.unrealizedPnlPct)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SummaryCard({
  title,
  value,
  sub,
  color,
}: {
  title: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className={`text-2xl tabular-nums ${color ?? ""}`}>{value}</CardTitle>
      </CardHeader>
      {sub && (
        <CardContent className="pt-0">
          <span className={`text-sm font-medium ${color ?? ""}`}>{sub}</span>
        </CardContent>
      )}
    </Card>
  );
}
