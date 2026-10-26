import { describe, expect, it } from "vitest";
import { computeRates, EMPTY_FUNNEL_COUNTS, FunnelCounts } from "@/lib/metrics";

// T12 指标口径固化（PRD §5.9 / C03 / K5）：固定 fixtures 与手工计算逐项一致。
// - 比率保留 1 位小数（已乘 100，66.7 = 66.7%）；
// - 分母为 0 → null（界面显示"—"），绝不显示 0%（验收项）；
// - 每小时有效沟通数：缺工时（null）或工时 0 → null（C03：未填报不得显示 0%）。

const FULL: FunnelCounts = {
  outboundCalls: 45,
  connectedCalls: 23,
  effectiveCommunications: 12,
  qualifiedLeads: 5,
  demoBookings: 2,
  demoCompletions: 1,
  quotes: 1,
  deals: 0,
};

describe("computeRates：固定 fixtures 手工对账", () => {
  it("完整漏斗：各比率与手算一致（1 位小数）", () => {
    // 23/45 = 51.11…% ；12/23 = 52.17…% ；5/12 = 41.66…% ；2/12 = 16.66…%
    const rates = computeRates(FULL, 8);
    expect(rates.connectRate).toBe(51.1);
    expect(rates.effectiveRate).toBe(52.2);
    expect(rates.qualifiedRate).toBe(41.7);
    expect(rates.bookingRate).toBe(16.7);
    // 12 / 8 = 1.5 个/小时
    expect(rates.effectivePerHour).toBe(1.5);
  });

  it("1/3 与 2/3 的舍入边界", () => {
    const twoThirds = computeRates(
      { ...EMPTY_FUNNEL_COUNTS, outboundCalls: 3, connectedCalls: 2 },
      null,
    );
    expect(twoThirds.connectRate).toBe(66.7);
    const oneThird = computeRates(
      { ...EMPTY_FUNNEL_COUNTS, outboundCalls: 3, connectedCalls: 1 },
      null,
    );
    expect(oneThird.connectRate).toBe(33.3);
  });

  it("分母 0 → null（不显示 0%，验收项）", () => {
    // 呼出 0：接通率、有效沟通率（依赖接通）都无数据
    const noCalls = computeRates(
      { ...FULL, outboundCalls: 0, connectedCalls: 0 },
      null,
    );
    expect(noCalls.connectRate).toBeNull();
    expect(noCalls.effectiveRate).toBeNull();

    // 接通 0：有效沟通率分母为 0
    const noConnected = computeRates({ ...FULL, connectedCalls: 0 }, null);
    expect(noConnected.effectiveRate).toBeNull();

    // 有效沟通 0：合格线索率与预约转化率分母为 0
    const noEffective = computeRates(
      { ...FULL, effectiveCommunications: 0 },
      null,
    );
    expect(noEffective.qualifiedRate).toBeNull();
    expect(noEffective.bookingRate).toBeNull();
  });

  it("分子 0 但分母 > 0：0% 是真实计算值，正常显示", () => {
    const rates = computeRates(
      { ...FULL, qualifiedLeads: 0, demoBookings: 0 },
      8,
    );
    expect(rates.qualifiedRate).toBe(0);
    expect(rates.bookingRate).toBe(0);
  });

  it("每小时有效沟通：工时 12h/有效 12 → 1；缺工时与工时 0 → null（C03）", () => {
    expect(computeRates(FULL, 12).effectivePerHour).toBe(1);

    // 无填报行：null（"—"）
    expect(computeRates(FULL, null).effectivePerHour).toBeNull();
    // 全周填报了 0 小时：分母 0 → null
    expect(computeRates(FULL, 0).effectivePerHour).toBeNull();
  });

  it("全零计数不报错：所有比率为 null", () => {
    const rates = computeRates(EMPTY_FUNNEL_COUNTS, null);
    expect(rates).toEqual({
      connectRate: null,
      effectiveRate: null,
      qualifiedRate: null,
      bookingRate: null,
      effectivePerHour: null,
    });
  });
});
