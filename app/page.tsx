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
import type {
  PortfolioResponse,
  AiTradeCycleResult,
} from "@/lib/types";
import { Bot, RefreshCw, Loader2, TrendingUp, Newspaper } from "lucide-react";

export default function Dashboard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiRunning, setAiRunning] = useState(false);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(60);

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

  async function runAi() {
    setAiRunning(true);
    toast.info("Claude が市場を分析しています…");
    try {
      const res = await fetch("/api/ai-trade", { method: "POST" });
      const json: AiTradeCycleResult & { error?: string } = await res.json();
      if (json.error) throw new Error(json.error);
      toast.success(json.summaryNote);
      for (const ex of json.executed) {
        if (ex.ok) toast.success(ex.message);
      }
      await load();
    } catch (e) {
      toast.error(`AI売買失敗: ${(e as Error).message}`);
    } finally {
      setAiRunning(false);
    }
  }

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

  return (
    <div className="space-y-6">
      {/* ヘッダー行 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">ダッシュボード</h1>
          <p className="text-sm text-muted-foreground">
            仮想資金で Claude の運用成果を確認
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> 更新
          </Button>
          <Button onClick={runAi} disabled={aiRunning}>
            {aiRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
            今すぐClaudeに判断させる
          </Button>
        </div>
      </div>

      {/* サマリカード */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard title="総資産" value={jpy(data.totalValueJpy)} />
        <SummaryCard title="現金残高" value={jpy(data.cashJpy)} />
        <SummaryCard title="保有評価額" value={jpy(data.holdingsValueJpy)} />
        <SummaryCard
          title="トータル損益"
          value={signedJpy(data.totalPnlJpy)}
          sub={pct(data.totalPnlPct)}
          color={pnlColor(data.totalPnlJpy)}
        />
      </div>

      {/* 資産推移 + 自動売買 */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-emerald-500" /> 資産推移
            </CardTitle>
          </CardHeader>
          <CardContent>
            <EquityChart
              snapshots={data.snapshots}
              initialCash={data.initialCash}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">自動売買</CardTitle>
            <CardDescription>
              サーバー稼働中、設定間隔ごとに Claude が自動で判断します
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="font-medium">自動売買</p>
                <p className="text-xs text-muted-foreground">
                  {autoEnabled ? "稼働中" : "停止中"} ・ {intervalMin}分間隔
                </p>
              </div>
              <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Newspaper className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="font-medium">本日のニュース確認</p>
                  <p className="text-xs text-muted-foreground">
                    {data.newsStatus.lastChecked
                      ? `最終確認 ${new Date(data.newsStatus.lastChecked).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}・${data.newsStatus.tickerCount}銘柄`
                      : "未確認"}
                  </p>
                </div>
              </div>
              <Badge variant={data.newsStatus.checkedToday ? "default" : "outline"}>
                {data.newsStatus.checkedToday ? "確認済み" : "未確認"}
              </Badge>
            </div>
            <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
              初期資金 {jpy(data.initialCash)} からスタート。間隔の変更は「設定」ページから。
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 保有銘柄 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">保有銘柄</CardTitle>
        </CardHeader>
        <CardContent>
          {data.holdings.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              保有銘柄はありません。「売買・チャート」または上のAIボタンから取引を始めましょう。
            </p>
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
                {data.holdings.map((h) => (
                  <TableRow key={h.ticker}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-1.5">
                        {h.ticker}
                        <Badge variant="outline" className="text-[10px]">
                          {h.market}
                        </Badge>
                      </div>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {h.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">{h.shares}</TableCell>
                    <TableCell className="text-right">
                      {jpy(h.avgCostJpy)}
                    </TableCell>
                    <TableCell className="text-right">
                      {jpy(h.currentPriceJpy)}
                    </TableCell>
                    <TableCell className="text-right">
                      {jpy(h.marketValueJpy)}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium ${pnlColor(h.unrealizedPnlJpy)}`}
                    >
                      {signedJpy(h.unrealizedPnlJpy)}
                      <span className="block text-xs">
                        {pct(h.unrealizedPnlPct)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
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
        <CardTitle className={`text-2xl tabular-nums ${color ?? ""}`}>
          {value}
        </CardTitle>
      </CardHeader>
      {sub && (
        <CardContent className="pt-0">
          <span className={`text-sm font-medium ${color ?? ""}`}>{sub}</span>
        </CardContent>
      )}
    </Card>
  );
}
