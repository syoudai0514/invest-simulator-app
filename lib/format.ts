/** 円フォーマット（小数なし）。 */
export function jpy(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

/** パーセント（符号付き）。 */
export function pct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** 符号付き円。 */
export function signedJpy(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${jpy(n)}`;
}

/** 損益の正負に応じた Tailwind テキストカラークラス。 */
export function pnlColor(n: number | null | undefined): string {
  if (n == null || n === 0) return "text-muted-foreground";
  return n > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
}

/** 日時を読みやすく整形。 */
export function fmtDate(iso: string): string {
  // SQLite の datetime('now') は UTC なので Z を補う
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return d.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
