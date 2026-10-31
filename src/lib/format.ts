// 前后端共享的展示工具（T04）：枚举文案、Asia/Shanghai 日期格式化。
// 统一走 Intl +固定时区，不依赖运行环境本地时区（决策 C13）。

// V2.0（P2）：四态核实状态——新增 stated（客户自述待复核，蓝 CircleUserRound）。
export type FactStatus = "unknown" | "unverified" | "stated" | "confirmed";
export type LeadPriority = "high" | "mid" | "low";

export const FACT_STATUS_LABELS: Record<FactStatus, string> = {
  unknown: "未知",
  unverified: "待核实",
  stated: "客户自述待复核",
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

/** 徽标配色：核实状态 / 优先级（Tailwind 静态类，便于 JIT 扫描）。
 * stated = 蓝（客户自述待复核，UIUX §3.2 CircleUserRound 蓝） */
export const FACT_STATUS_BADGE_CLASS: Record<FactStatus, string> = {
  unknown: "bg-gray-100 text-gray-500",
  unverified: "bg-amber-50 text-amber-700",
  stated: "bg-blue-50 text-blue-700",
  confirmed: "bg-emerald-50 text-emerald-700",
};

/** 核实徽章 tooltip（UIUX §7.2 红线文案）：stated 按已确认处理但建议复核 */
export const FACT_STATUS_HINTS: Record<FactStatus, string> = {
  unknown: "暂无该字段的信息，未知不会被当作「否」",
  unverified: "已记录该字段的值，尚未核实",
  stated: "客户在沟通中自述，尚未二次复核；分类按已确认处理，建议尽快复核",
  confirmed: "该字段已人工核实",
};

export const PRIORITY_BADGE_CLASS: Record<LeadPriority, string> = {
  high: "bg-red-50 text-red-700",
  mid: "bg-blue-50 text-blue-700",
  low: "bg-gray-100 text-gray-500",
};

// ---------- 工作台展示辅助（T12，P2） ----------

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 上海日历日的星期文案（"周一"…"周日"） */
export function shanghaiWeekdayLabel(date: Date): string {
  const dayString = toShanghaiDateString(date);
  const weekday = new Date(`${dayString}T00:00:00Z`).getUTCDay();
  return WEEKDAY_LABELS[weekday] ?? "";
}

/**
 * 相对时间文案（工作台「最近沟通记录」，UIUX P2"2小时前"）：
 * <1 分钟"刚刚"；<1 小时"N 分钟前"；<24 小时"N 小时前"；
 * <48 小时"昨天 HH:mm"；同年"MM-DD HH:mm"；跨年"YYYY-MM-DD HH:mm"。均为上海时区。
 */
export function formatRelativeShanghai(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diffMs < minuteMs) {
    return "刚刚";
  }
  if (diffMs < hourMs) {
    return `${Math.floor(diffMs / minuteMs)} 分钟前`;
  }
  if (diffMs < dayMs) {
    return `${Math.floor(diffMs / hourMs)} 小时前`;
  }
  if (diffMs < 2 * dayMs) {
    const time = toShanghaiDateTimeString(date).slice(11);
    return `昨天 ${time}`;
  }
  const full = toShanghaiDateTimeString(date);
  const currentYear = toShanghaiDateString(now).slice(0, 4);
  return full.slice(0, 4) === currentYear ? full.slice(5) : full;
}

/** 一句话摘要：拍平换行/多余空白并截断（工作台最近沟通、优先客户备注类展示） */
export function oneLineSnippet(text: string | null, maxLength: number): string | null {
  if (text === null) {
    return null;
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return null;
  }
  // 按码点截断，避免中文/emoji 撕裂
  const chars = Array.from(flat);
  if (chars.length <= maxLength) {
    return flat;
  }
  return `${chars.slice(0, maxLength).join("")}…`;
}
