"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
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
import { jpy, fmtDate } from "@/lib/format";
import type { Transaction } from "@/lib/types";
import { Bot, User, ChevronDown, Loader2 } from "lucide-react";

type Filter = "ALL" | "AI" | "MANUAL";

export default function HistoryPage() {
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const q = filter === "ALL" ? "" : `?source=${filter}`;
    const json = await fetch(`/api/history${q}`).then((r) => r.json());
    setTxs(json.transactions ?? []);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">取引履歴</h1>
          <p className="text-sm text-muted-foreground">
            すべての売買が SQLite に記録されています
          </p>
        </div>
        <div className="flex gap-1">
          {(["ALL", "AI", "MANUAL"] as Filter[]).map((f) => (
            <Button
              key={f}
              size="sm"
              variant={filter === f ? "default" : "outline"}
              onClick={() => setFilter(f)}
            >
              {f === "ALL" ? "すべて" : f === "AI" ? "AI" : "手動"}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">取引一覧（{txs.length}件）</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : txs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              取引履歴はまだありません。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>銘柄</TableHead>
                  <TableHead>区分</TableHead>
                  <TableHead className="text-right">株数</TableHead>
                  <TableHead className="text-right">約定単価</TableHead>
                  <TableHead className="text-right">総額</TableHead>
                  <TableHead>実行</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {txs.map((t) => (
                  <Fragment key={t.id}>
                    <TableRow>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {fmtDate(t.createdAt)}
                      </TableCell>
                      <TableCell className="font-medium">{t.ticker}</TableCell>
                      <TableCell>
                        <Badge
                          className={
                            t.action === "BUY"
                              ? "bg-emerald-600 hover:bg-emerald-600"
                              : "bg-rose-600 hover:bg-rose-600"
                          }
                        >
                          {t.action === "BUY" ? "買" : "売"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{t.shares}</TableCell>
                      <TableCell className="text-right">
                        {jpy(t.priceJpy)}
                      </TableCell>
                      <TableCell className="text-right">
                        {jpy(t.totalJpy)}
                      </TableCell>
                      <TableCell>
                        {t.source === "AI" ? (
                          <span className="flex items-center gap-1 text-xs text-violet-400">
                            <Bot className="h-3.5 w-3.5" /> AI
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <User className="h-3.5 w-3.5" /> 手動
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {t.aiReasoning && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setExpanded(expanded === t.id ? null : t.id)
                            }
                          >
                            理由
                            <ChevronDown
                              className={`h-4 w-4 transition-transform ${expanded === t.id ? "rotate-180" : ""}`}
                            />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded === t.id && t.aiReasoning && (
                      <TableRow>
                        <TableCell colSpan={8} className="bg-muted/40">
                          <p className="py-2 text-sm leading-relaxed">
                            <span className="font-medium text-violet-400">
                              Claude の判断理由:{" "}
                            </span>
                            {t.aiReasoning}
                          </p>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
