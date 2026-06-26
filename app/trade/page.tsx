"use client";

import { useState } from "react";
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
import { StockChart } from "@/components/stock-chart";
import { jpy, pct, pnlColor } from "@/lib/format";
import { Search, Loader2 } from "lucide-react";

interface Quote {
  ticker: string;
  name: string;
  market: string;
  currency: string;
  price: number;
  priceJpy: number;
  changePercent: number | null;
}

const RANGES = ["1mo", "3mo", "6mo", "1y"];

export default function TradePage() {
  const [input, setInput] = useState("");
  const [range, setRange] = useState("3mo");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [chart, setChart] = useState<{ date: string; close: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [shares, setShares] = useState("1");
  const [trading, setTrading] = useState(false);

  async function search(ticker = input, r = range) {
    if (!ticker.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/stock/${encodeURIComponent(ticker.trim())}?range=${r}`,
      );
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setQuote(json.quote);
      setChart(json.chart);
    } catch (e) {
      toast.error(`取得失敗: ${(e as Error).message}`);
      setQuote(null);
      setChart([]);
    } finally {
      setLoading(false);
    }
  }

  async function trade(action: "BUY" | "SELL") {
    if (!quote) return;
    const n = Number(shares);
    if (!n || n <= 0) {
      toast.error("株数を正しく入力してください");
      return;
    }
    setTrading(true);
    try {
      const res = await fetch("/api/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: quote.ticker, action, shares: n }),
      });
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || json.message);
      toast.success(json.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTrading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">売買・チャート</h1>
        <p className="text-sm text-muted-foreground">
          ティッカーで検索（米国株は <code>AAPL</code>、日本株は{" "}
          <code>7203.T</code> 形式）
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 pt-6">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="例: AAPL / NVDA / 7203.T"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
          </div>
          <Button onClick={() => search()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            検索
          </Button>
        </CardContent>
      </Card>

      {quote && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {quote.ticker}
                  <Badge variant="outline">{quote.market}</Badge>
                </CardTitle>
                <CardDescription>{quote.name}</CardDescription>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold tabular-nums">
                  {quote.price.toLocaleString()} {quote.currency}
                </div>
                <div className="text-sm text-muted-foreground">
                  ≈ {jpy(quote.priceJpy)} ・{" "}
                  <span className={pnlColor(quote.changePercent)}>
                    {pct(quote.changePercent)}
                  </span>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={range === r ? "default" : "outline"}
                  onClick={() => {
                    setRange(r);
                    search(quote.ticker, r);
                  }}
                >
                  {r}
                </Button>
              ))}
            </div>
            <StockChart data={chart} currency={quote.currency} />

            {/* 売買フォーム */}
            <div className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">株数</label>
                <Input
                  type="number"
                  min="1"
                  className="w-28"
                  value={shares}
                  onChange={(e) => setShares(e.target.value)}
                />
              </div>
              <div className="text-sm text-muted-foreground">
                概算: {jpy(quote.priceJpy * Number(shares || 0))}
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  className="bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => trade("BUY")}
                  disabled={trading}
                >
                  買う
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => trade("SELL")}
                  disabled={trading}
                >
                  売る
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
