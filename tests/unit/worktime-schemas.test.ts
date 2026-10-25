import { describe, expect, it } from "vitest";
import {
  workDateStringSchema,
  worktimeHoursSchema,
  worktimeQuerySchema,
} from "@/lib/schemas/worktime";

// T11 工时填报 Schema 固化（K5/C03/UIUX §4.9）：
// - 日期：纯日期 YYYY-MM-DD，格式严格 + 真实日历日（2 月 30 日、闰年错报拒绝）；
// - hours：0–24、0.5 步进（0.5 的倍数在二进制浮点下精确，v*2 整数判定安全）；
//   hours=0 合法（"当天未工作"），与"未填报"（无行）区分；
// - 查询参数 date / week 必须二选一（单日契约 / 周历视图）。

describe("workDateStringSchema：纯日期校验", () => {
  it.each(["2026-10-26", "2024-02-29", "2025-12-29"])("合法日期 %s 通过", (value) => {
    expect(workDateStringSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "2026-2-1", // 格式必须补零
    "2026-10-26T00:00:00Z", // 不接受时刻
    "2026/10/26", // 不接受斜杠
    "2026-13-01", // 月份越界
    "2026-00-10", // 月份为 0
    "2026-02-30", // 2 月 30 日
    "2026-02-29", // 非闰年的 2 月 29 日
    "2025-04-31", // 4 月 31 日
    "",
  ])("非法日期 %s 拒绝", (value) => {
    expect(workDateStringSchema.safeParse(value).success).toBe(false);
  });
});

describe("worktimeHoursSchema：0–24、0.5 步进", () => {
  it.each([0, 0.5, 7.5, 8, 23.5, 24])("合法工时 %s 通过", (value) => {
    const result = worktimeHoursSchema.safeParse(value);
    expect(result.success).toBe(true);
  });

  it.each([
    -0.5, // 负数
    24.5, // 超上限
    7.3, // 非 0.5 步进
    7.25, // 非 0.5 步进（四分之一小时）
    100,
    Number.NaN, // NaN 不是合法工时
    Number.POSITIVE_INFINITY,
  ])("非法工时 %s 拒绝", (value) => {
    expect(worktimeHoursSchema.safeParse(value).success).toBe(false);
  });

  it("非数字类型拒绝（不做字符串强转，body 必须给数字）", () => {
    expect(worktimeHoursSchema.safeParse("7.5").success).toBe(false);
  });

  it("错误信息为中文（与表单提示一字不差）", () => {
    expect(worktimeHoursSchema.safeParse(25).error?.issues[0]?.message).toBe(
      "工时不能超过 24",
    );
    expect(worktimeHoursSchema.safeParse(7.3).error?.issues[0]?.message).toBe(
      "工时需为 0.5 的整数倍",
    );
  });
});

describe("worktimeQuerySchema：date / week 二选一", () => {
  it("仅 date 通过（单日查询契约）", () => {
    const result = worktimeQuerySchema.safeParse({ date: "2026-10-26" });
    expect(result.success).toBe(true);
  });

  it("仅 week 通过（周历视图，周内任意一天定位）", () => {
    const result = worktimeQuerySchema.safeParse({ week: "2026-11-01" });
    expect(result.success).toBe(true);
  });

  it.each([{}, { date: "2026-10-26", week: "2026-10-26" }])(
    "缺失或同时提供两个参数拒绝：%j",
    (value) => {
      expect(worktimeQuerySchema.safeParse(value).success).toBe(false);
    },
  );

  it("参数本身必须是合法纯日期", () => {
    expect(worktimeQuerySchema.safeParse({ date: "明天" }).success).toBe(false);
  });
});
