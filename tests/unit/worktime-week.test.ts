import { describe, expect, it } from "vitest";
import {
  shiftDateString,
  workweekDays,
  workweekStart,
  WORKWEEK_DAY_LABELS,
} from "@/lib/worktime";

// T11 周历工具固化（C13：Asia/Shanghai 日历、周一为周起点；UIUX §4.9）。
// 输入输出均为纯日期字符串，跨月/跨年/闰年由 UTC 日历数学保证：
// - 2026-10-26 是周一（当周跨 10 月 → 11 月 1 日）；
// - 2026-12-28 是周一（当周跨 2026 → 2027 年 1 月 3 日）；
// - 2028-02-28 是周一（闰年，当周 2 月 28 日 → 3 月 5 日）。

describe("workweekStart：周一为起点", () => {
  it("周一传入返回自身", () => {
    expect(workweekStart("2026-10-26")).toBe("2026-10-26");
  });

  it("周内其余各天都归到同一周一（周日跨月）", () => {
    expect(workweekStart("2026-10-27")).toBe("2026-10-26");
    expect(workweekStart("2026-10-31")).toBe("2026-10-26");
    expect(workweekStart("2026-11-01")).toBe("2026-10-26");
  });

  it("跨年周：2027-01-01（周五）所在周从 2026-12-28 开始", () => {
    expect(workweekStart("2026-12-28")).toBe("2026-12-28");
    expect(workweekStart("2027-01-01")).toBe("2026-12-28");
    expect(workweekStart("2027-01-03")).toBe("2026-12-28");
  });

  it("闰年周：2028-02-29（周二）所在周从 2028-02-28 开始", () => {
    expect(workweekStart("2028-02-29")).toBe("2028-02-28");
  });

  it("任意输入日的周起点必为周一（多采样不变量）", () => {
    const samples = [
      "2026-01-01",
      "2026-06-15",
      "2026-10-26",
      "2027-03-08",
      "2028-02-29",
      "2025-12-29",
    ];
    for (const sample of samples) {
      const start = workweekStart(sample);
      const weekday = new Date(`${start}T00:00:00Z`).getUTCDay();
      expect(weekday, `${sample} → ${start} 应为周一`).toBe(1);
      expect(start <= sample && sample <= workweekDays(start)[6]).toBe(true);
    }
  });
});

describe("workweekDays：完整 7 天", () => {
  it("返回周一 → 周日连续 7 天，跨月正确", () => {
    expect(workweekDays("2026-10-26")).toEqual([
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
    ]);
  });

  it("跨年正确", () => {
    expect(workweekDays("2026-12-28")).toEqual([
      "2026-12-28",
      "2026-12-29",
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
      "2027-01-03",
    ]);
  });

  it("闰年 2 月正确（29 日计入）", () => {
    const days = workweekDays("2028-02-28");
    expect(days[0]).toBe("2028-02-28");
    expect(days[1]).toBe("2028-02-29");
    expect(days[6]).toBe("2028-03-05");
  });

  it("标签恰为 7 个中文星期", () => {
    expect(WORKWEEK_DAY_LABELS).toEqual([
      "周一",
      "周二",
      "周三",
      "周四",
      "周五",
      "周六",
      "周日",
    ]);
  });
});

describe("shiftDateString：纯日期加减天数", () => {
  it("跨月进位", () => {
    expect(shiftDateString("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDateString("2026-11-01", -1)).toBe("2026-10-31");
  });

  it("跨年进位", () => {
    expect(shiftDateString("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateString("2027-01-01", -1)).toBe("2026-12-31");
  });

  it("闰年 2 月 29 日参与进位", () => {
    expect(shiftDateString("2028-02-28", 1)).toBe("2028-02-29");
    expect(shiftDateString("2028-02-29", 1)).toBe("2028-03-01");
    expect(shiftDateString("2027-02-28", 1)).toBe("2027-03-01");
  });

  it("周切换：±7 天", () => {
    expect(shiftDateString("2026-10-26", -7)).toBe("2026-10-19");
    expect(shiftDateString("2026-10-26", 7)).toBe("2026-11-02");
  });
});
