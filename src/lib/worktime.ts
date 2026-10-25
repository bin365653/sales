// 每日工时周历工具（T11，K5/C03；C13 周一为周起点、Asia/Shanghai 日历）。
// 输入输出均为纯日期字符串 "YYYY-MM-DD"（上海日历日），内部用 UTC 日历数学——
// 纯日期不含时刻，无时区换算问题（与 leads.contract_expiry 同口径）。
// 周历视图（UIUX P9"每日工时"：周一~周日 7 格）、周起点的看板聚合（T12/T13）共用。

export const WORKWEEK_DAY_LABELS = [
  "周一",
  "周二",
  "周三",
  "周四",
  "周五",
  "周六",
  "周日",
] as const;

function parseUtcDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`非法日期字符串：${value}`);
  }
  return parsed;
}

/** 纯日期 ± N 天（跨月/跨年/闰年由 Date 自身进位保证） */
export function shiftDateString(value: string, days: number): string {
  const base = parseUtcDate(value);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** 某日所在周的周一（C13 周起点）；周一传入返回自身 */
export function workweekStart(value: string): string {
  const base = parseUtcDate(value);
  // getUTCDay(): 周日=0 … 周六=6 → 换算为周一=0 … 周日=6
  const offset = (base.getUTCDay() + 6) % 7;
  return shiftDateString(value, -offset);
}

/** 周一的完整 7 天（周一 → 周日）；元组类型在编译期固定长度，下标访问不引入 undefined */
export type WorkweekDays = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export function workweekDays(weekStart: string): WorkweekDays {
  return [
    shiftDateString(weekStart, 0),
    shiftDateString(weekStart, 1),
    shiftDateString(weekStart, 2),
    shiftDateString(weekStart, 3),
    shiftDateString(weekStart, 4),
    shiftDateString(weekStart, 5),
    shiftDateString(weekStart, 6),
  ];
}
