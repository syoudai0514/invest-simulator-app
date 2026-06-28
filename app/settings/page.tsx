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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { WatchlistItem } from "@/lib/types";
import { Loader2, Plus, Trash2 } from "lucide-react";

export default function SettingsPage() {
  const [interval, setIntervalMin] = useState(60);
  const [initialCash, setInitialCash] = useState(1000000);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [newTicker, setNewTicker] = useState("");
  const [adding, setAdding] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [s, st, wl] = await Promise.all([
      fetch("/api/scheduler").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/watchlist").then((r) => r.json()),
    ]);
    setIntervalMin(s.intervalMinutes);
    setInitialCash(st.initialCash);
    setWatchlist(wl.watchlist ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- マウント時のデータ取得（標準パターン）
    load();
  }, [load]);

  async function saveInterval() {
    await fetch("/api/scheduler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalMinutes: interval }),
    });
    toast.success(`自動売買間隔を ${interval} 分に設定しました`);
  }

  async function addTicker() {
    if (!newTicker.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: newTicker }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error);
      toast.success(`${json.ticker} を追加しました`);
      setNewTicker("");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  async function removeTicker(ticker: string) {
    await fetch(`/api/watchlist?ticker=${encodeURIComponent(ticker)}`, {
      method: "DELETE",
    });
    toast.success(`${ticker} を削除しました`);
    await load();
  }

  async function resetAccount() {
    if (
      !confirm(
        "資金をリセットすると、すべての保有銘柄と取引履歴が削除されます。よろしいですか？",
      )
    )
      return;
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialCash }),
    });
    toast.success("アカウントをリセットしました");
    await load();
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">設定</h1>
        <p className="text-sm text-muted-foreground">
          自動売買・ウォッチリスト・資金の管理
        </p>
      </div>

      {/* ウォッチリスト */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ウォッチリスト</CardTitle>
          <CardDescription>
            AIが売買判断の対象とする銘柄。米国株は <code>AAPL</code>、日本株は{" "}
            <code>7203.T</code> 形式。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="ティッカーを追加（例: MSFT / 6758.T）"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTicker()}
            />
            <Button onClick={addTicker} disabled={adding}>
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              追加
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {watchlist.map((w) => (
              <Badge
                key={w.ticker}
                variant="secondary"
                className="gap-1.5 py-1.5 pl-3 pr-1.5 text-sm"
              >
                {w.ticker}
                <span className="text-[10px] text-muted-foreground">
                  {w.market}
                </span>
                <button
                  onClick={() => removeTicker(w.ticker)}
                  className="ml-1 rounded p-0.5 hover:bg-destructive/20"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {watchlist.length === 0 && (
              <p className="text-sm text-muted-foreground">
                銘柄がありません。
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 自動売買間隔 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">自動売買間隔</CardTitle>
          <CardDescription>
            自動売買がONのとき、この間隔ごとに Claude が判断します（分）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">間隔（分）</label>
            <Input
              type="number"
              min="1"
              className="w-32"
              value={interval}
              onChange={(e) => setIntervalMin(Number(e.target.value))}
            />
          </div>
          <Button onClick={saveInterval}>保存</Button>
        </CardContent>
      </Card>

      {/* 資金リセット */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-base">資金リセット</CardTitle>
          <CardDescription>
            保有銘柄と取引履歴をすべて削除し、指定額で再スタートします
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-end gap-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              初期資金（円）
            </label>
            <Input
              type="number"
              min="1"
              step="100000"
              className="w-40"
              value={initialCash}
              onChange={(e) => setInitialCash(Number(e.target.value))}
            />
          </div>
          <Button variant="destructive" onClick={resetAccount}>
            <Trash2 className="h-4 w-4" /> リセット
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
