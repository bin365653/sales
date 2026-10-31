import { describe, expect, it } from "vitest";
import {
  addExpiryMonths,
  BUYOUT_EXPIRY_DATE,
  currentExpiryMonth,
  expiryMonthToUtcDate,
  expiryWindow,
  formatExpiryChip,
  normalizeExpiryInput,
  toExpiryMonth,
} from "@/lib/expiry";
import {
  evaluateQuadrant,
  isConfirmedStatus,
} from "@/lib/quadrant";
import { leadCreateSchema } from "@/lib/schemas/lead";

// V2.0-T03：到期月粒度口径（P4）+ 四象限纯函数（P1/P3）+ Schema 归一化。

describe("到期月粒度（P4）", () => {
  it("归一化：YYYY-MM → 当月 1 日；YYYY → 当年 12 月；完整日期原样", () => {
    expect(normalizeExpiryInput("2027-06")).toBe("2027-06-01");
    expect(normalizeExpiryInput("2026")).toBe("2026-12-01");
    expect(normalizeExpiryInput("2027-06-30")).toBe("2027-06-30");
  });

  it("Schema 层归一化：contractExpiry 接受 YYYY-MM / YYYY", () => {
    const month = leadCreateSchema.parse({ name: "客户甲", contractExpiry: "2027-06" });
    expect(month.contractExpiry).toBe("2027-06-01");
    const year = leadCreateSchema.parse({ name: "客户乙", contractExpiry: "2026" });
    expect(year.contractExpiry).toBe("2026-12-01");
    const invalid = leadCreateSchema.safeParse({
      name: "客户丙",
      contractExpiry: "2027-13",
    });
    expect(invalid.success).toBe(false);
  });

  it("月份运算：跨年进位", () => {
    expect(addExpiryMonths("2026-10", 6)).toBe("2027-04");
    expect(addExpiryMonths("2026-12", 1)).toBe("2027-01");
    expect(addExpiryMonths("2026-01", -1)).toBe("2025-12");
  });

  it("窗口判定：月粒度，半年内含第 6 个月边界", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    expect(currentExpiryMonth(now)).toBe("2026-10");
    // 已过期：E < M
    expect(expiryWindow(expiryMonthToUtcDate("2026-09"), now)).toBe("expired");
    // 当月 → 半年内；恰第 6 个月（2027-04）→ 半年内（含边界）
    expect(expiryWindow(expiryMonthToUtcDate("2026-10"), now)).toBe("within_6m");
    expect(expiryWindow(expiryMonthToUtcDate("2027-04"), now)).toBe("within_6m");
    // 第 7 个月 → 超半年；买断 2099-12 → 超半年
    expect(expiryWindow(expiryMonthToUtcDate("2027-05"), now)).toBe("beyond_6m");
    expect(expiryWindow(expiryMonthToUtcDate("2099-12"), now)).toBe("beyond_6m");
    // 未知：null 或核实状态 unknown
    expect(expiryWindow(null, now)).toBe("unknown");
    expect(
      expiryWindow(expiryMonthToUtcDate("2026-12"), now, { status: "unknown" }),
    ).toBe("unknown");
  });

  it("ExpiryChip 文案：年月 + 窗口语义；买断显示（买断）；未知引导核实", () => {
    const now = new Date("2026-10-15T08:00:00.000Z");
    expect(formatExpiryChip(expiryMonthToUtcDate("2026-12"), now)).toBe(
      "2026-12 · 6 个月内到期",
    );
    expect(formatExpiryChip(expiryMonthToUtcDate("2026-09"), now)).toBe(
      "2026-09 · 已过期",
    );
    expect(
      formatExpiryChip(new Date(`${BUYOUT_EXPIRY_DATE}T00:00:00.000Z`), now),
    ).toBe("2099-12（买断）");
    expect(formatExpiryChip(null, now)).toBe("到期时间未知 · 待核实");
    expect(toExpiryMonth(new Date("2027-03-15T00:00:00.000Z"))).toBe("2027-03");
  });
});

describe("四象限计算（P1/P3）", () => {
  it("双确认：A/B/C/D 正确映射", () => {
    expect(
      evaluateQuadrant({ value: true, status: "confirmed" }, { value: true, status: "confirmed" })
        .quadrant,
    ).toBe("a");
    expect(
      evaluateQuadrant({ value: true, status: "confirmed" }, { value: false, status: "stated" })
        .quadrant,
    ).toBe("b");
    expect(
      evaluateQuadrant({ value: false, status: "stated" }, { value: true, status: "confirmed" })
        .quadrant,
    ).toBe("c");
    expect(
      evaluateQuadrant({ value: false, status: "stated" }, { value: false, status: "stated" })
        .quadrant,
    ).toBe("d");
  });

  it("任一维度未确认或未知 → 不进象限并给出缺失维度（未知≠否）", () => {
    const x = { value: true, status: "confirmed" as const };
    expect(evaluateQuadrant(x, { value: null, status: "confirmed" })).toEqual({
      quadrant: null,
      missing: ["是否愿意沟通了解勤策"],
    });
    expect(
      evaluateQuadrant({ value: true, status: "unverified" }, { value: true, status: "confirmed" }),
    ).toEqual({
      quadrant: null,
      missing: ["是否使用新一代手机开单系统"],
    });
    expect(
      evaluateQuadrant({ value: null, status: "unknown" }, { value: null, status: "unknown" }),
    ).toEqual({
      quadrant: null,
      missing: [
        "是否使用新一代手机开单系统",
        "是否愿意沟通了解勤策",
      ],
    });
  });

  it("stated（客户自述待复核）按已确认处理（P3）；unverified/unknown 不算", () => {
    expect(isConfirmedStatus("stated")).toBe(true);
    expect(isConfirmedStatus("confirmed")).toBe(true);
    expect(isConfirmedStatus("unverified")).toBe(false);
    expect(isConfirmedStatus("unknown")).toBe(false);
  });
});
