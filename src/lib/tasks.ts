// 任务类型 / 状态文案与逾期判定（T07，PRD §5.7 / UIUX P6 / 决策 C13）。
//
// 逾期判定口径（验收项"逾期判定跨日正确"）：
// - 按 Asia/Shanghai 日界（而非当前时刻）判定：截止日早于今天才算逾期；
//   截止日当天的任务整天都算"今日任务"，跨入次日才转逾期——
//   早上的逾期名单在一天内稳定，不会随当前时刻抖动（C13 时区口径）；
// - 已逾期天数 = 今天与截止日的上海日历日差（≥1，跨月/跨年天然正确）。

import { toShanghaiDateString } from "@/lib/format";

export const TASK_TYPES = [
  "first_contact",
  "follow_up",
  "needs_diag",
  "online_demo",
  "offline_visit",
  "quote_follow",
  "revive",
] as const;

export type TaskTypeValue = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskTypeValue, string> = {
  first_contact: "首次联系",
  follow_up: "再次联系",
  needs_diag: "需求诊断",
  online_demo: "线上演示",
  offline_visit: "线下拜访",
  quote_follow: "商务报价跟进",
  revive: "暂缓客户激活",
};

export const TASK_STATUSES = [
  "pending",
  "done",
  "canceled",
] as const;

export type TaskStatusValue = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatusValue, string> = {
  pending: "待处理",
  done: "已完成",
  canceled: "已取消",
};

export const TASK_STATUS_BADGE_CLASS: Record<TaskStatusValue, string> = {
  pending: "bg-blue-50 text-blue-700",
  done: "bg-emerald-50 text-emerald-700",
  canceled: "bg-gray-100 text-gray-500",
};

/** 某一时刻的上海"日序号"（自纪元起的天数），供跨日比较 */
function shanghaiDayIndex(date: Date): number {
  const [year, month, day] = toShanghaiDateString(date)
    .split("-")
    .map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/** 任务是否逾期：待处理且截止日在今天（上海）之前 */
export function isTaskOverdue(
  dueAt: Date,
  status: TaskStatusValue,
  now: Date = new Date(),
): boolean {
  return status === "pending" && shanghaiDayIndex(dueAt) < shanghaiDayIndex(now);
}

/** 已逾期天数（≥1）：今天与截止日的上海日历日差 */
export function taskOverdueDays(dueAt: Date, now: Date = new Date()): number {
  return shanghaiDayIndex(now) - shanghaiDayIndex(dueAt);
}

/** 截止日是否为今天（上海），无论时刻先后 */
export function isTaskDueToday(dueAt: Date, now: Date = new Date()): boolean {
  return shanghaiDayIndex(dueAt) === shanghaiDayIndex(now);
}

/**
 * 上海时区"今天 ± offset 日"的 00:00 对应的 UTC 时刻。
 * 今日/逾期视图的查询边界：[今日 00:00, 明日 00:00) 为今天，
 * 早于今日 00:00 为逾期（任务中心视图与服务端列表共用同一实现）。
 */
export function startOfShanghaiDay(
  dayOffsetFromToday: number,
  now: Date = new Date(),
): Date {
  const [year, month, day] = toShanghaiDateString(now)
    .split("-")
    .map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1, day + dayOffsetFromToday));
  const dayString = `${target.getUTCFullYear()}-${String(
    target.getUTCMonth() + 1,
  ).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
  return new Date(`${dayString}T00:00:00+08:00`);
}
