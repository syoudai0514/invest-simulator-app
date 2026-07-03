"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EquityChart } from "@/components/equity-chart";
import { jpy, pct, signedJpy, pnlColor } from "@/lib/format";
import type { PortfolioResponse, MarketBlock, ActivityResponse, MarketActivity } from "@/lib/types";
import {
  RefreshCw, Loader2, Bot, ShieldCheck, ShieldAlert, ArrowUpRight, ArrowDownRight,
  CircleDollarSign, Wallet, PiggyBank,
} from "lucide-react";

const STOP_PCT = -8;
const TP_PCT = 10;

export default function Dashboard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [act, setAct] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([
        fetch("/api/portfolio").then((r) => r.json()),
        fetch("/api/activity").then((r) => r.json()),
      ]);
      if (p.error) throw new Error(p.error);
      setData(p);
      setAct(a.error ? null : a);
      setUpdatedAt(new Date());
    } catch (e) {
      toast.error(`読み込み失敗: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- マウント時のデータ取得（標準パターン）
    load();
    const id = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) load();
    }, 30000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!data) return null;
  const { combined, markets } = data;
  const pnlUp = combined.totalPnlJpy >= 0;

  return (
    <div className="space-y-6">
      {/* ヘッダー */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">ダッシュボード</h1>
          <p className="text-sm text-muted-foreground">
            米国・日本を各100万円で自動運用（判断は毎営業日1回・リスク管理は日次＋緊急時）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1.5 py-1.5 text-muted-foreground">
            <Bot className="h-3.5 w-3.5" /> 5分間隔で自動実行
          </Badge>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            {updatedAt ? updatedAt.toLocaleTimeString("ja-JP") : "更新"}
          </Button>
        </div>
      </div>

      {/* ヒーロー: 合計損益 */}
      <Card className="overflow-hidden">
        <CardContent className="flex flex-wrap items-end justify-between gap-6 py-6">
          <div>
            <p className="text-sm text-muted-foreground">合計損益（初期 {jpy(combined.initialCash)}）</p>
            <div className={`mt-1 flex items-baseline gap-3 ${pnlUp ? "text-[#0ca30c]" : "text-[#e66767]"}`}>
              <span className="text-4xl font-bold tracking-tight">
                {signedJpy(combined.totalPnlJpy)}
              </span>
              <span className="flex items-center text-lg font-medium">
                {pnlUp ? <ArrowUpRight className="h-5 w-5" /> : <ArrowDownRight className="h-5 w-5" />}
                {pct(combined.totalPnlPct)}
              </span>
            </div>
          </div>
          <div className="flex gap-8">
            <HeroStat icon={<CircleDollarSign className="h-4 w-4" />} label="総資産" value={jpy(combined.totalValueJpy)} />
            <HeroStat icon={<Wallet className="h-4 w-4" />} label="現金" value={jpy(combined.cashJpy)} />
            <HeroStat icon={<PiggyBank className="h-4 w-4" />} label="保有評価" value={jpy(combined.holdingsValueJpy)} />
          </div>
        </CardContent>
      </Card>

      <MarketSection label="米国市場" flag="🇺🇸" bench="SPY" block={markets.US} activity={act?.US} />
      <MarketSection label="日本市場" flag="🇯🇵" bench="N225" block={markets.JP} activity={act?.JP} />

      <CriteriaCard />
    </div>
  );
}

function HeroStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function MarketSection({
  label, flag, bench, block, activity,
}: {
  label: string; flag: string; bench: string; block: MarketBlock; activity?: MarketActivity;
}) {
  const riskOff = activity?.regime?.riskOff;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">{flag}</span>
            <CardTitle className="text-base">{label}</CardTitle>
            {activity?.regime &&
              (riskOff ? (
                <Badge variant="outline" className="gap-1 border-[#e66767]/40 text-[#e66767]">
                  <ShieldAlert className="h-3 w-3" /> リスクオフ・新規買い停止
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-[#0ca30c]/40 text-[#0ca30c]">
                  <ShieldCheck className="h-3 w-3" /> リスクオン・通常運用
                </Badge>
              ))}
          </div>
          <div className="flex items-center gap-5 text-sm tabular-nums">
            <span className="text-muted-foreground">総資産 <b className="text-foreground">{jpy(block.totalValueJpy)}</b></span>
            <span className="text-muted-foreground">現金 <b className="text-foreground">{jpy(block.cashJpy)}</b></span>
            <span className={`font-semibold ${pnlColor(block.totalPnlJpy)}`}>
              {signedJpy(block.totalPnlJpy)}（{pct(block.totalPnlPct)}）
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <EquityChart snapshots={block.snapshots} initialCash={block.initialCash} benchLabel={bench} />

        {block.holdings.length === 0 ? (
          <p className="rounded-lg border border-dashed py-5 text-center text-sm text-muted-foreground">
            {riskOff ? "リスクオフのため現金で待機中（地合い回復で買い再開）" : "保有銘柄はありません（次の買い場を待機中）"}
          </p>
        ) : (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">保有銘柄 — バーは損切り(-8%)〜利確(+10%)の現在位置</p>
            <Table>
              <TableHeader>
                <TableRow className="text-xs">
                  <TableHead>銘柄</TableHead>
                  <TableHead className="text-right">株数</TableHead>
                  <TableHead className="text-right">取得→現在</TableHead>
                  <TableHead className="w-[200px]">損切り ◄─► 利確</TableHead>
                  <TableHead className="text-right">評価損益</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {block.holdings.map((h) => (
                  <TableRow key={h.ticker}>
                    <TableCell className="font-medium">
                      {h.ticker}
                      <span className="block max-w-[180px] truncate text-xs font-normal text-muted-foreground">{h.name}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{h.shares}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {jpy(h.avgCostJpy)}
                      <span className="block text-foreground">{jpy(h.currentPriceJpy)}</span>
                    </TableCell>
                    <TableCell><RangeBar pnlPct={h.unrealizedPnlPct} /></TableCell>
                    <TableCell className={`text-right font-semibold tabular-nums ${pnlColor(h.unrealizedPnlJpy)}`}>
                      {signedJpy(h.unrealizedPnlJpy)}
                      <span className="block text-xs font-normal">{pct(h.unrealizedPnlPct)}</span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <ActivityFeed activity={activity} />
      </CardContent>
    </Card>
  );
}

/** 損切り(-8%)〜利確(+10%)の間で現在損益がどこにいるかを示すレンジバー。 */
function RangeBar({ pnlPct }: { pnlPct: number }) {
  const span = TP_PCT - STOP_PCT; // 18
  const posPct = Math.min(100, Math.max(0, ((pnlPct - STOP_PCT) / span) * 100));
  const zeroPct = ((0 - STOP_PCT) / span) * 100;
  const color = pnlPct <= STOP_PCT + 1.5 ? "#e66767" : pnlPct >= TP_PCT - 1.5 ? "#0ca30c" : "#3987e5";
  return (
    <div>
      <div className="relative h-2 w-full rounded-full bg-muted">
        <div className="absolute top-0 h-full w-px bg-border" style={{ left: `${zeroPct}%` }} />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
          style={{ left: `${posPct}%`, background: color }}
        />
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>-8%</span><span>0</span><span>+10%</span>
      </div>
    </div>
  );
}

function ActivityFeed({ activity }: { activity?: MarketActivity }) {
  if (!activity) return null;
  const trades = activity.trades.slice(0, 6);
  const rejected = activity.decisions
    .filter((d) => d.action === "BUY" && d.executed === 0 && d.rejectReason)
    .slice(0, 4);
  if (trades.length === 0 && rejected.length === 0) {
    return <p className="text-xs text-muted-foreground">まだ売買はありません。市場開場後、最初の判断がここに表示されます。</p>;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">直近の売買と理由</p>
        <ul className="space-y-1.5">
          {trades.map((t, i) => (
            <li key={i} className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-medium">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      t.action === "BUY" ? "bg-[#3987e5]/15 text-[#3987e5]" : "bg-[#e66767]/15 text-[#e66767]"
                    }`}
                  >
                    {t.action === "BUY" ? "買" : "売"}
                  </span>
                  {t.ticker} <span className="font-normal text-muted-foreground">{t.shares}株</span>
                </span>
                {t.realizedPnlJpy != null && (
                  <span className={`font-semibold tabular-nums ${pnlColor(t.realizedPnlJpy)}`}>{signedJpy(t.realizedPnlJpy)}</span>
                )}
              </div>
              {t.reasoning && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{t.reasoning}</p>}
              <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                {new Date(t.createdAt + "Z").toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
              </p>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">見送った銘柄と理由</p>
        {rejected.length === 0 ? (
          <p className="text-xs text-muted-foreground">直近の見送りはありません</p>
        ) : (
          <ul className="space-y-1.5">
            {rejected.map((d, i) => (
              <li key={i} className="rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs">
                <span className="font-medium">{d.ticker}</span>
                <span className="ml-1.5 text-[#eda100]">{d.rejectReason}</span>
                {d.reasoning && <p className="mt-0.5 line-clamp-1 text-muted-foreground">{d.reasoning}</p>}
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
        <CardTitle className="text-base">判断基準（いつ買う／売る？）</CardTitle>
        <CardDescription>
          売買判断はルールエンジン（決定論）、ニュースの読解のみLLM。すべて自動です。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="font-medium text-[#3987e5]">買う条件（毎営業日1回）</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>上昇トレンド（価格 &gt; 20日線 &gt; 50日線）かつRSIが過熱でない</li>
            <li>地合いがリスクオン（指数が20日線・200日線の上）のときだけ</li>
            <li>好材料ニュースは優先度アップ／悪材料は見送り（LLM読解）</li>
            <li>1銘柄20%まで・現金10%維持・1日最大3銘柄</li>
          </ul>
        </div>
        <div className="space-y-1.5">
          <p className="font-medium text-[#e66767]">売る・見送る条件</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li><b>-8%で損切り／+10%で利確</b>（判定は1日1回・バックテストと同粒度）</li>
            <li>-15%超の急落のみ即時の緊急ストップ</li>
            <li>手仕舞い後は同銘柄を5営業日買わない（買い直しチャーン防止）</li>
            <li>急騰しすぎ・急落中（落ちるナイフ）・低位株は買わない</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
