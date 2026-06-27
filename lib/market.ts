/**
 * 米国株式市場の開場判定。
 * 夏時間(EDT)/冬時間(EST)の切り替えはランタイムのタイムゾーンDB
 * （America/New_York）に委ねるため、手動でのオフセット計算は不要。
 */

export interface MarketStatus {
  isOpen: boolean;
  reason: string; // 開場/閉場の理由（ログ・UI用）
  etTime: string; // 判定に用いた米東部時刻
}

/** 指定時刻（既定: 現在）における米国市場の開場状況を返す。 */
export function getUsMarketStatus(at: Date = new Date()): MarketStatus {
  // 米東部時間の曜日・時・分を取得
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday"); // "Mon".."Sun"
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // 一部環境で 24:00 表記になる対策
  const minute = parseInt(get("minute"), 10);
  const etTime = `${weekday} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ET`;

  // 週末は休場
  if (weekday === "Sat" || weekday === "Sun") {
    return { isOpen: false, reason: "週末のため休場", etTime };
  }

  // 通常取引時間 9:30–16:00 ET
  const minutesOfDay = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutesOfDay < open) {
    return { isOpen: false, reason: "寄り付き前（9:30 ET 前）", etTime };
  }
  if (minutesOfDay >= close) {
    return { isOpen: false, reason: "引け後（16:00 ET 以降）", etTime };
  }
  return { isOpen: true, reason: "通常取引時間", etTime };
}
