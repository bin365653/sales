import { describe, expect, it } from "vitest";
import {
  buildFunnelRows,
  DASH_REASON_NO_WORKTIME,
  DASH_REASON_ZERO_DENOMINATOR,
  DASH_REASON_ZERO_WORKTIME,
  effectivePerHourDashReason,
  formatAnalyticsPeriodLabel,
  formatMetricRate,
  isFunnelEmpty,
  resolveAnalyticsPeriod,
} from "@/lib/analytics";
import { EMPTY_FUNNEL_COUNTS, FunnelCounts } from "@/lib/metrics";

// T13 看板纯函数固化：周期解析（C13 上海日历日/周一起算/自然月）、
// 漏斗行文案与顺序（UIUX P7）、"—"原因文案（§4.6）、空态判定（§7.4）。

describe("resolveAnalyticsPeriod：周期解析（上海日历日，C13）", () => {
  it("today = 上海今天单日闭区间", () => {
    const now = new Date("2027-03-10T10:00:00+08:00"); // 上海 03-10 10:00
    expect(resolveAnalyticsPeriod("today", now)).toEqual({
      from: "2027-03-10",
      to: "2027-03-10",
    });
  });

  it("today：UTC 已跨日但上海仍是前一天（上海日界）", () => {
    // UTC 2027-03-10 17:00 = 上海 2027-03-11 01:00
    const now = new Date("2027-03-10T17:00:00Z");
    expect(resolveAnalyticsPeriod("today", now)).toEqual({
      from: "2027-03-11",
      to: "2027-03-11",
    });
  });

  it("week = 周一 → 周日；周日传入归属当周", () => {
    const wednesday = new Date("2027-03-10T10:00:00+08:00");
    expect(resolveAnalyticsPeriod("week", wednesday)).toEqual({
      from: "2027-03-08",
      to: "2027-03-14",
    });
    const sunday = new Date("2027-03-14T23:00:00+08:00");
    expect(resolveAnalyticsPeriod("week", sunday)).toEqual({
      from: "2027-03-08",
      to: "2027-03-14",
    });
  });

  it("month = 自然月整月；跨年与闰年边界", () => {
    expect(
      resolveAnalyticsPeriod("month", new Date("2027-03-10T10:00:00+08:00")),
    ).toEqual({ from: "2027-03-01", to: "2027-03-31" });
    // 12 月（跨年月末）
    expect(
      resolveAnalyticsPeriod("month", new Date("2027-12-31T23:00:00+08:00")),
    ).toEqual({ from: "2027-12-01", to: "2027-12-31" });
    // 闰年 2 月
    expect(
      resolveAnalyticsPeriod("month", new Date("2028-02-10T10:00:00+08:00")),
    ).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    // 平年 2 月
    expect(
      resolveAnalyticsPeriod("month", new Date("2027-02-10T10:00:00+08:00")),
    ).toEqual({ from: "2027-02-01", to: "2027-02-28" });
    // UTC 已进次月但上海未进（上海 01-31 23:00）
    expect(
      resolveAnalyticsPeriod("month", new Date("2027-01-31T15:30:00Z")),
    ).toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });

  it("custom = 原样闭区间", () => {
    expect(
      resolveAnalyticsPeriod("custom", new Date(), {
        from: "2026-10-01",
        to: "2026-10-24",
      }),
    ).toEqual({ from: "2026-10-01", to: "2026-10-24" });
  });
});

describe("formatAnalyticsPeriodLabel：周期文案", () => {
  it("四种预设文案", () => {
    expect(
      formatAnalyticsPeriodLabel("today", { from: "2027-03-10", to: "2027-03-10" }),
    ).toBe("今日（2027-03-10）");
    expect(
      formatAnalyticsPeriodLabel("week", { from: "2027-03-08", to: "2027-03-14" }),
    ).toBe("本周（03-08 ~ 03-14）");
    expect(
      formatAnalyticsPeriodLabel("month", { from: "2027-03-01", to: "2027-03-31" }),
    ).toBe("本月（2027-03）");
    expect(
      formatAnalyticsPeriodLabel("custom", { from: "2026-10-01", to: "2026-10-24" }),
    ).toBe("2026-10-01 ~ 2026-10-24");
  });
});

describe("buildFunnelRows：漏斗 8 行顺序与文案（UIUX P7）", () => {
  it("固定顺序：呼出→接通→有效→合格→预约→演示→报价→成交", () => {
    const counts: FunnelCounts = {
      outboundCalls: 45,
      connectedCalls: 30,
      effectiveCommunications: 12,
      qualifiedLeads: 5,
      demoBookings: 2,
      demoCompletions: 2,
      quotes: 1,
      deals: 0,
    };
    expect(buildFunnelRows(counts).map((row) => [row.label, row.value])).toEqual([
      ["呼出", 45],
      ["接通", 30],
      ["有效沟通", 12],
      ["合格线索", 5],
      ["预约演示", 2],
      ["演示完成", 2],
      ["报价", 1],
      ["成交", 0],
    ]);
  });
});

describe("Dash 原因文案与空态（§4.6 / §7.4）", () => {
  it("每小时有效沟通的 '—' 三种原因", () => {
    expect(effectivePerHourDashReason(null)).toBe(DASH_REASON_NO_WORKTIME);
    expect(effectivePerHourDashReason(0)).toBe(DASH_REASON_ZERO_WORKTIME);
    // 工时 > 0 时该比率不会为 null，但兜底原因仍可解释
    expect(effectivePerHourDashReason(8)).toBe(DASH_REASON_ZERO_DENOMINATOR);
  });

  it("formatMetricRate：null → '—'，数值带 %", () => {
    expect(formatMetricRate(null)).toBe("—");
    expect(formatMetricRate(66.7)).toBe("66.7%");
    expect(formatMetricRate(0)).toBe("0%");
  });

  it("isFunnelEmpty：漏斗 8 项全 0 = 无沟通数据；任一非 0 = 有", () => {
    expect(isFunnelEmpty(EMPTY_FUNNEL_COUNTS)).toBe(true);
    expect(
      isFunnelEmpty({ ...EMPTY_FUNNEL_COUNTS, deals: 1 }),
    ).toBe(false);
    expect(
      isFunnelEmpty({ ...EMPTY_FUNNEL_COUNTS, outboundCalls: 3 }),
    ).toBe(false);
  });
});
