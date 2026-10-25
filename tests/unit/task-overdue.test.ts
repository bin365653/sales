import { describe, expect, it } from "vitest";
import {
  isTaskDueToday,
  isTaskOverdue,
  startOfShanghaiDay,
  taskOverdueDays,
} from "@/lib/tasks";

// T07 验收项「逾期判定跨日正确」的固化：
// 逾期 = 待处理且截止日早于今天（Asia/Shanghai 日界，C13）——
// 截止日当天整天都算今日任务，跨入次日才转逾期；跨月/跨年按日历日差计算。

/** 构造上海时区某时刻的 UTC Date（"2026-10-25 14:30" → +08:00 解释） */
function shanghai(value: string): Date {
  return new Date(`${value.replace(" ", "T")}+08:00`);
}

describe("isTaskOverdue：跨日边界", () => {
  it("昨天 23:59 截止，今天 00:00 起算逾期（跨日判定）", () => {
    const due = shanghai("2026-10-24 23:59");
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-25 00:00"))).toBe(true);
    // 截止日当天最后一刻仍不算逾期
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-24 23:59"))).toBe(false);
  });

  it("今天 00:00 截止，当天任意时刻都不算逾期；次日整点转逾期", () => {
    const due = shanghai("2026-10-25 00:00");
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-25 23:59"))).toBe(false);
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-26 00:00"))).toBe(true);
  });

  it("截止时刻已过但仍属当天：不算逾期（按日界而非时刻）", () => {
    const due = shanghai("2026-10-25 09:00");
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-25 18:00"))).toBe(false);
  });

  it("跨月边界：9 月最后一天截止，10 月 1 日逾期 1 天", () => {
    const due = shanghai("2026-09-30 23:59");
    expect(isTaskOverdue(due, "pending", shanghai("2026-10-01 08:00"))).toBe(true);
    expect(taskOverdueDays(due, shanghai("2026-10-01 08:00"))).toBe(1);
  });

  it("跨年边界：12 月 31 日截止，1 月 1 日逾期 1 天", () => {
    const due = shanghai("2025-12-31 12:00");
    expect(isTaskOverdue(due, "pending", shanghai("2026-01-01 00:00"))).toBe(true);
    expect(taskOverdueDays(due, shanghai("2026-01-01 00:00"))).toBe(1);
  });

  it("已完成/已取消的任务永远不逾期", () => {
    const due = shanghai("2026-10-01 09:00");
    expect(isTaskOverdue(due, "done", shanghai("2026-10-25 10:00"))).toBe(false);
    expect(isTaskOverdue(due, "canceled", shanghai("2026-10-25 10:00"))).toBe(false);
  });
});

describe("taskOverdueDays：日历日差", () => {
  it("逾期 N 天 = 今天与截止日的上海日历日差（≥1）", () => {
    const due = shanghai("2026-10-20 14:00");
    expect(taskOverdueDays(due, shanghai("2026-10-25 10:00"))).toBe(5);
    // 逾期不足整天也按 1 天计（跨了日界）
    expect(taskOverdueDays(due, shanghai("2026-10-21 00:01"))).toBe(1);
  });

  it("未逾期（截止日在未来/今天）返回负数或 0，仅用于内部比较", () => {
    expect(taskOverdueDays(shanghai("2026-10-25 09:00"), shanghai("2026-10-25 10:00"))).toBe(0);
  });
});

describe("isTaskDueToday", () => {
  it("截止日 = 今天（上海）无论时刻先后都算今日任务", () => {
    expect(isTaskDueToday(shanghai("2026-10-25 08:00"), shanghai("2026-10-25 20:00"))).toBe(true);
    expect(isTaskDueToday(shanghai("2026-10-25 23:59"), shanghai("2026-10-25 00:01"))).toBe(true);
    expect(isTaskDueToday(shanghai("2026-10-24 23:59"), shanghai("2026-10-25 00:00"))).toBe(false);
  });
});

describe("startOfShanghaiDay：查询边界（UTC 换算）", () => {
  it("上海 00:00 = UTC 前一日 16:00", () => {
    expect(startOfShanghaiDay(0, shanghai("2026-10-25 10:00")).toISOString()).toBe(
      "2026-10-24T16:00:00.000Z",
    );
  });

  it("+1 日得到明日 00:00；跨月/跨年正确", () => {
    expect(startOfShanghaiDay(1, shanghai("2026-10-25 10:00")).toISOString()).toBe(
      "2026-10-25T16:00:00.000Z",
    );
    expect(startOfShanghaiDay(1, shanghai("2026-10-31 10:00")).toISOString()).toBe(
      "2026-10-31T16:00:00.000Z", // 11-01 00:00 +08
    );
    expect(startOfShanghaiDay(1, shanghai("2025-12-31 10:00")).toISOString()).toBe(
      "2025-12-31T16:00:00.000Z", // 01-01 00:00 +08
    );
  });
});
