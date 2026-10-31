// 软件到期时间：月粒度口径（V2.0-T03/T04，决策 P4）。
//
// - 复用 leads.contract_expiry（@db.Date）；输入/展示精度 = 年月（YYYY-MM）；
// - 输入归一化：YYYY-MM → 当月 1 日；YYYY（年）→ 当年 12 月（UIUX §4.6：
//   直接键入 2026 → 归一为 2026-12）；YYYY-MM-DD 沿用 V1.0 原样入库；
// - 买断客户统一 2099-12（BUYOUT_MONTH，UIUX 红线文案）；
// - 窗口比较按月粒度（双方 floor 到月，§4.2）：
//   已过期 E < M ｜ 半年内 M ≤ E ≤ M+6（含第 6 个月边界）｜ 超半年 E > M+6 ｜ 未知 null。

export const BUYOUT_EXPIRY_MONTH = "2099-12";
/** 买断落库值：2099-12-01（@db.Date 按当月 1 日存储，P4） */
export const BUYOUT_EXPIRY_DATE = "2099-12-01";

/** 纯日期（@db.Date，UTC 口径）→ "YYYY-MM" */
export function toExpiryMonth(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** "YYYY-MM" → 当月 1 日的 Date（@db.Date UTC 存储） */
export function expiryMonthToUtcDate(month: string): Date {
  return new Date(`${month}-01T00:00:00.000Z`);
}

/**
 * 到期输入归一化（Schema 层共用）：
 * "2027-06" → "2027-06-01"；"2027" → "2027-12-01"；
 * "2027-06-30" 原样；非法输入原样返回（由日期合法性校验报错）。
 */
export function normalizeExpiryInput(value: string): string {
  const text = value.trim();
  if (/^\d{4}-\d{2}$/.test(text)) {
    return `${text}-01`;
  }
  if (/^\d{4}$/.test(text)) {
    return `${text}-12-01`;
  }
  return text;
}

/** 当前月的 "YYYY-MM"（上海日历日口径，P4/决策 C13 一致按上海取月） */
export function currentExpiryMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(now);
  return parts; // en-CA → "YYYY-MM"
}

/** "YYYY-MM" 加 N 个月（溢出进位） */
export function addExpiryMonths(month: string, months: number): string {
  const [year, mon] = month.split("-").map(Number);
  const total = (year ?? 1970) * 12 + ((mon ?? 1) - 1) + months;
  const newYear = Math.floor(total / 12);
  const newMon = (total % 12) + 1;
  return `${String(newYear).padStart(4, "0")}-${String(newMon).padStart(2, "0")}`;
}

export type ExpiryWindow = "expired" | "within_6m" | "beyond_6m" | "unknown";

/**
 * 到期窗口判定（月粒度，§4.2；"半年内"含第 6 个月边界，已过期 = E < M）。
 * expiry 非空但核实状态 unknown 按「未知」处理（调用方传 status）。
 */
export function expiryWindow(
  expiry: Date | null | undefined,
  now: Date,
  options: { status?: string | null } = {},
): ExpiryWindow {
  if (!expiry || options.status === "unknown") {
    return "unknown";
  }
  const expiryMonth = toExpiryMonth(expiry);
  const currentMonth = currentExpiryMonth(now);
  const upperBound = addExpiryMonths(currentMonth, 6);
  if (expiryMonth < currentMonth) {
    return "expired";
  }
  if (expiryMonth <= upperBound) {
    return "within_6m";
  }
  return "beyond_6m";
}

/** 到期窗口的展示文案（ExpiryChip 与筛选 chip 共用） */
export function expiryWindowLabel(window: ExpiryWindow): string {
  switch (window) {
    case "expired":
      return "已过期";
    case "within_6m":
      return "6 个月内到期";
    case "beyond_6m":
      return "超半年";
    default:
      return "到期时间未知";
  }
}

/**
 * ExpiryChip 展示值："2026-12 · 6 个月内到期" ｜ "2026-10 · 已过期" ｜
 * "2099-12（买断）" ｜ "到期时间未知 · 待核实"。
 */
export function formatExpiryChip(
  expiry: Date | null | undefined,
  now: Date,
  options: { status?: string | null } = {},
): string {
  const window = expiryWindow(expiry, now, options);
  if (window === "unknown") {
    return "到期时间未知 · 待核实";
  }
  const month = toExpiryMonth(expiry!);
  if (month === BUYOUT_EXPIRY_MONTH) {
    return `${month}（买断）`;
  }
  return `${month} · ${expiryWindowLabel(window)}`;
}
