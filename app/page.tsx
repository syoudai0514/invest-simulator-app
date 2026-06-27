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
import type { PortfolioResponse, MarketBlock, ActivityResponse, MarketActivity } from "@/lib/types";
import { RefreshCw, Loader2, TrendingUp, ShieldCheck, ShieldAlert } from "lucide-react";

export default function Dashboard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [act, setAct] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState(5);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s, a] = await Promise.all([
        fetch("/api/portfolio").then((r) => r.json()),
        fetch("/api/scheduler").then((r) => r.json()),
        fetch("/api/activity").then((r) => r.json()),
      ]);
      if (p.error) throw new Error(p.error);
      setData(p);
      setAct(a.error ? null : a);
      setAutoEnabled(s.autoEnabled);
      setIntervalMin(s.intervalMinutes);
      setUpdatedAt(new Date());
    } catch (e) {
      toast.error(`読み込み失敗: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // 初回ロード＋30秒ごとに自動更新（タブが非表示の間はスキップ）
  useEffect(() => {
    load();
    const id = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) load();
    }, 30000);
    return () => clearInterval(id);
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">ダッシュボード</h1>
          <p className="text-sm text-muted-foreground">
            米国・日本の2市場をそれぞれ仮想資金100万円でルールエンジンが自動運用
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            30秒ごと自動更新{updatedAt ? `・最終 ${updatedAt.toLocaleTimeString("ja-JP")}` : ""}
          </span>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" /> 更新
          </Button>
          <div className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
            <span className="text-sm">{autoEnabled ? "自動売買 稼働中" : "自動売買 停止中"}</span>
            <Switch checked={autoEnabled} onCheckedChange={toggleAuto} />
          </div>
        </div>
      </div>

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

      <MarketSection label="🇺🇸 米国市場" block={markets.US} activity={act?.US} interval={intervalMin} />
      <MarketSection label="🇯🇵 日本市場" block={markets.JP} activity={act?.JP} interval={intervalMin} />

      <CriteriaCard />
    </div>
  );
}

function MarketSection({ label, block, activity, interval }: { label: string; block: MarketBlock; activity?: MarketActivity; interval: number }) {
  const riskOff = activity?.regime?.riskOff;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{label}</CardTitle>
            {activity?.regime && (
              riskOff ? (
                <Badge variant="destructive" className="gap-1"><ShieldAlert className="h-3 w-3" />リスクオフ・新規買い停止中</Badge>
              ) : (
                <Badge className="gap-1 bg-emerald-600"><ShieldCheck className="h-3 w-3" />リスクオン・通常運用</Badge>
              )
            )}
          </div>
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

        {/* 保有銘柄＋手仕舞いライン */}
        {block.holdings.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">保有銘柄はありません（待機中）</p>
        ) : (
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">保有銘柄と手仕舞いライン</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>銘柄</TableHead>
                  <TableHead className="text-right">株数</TableHead>
                  <TableHead className="text-right">平均取得</TableHead>
                  <TableHead className="text-right">現在値</TableHead>
                  <TableHead className="text-right">評価損益</TableHead>
                  <TableHead className="text-right text-rose-500">損切り -8%</TableHead>
                  <TableHead className="text-right text-emerald-600">利確 +10%</TableHead>
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
                    <TableCell className={`text-right font-medium ${pnlColor(h.unrealizedPnlJpy)}`}>
                      {pct(h.unrealizedPnlPct)}
                    </TableCell>
                    <TableCell className="text-right text-rose-500 tabular-nums">{jpy(h.avgCostJpy * 0.92)}</TableCell>
                    <TableCell className="text-right text-emerald-600 tabular-nums">{jpy(h.avgCostJpy * 1.1)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-1 text-[11px] text-muted-foreground">※ 現在値が「損切りライン」を割れば自動売却（損切り）、「利確ライン」に届けば自動売却（利確）します。</p>
          </div>
        )}

        {/* 直近の動き */}
        <ActivityFeed activity={activity} />
      </CardContent>
    </Card>
  );
}

function ActivityFeed({ activity }: { activity?: MarketActivity }) {
  if (!activity) return null;
  const trades = activity.trades.slice(0, 6);
  // 直近で「却下/見送り」になった判断（理由つき）を数件
  const rejected = activity.decisions
    .filter((d) => d.action === "BUY" && d.executed === 0 && d.rejectReason)
    .slice(0, 4);

  if (trades.length === 0 && rejected.length === 0) {
    return <p className="text-xs text-muted-foreground">まだ売買はありません。市場開場後、最初の判断がここに表示されます。</p>;
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">直近の売買とその理由</div>
        {trades.length === 0 ? (
          <p className="text-xs text-muted-foreground">まだ売買なし</p>
        ) : (
          <ul className="space-y-1.5">
            {trades.map((t, i) => (
              <li key={i} className="rounded-md border px-2 py-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    <Badge variant={t.action === "BUY" ? "default" : "secondary"} className="mr-1 text-[10px]">{t.action === "BUY" ? "買い" : "売り"}</Badge>
                    {t.ticker} {t.shares}株
                  </span>
                  {t.realizedPnlJpy != null && (
                    <span className={pnlColor(t.realizedPnlJpy)}>{signedJpy(t.realizedPnlJpy)}</span>
                  )}
                </div>
                {t.reasoning && <p className="mt-0.5 text-muted-foreground">{t.reasoning}</p>}
                <p className="text-[10px] text-muted-foreground/70">{new Date(t.createdAt + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">見送った銘柄と理由</div>
        {rejected.length === 0 ? (
          <p className="text-xs text-muted-foreground">直近の見送りはありません</p>
        ) : (
          <ul className="space-y-1.5">
            {rejected.map((d, i) => (
              <li key={i} className="rounded-md border px-2 py-1.5 text-xs">
                <span className="font-medium">{d.ticker}</span>
                <span className="ml-1 text-muted-foreground">{d.rejectReason}</span>
                {d.reasoning && <p className="mt-0.5 text-[11px] text-muted-foreground/80">{d.reasoning}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CriteriaCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">このロジックの判断基準（いつ買う／売る？）</CardTitle>
        <CardDescription>すべて自動。ニュースの読解だけLLM、それ以外はルールで機械的に判断します。</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="font-medium text-emerald-600">買う条件</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>上昇トレンド（価格 &gt; 20日線 &gt; 50日線）でRSIが過熱でない</li>
            <li>地合いが「リスクオン」（指数が20日線かつ200日線の上）のときだけ新規買い</li>
            <li>好材料ニュースがあれば優先度アップ（LLMが読解）</li>
            <li>1銘柄は資産の20%まで・現金10%は常に残す・1日最大3銘柄</li>
          </ul>
        </div>
        <div className="space-y-1.5">
          <p className="font-medium text-rose-500">売る・見送る条件</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>保有が <b>-8%</b> で損切り、<b>+10%</b> で利確（自動）</li>
            <li>買われすぎ（RSI高）・下降トレンドに転じたら売り</li>
            <li>急騰しすぎ／急落中（落ちるナイフ）／低位株は買わない</li>
            <li>強い悪材料ニュースのある銘柄は買わない</li>
            <li>損切り直後の銘柄は5営業日買い戻さない</li>
          </ul>
        </div>
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
