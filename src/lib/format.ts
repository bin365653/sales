// 前后端共享的展示工具（T04）：枚举文案、Asia/Shanghai 日期格式化。
// 统一走 Intl +固定时区，不依赖运行环境本地时区（决策 C13）。

export type FactStatus = "unknown" | "unverified" | "confirmed";
export type LeadPriority = "high" | "mid" | "low";

export const FACT_STATUS_LABELS: Record<FactStatus, string> = {
  unknown: "未知",
  unverified: "待核实",
  confirmed: "已确认",
};

export const PRIORITY_LABELS: Record<LeadPriority, string> = {
  high: "高",
  mid: "中",
  low: "低",
};

export const LEAD_EVENT_TYPE_LABELS: Record<string, string> = {
  created: "创建客户",
  imported: "导入创建",
  updated: "修改资料",
  stage_changed: "阶段流转",
  deleted: "删除客户",
};

const SHANGHAI_TZ = "Asia/Shanghai";

function shanghaiParts(date: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? "00";
}

/** timestamptz → 上海时区 "YYYY-MM-DD"（仅日期展示） */
export function toShanghaiDateString(date: Date): string {
  const parts = shanghaiParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

/** timestamptz → 上海时区 "YYYY-MM-DD HH:mm" */
export function toShanghaiDateTimeString(date: Date): string {
  const parts = shanghaiParts(date);
  return `${toShanghaiDateString(date)} ${part(parts, "hour")}:${part(parts, "minute")}`;
}

/** timestamptz → 上海时区 "YYYY-MM-DDTHH:mm"（datetime-local 输入框初值） */
export function toDateTimeInputValue(date: Date): string {
  return toShanghaiDateTimeString(date).replace(" ", "T");
}

/** 纯日期列（@db.Date，按 UTC 日期存储）→ "YYYY-MM-DD"；不能用上海时区取，会回退一天 */
export function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatFactStatus(status: string): string {
  return FACT_STATUS_LABELS[status as FactStatus] ?? status;
}

export function formatPriority(priority: string): string {
  return PRIORITY_LABELS[priority as LeadPriority] ?? priority;
}

/** 徽标配色：核实状态 / 优先级（Tailwind 静态类，便于 JIT 扫描） */
export const FACT_STATUS_BADGE_CLASS: Record<FactStatus, string> = {
  unknown: "bg-gray-100 text-gray-500",
  unverified: "bg-amber-50 text-amber-700",
  confirmed: "bg-emerald-50 text-emerald-700",
};

export const PRIORITY_BADGE_CLASS: Record<LeadPriority, string> = {
  high: "bg-red-50 text-red-700",
  mid: "bg-blue-50 text-blue-700",
  low: "bg-gray-100 text-gray-500",
};
