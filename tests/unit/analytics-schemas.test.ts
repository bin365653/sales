import { describe, expect, it } from "vitest";
import {
  analyticsQuerySchema,
  ANALYTIC_MAX_RANGE_DAYS,
} from "@/lib/schemas/analytics";

// T13 看板入参固化（PRD §5.9 / UIUX P7）：周期预设 + 自定义范围 + 圈选。
// 与项目同一哲学：非法入参拒绝（400），绝不静默忽略。

describe("analyticsQuerySchema：周期与自定义范围", () => {
  it("缺省 period = 本周（week）", () => {
    const parsed = analyticsQuerySchema.parse({});
    expect(parsed.period).toBe("week");
  });

  it("四种周期预设均接受", () => {
    for (const period of ["today", "week", "month", "custom"] as const) {
      const from = period === "custom" ? { from: "2027-03-01", to: "2027-03-31" } : {};
      expect(analyticsQuerySchema.parse({ period, ...from }).period).toBe(period);
    }
  });

  it("非法 period 拒绝", () => {
    expect(analyticsQuerySchema.safeParse({ period: "year" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ period: "" }).success).toBe(false);
  });

  it("custom 缺 from 或 to 拒绝", () => {
    expect(
      analyticsQuerySchema.safeParse({ period: "custom", from: "2027-03-01" })
        .success,
    ).toBe(false);
    expect(
      analyticsQuerySchema.safeParse({ period: "custom", to: "2027-03-31" })
        .success,
    ).toBe(false);
    expect(analyticsQuerySchema.safeParse({ period: "custom" }).success).toBe(
      false,
    );
  });

  it("custom from > to 拒绝", () => {
    expect(
      analyticsQuerySchema.safeParse({
        period: "custom",
        from: "2027-03-10",
        to: "2027-03-01",
      }).success,
    ).toBe(false);
  });

  it("custom 跨度超过上限拒绝；恰好上限通过", () => {
    const over = analyticsQuerySchema.safeParse({
      period: "custom",
      from: "2026-01-01",
      to: "2027-01-03", // 367 天
    });
    expect(over.success).toBe(false);

    // 恰好 ANALYTIC_MAX_RANGE_DAYS 跨度（含首尾）
    const to = new Date(
      Date.parse("2026-01-01T00:00:00Z") + ANALYTIC_MAX_RANGE_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    expect(
      analyticsQuerySchema.parse({ period: "custom", from: "2026-01-01", to })
        .to,
    ).toBe(to);
  });

  it("非 custom 预设携带 from/to 拒绝（不静默忽略）", () => {
    expect(
      analyticsQuerySchema.safeParse({ period: "week", from: "2027-03-01" })
        .success,
    ).toBe(false);
    expect(
      analyticsQuerySchema.safeParse({ period: "today", to: "2027-03-01" })
        .success,
    ).toBe(false);
  });

  it("日期不真实存在拒绝（2026-02-30）", () => {
    expect(
      analyticsQuerySchema.safeParse({
        period: "custom",
        from: "2026-02-30",
        to: "2026-03-01",
      }).success,
    ).toBe(false);
  });
});

describe("analyticsQuerySchema：圈选参数", () => {
  it("来源/行业/阶段/负责人正常接受", () => {
    const parsed = analyticsQuerySchema.parse({
      source: "转介绍",
      industry: "快消-酒水",
      stageId: "1b671a64-40d5-491e-99b0-da01ff1f3341",
      ownerId: "1b671a64-40d5-491e-99b0-da01ff1f3342",
    });
    expect(parsed.source).toBe("转介绍");
    expect(parsed.industry).toBe("快消-酒水");
    expect(parsed.stageId).toBeDefined();
    expect(parsed.ownerId).toBeDefined();
  });

  it("空字符串圈选视为未提供", () => {
    const parsed = analyticsQuerySchema.parse({ source: "", industry: "  " });
    expect(parsed.source).toBeUndefined();
    expect(parsed.industry).toBeUndefined();
  });

  it("非法 stageId/ownerId 拒绝", () => {
    expect(
      analyticsQuerySchema.safeParse({ stageId: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      analyticsQuerySchema.safeParse({ ownerId: "not-a-uuid" }).success,
    ).toBe(false);
  });
});
