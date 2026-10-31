import { describe, expect, it } from "vitest";
import {
  comparePriorityCandidates,
  evaluatePriorityReasons,
  expiryWindowReason,
  isExpiryWithinSixMonths,
  PRIORITY_REASON_VOCABULARY,
  PRIORITY_RULE_EXPLANATION,
  PriorityCandidateCore,
  PriorityRuleInput,
} from "@/lib/metrics";

// V2.0-T10 规则引擎固化（K6 + 决策 D4 / UIUX §5.6、§7.2）：
// ① 软件半年内到期（月粒度，含已过期）**取代** V1.0「合同 30 天内到期」；
// ② 今日待联系；③ 画像待完善（核心未全核实）**取代**「画像完整且从未联系」。
// 规则理由是封闭集合——无采购信号不产生理由，绝无"高意向"话术（验收项）。

const TODAY = "2026-11-15"; // 上海日历日

function input(overrides: Partial<PriorityRuleInput>): PriorityRuleInput {
  return {
    contractExpiryDate: null,
    contractExpiryStatus: "unknown",
    nextContactDate: null,
    profileIncomplete: false,
    ...overrides,
  };
}

describe("规则 1：软件半年内到期（月粒度，D4 取代 30 天规则）", () => {
  it("半年内（已确认）→ 理由含到期月与窗口语义", () => {
    const result = evaluatePriorityReasons(
      input({ contractExpiryDate: "2026-12-20", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(result.reasons).toEqual(["软件 2026-12 到期，处于半年内窗口"]);
    expect(result.score).toBe(3);
  });

  it("月粒度边界：恰第 6 个月（2027-05）计入，第 7 个月（2027-06）不计入", () => {
    const at6 = evaluatePriorityReasons(
      input({ contractExpiryDate: "2027-05-31", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(at6.score).toBe(3);

    const at7 = evaluatePriorityReasons(
      input({ contractExpiryDate: "2027-06-01", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(at7.reasons).toEqual([]);
  });

  it("年内边界跨年：11 月 → 次年 5 月（第 6 个月）计入，次年 6 月不计", () => {
    expect(isExpiryWithinSixMonths("2027-05-31", "2026-11-15")).toBe(true);
    expect(isExpiryWithinSixMonths("2027-06-01", "2026-11-15")).toBe(false);
  });

  it("已过期（含过期很久）→ 已过期措辞，需核实续费状态", () => {
    expect(expiryWindowReason("2026-10-31", TODAY)).toBe(
      "软件 2026-10 已过期，需核实续费状态",
    );
    const expired = evaluatePriorityReasons(
      input({ contractExpiryDate: "2025-01-20", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(expired.reasons).toEqual(["软件 2025-01 已过期，需核实续费状态"]);
    expect(expired.score).toBe(3);
  });

  it("买断 2099-12（超半年）不产生到期理由", () => {
    const buyout = evaluatePriorityReasons(
      input({ contractExpiryDate: "2099-12-01", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(buyout.reasons).toEqual([]);
  });

  it("stated（客户自述待复核）视同已确认（P3）；unverified/unknown 不产生理由", () => {
    const stated = evaluatePriorityReasons(
      input({ contractExpiryDate: "2026-12-20", contractExpiryStatus: "stated" }),
      TODAY,
    );
    expect(stated.score).toBe(3);
    for (const status of ["unverified", "unknown"] as const) {
      const result = evaluatePriorityReasons(
        input({ contractExpiryDate: "2026-12-20", contractExpiryStatus: status }),
        TODAY,
      );
      expect(result.reasons).toEqual([]);
    }
  });
});

describe("规则 2/3：今日待联系与画像待完善（D4 权重重排）", () => {
  it("今日待联系 weight 2；画像待完善 weight 1", () => {
    const dueToday = evaluatePriorityReasons(
      input({ nextContactDate: TODAY }),
      TODAY,
    );
    expect(dueToday.reasons).toEqual(["今日待联系"]);
    expect(dueToday.score).toBe(2);

    const gap = evaluatePriorityReasons(input({ profileIncomplete: true }), TODAY);
    expect(gap.reasons).toEqual(["画像待完善：核心信息未全部核实"]);
    expect(gap.score).toBe(1);
  });

  it("多规则命中：理由全保留、score 取最高权重，顺序=规则评估顺序（到期>今日>画像）", () => {
    const result = evaluatePriorityReasons(
      input({
        contractExpiryDate: "2026-12-20",
        contractExpiryStatus: "confirmed",
        nextContactDate: TODAY,
        profileIncomplete: true,
      }),
      TODAY,
    );
    expect(result.reasons).toEqual([
      "软件 2026-12 到期，处于半年内窗口",
      "今日待联系",
      "画像待完善：核心信息未全部核实",
    ]);
    expect(result.score).toBe(3);
  });

  it("无任何信号不产生理由（K6 红线）", () => {
    expect(evaluatePriorityReasons(input({}), TODAY).reasons).toEqual([]);
  });
});

describe("排序与封闭词汇表", () => {
  it("权重降序 → 到期升序（null 最后）→ 下次联系升序 → 创建时间", () => {
    const a: PriorityCandidateCore = {
      reasons: [],
      score: 1,
      contractExpiryDate: null,
      nextContactDate: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const b: PriorityCandidateCore = {
      reasons: [],
      score: 3,
      contractExpiryDate: "2026-12-01",
      nextContactDate: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    const c: PriorityCandidateCore = {
      reasons: [],
      score: 3,
      contractExpiryDate: "2026-11-01",
      nextContactDate: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    expect(comparePriorityCandidates(b, a)).toBeLessThan(0);
    expect(comparePriorityCandidates(c, b)).toBeLessThan(0);
  });

  it("理由词汇表为封闭集合且无高意向话术", () => {
    const all = PRIORITY_REASON_VOCABULARY.join("|");
    expect(all).not.toContain("高意向");
    expect(PRIORITY_RULE_EXPLANATION).toContain("软件半年内到期 > 今日待联系 > 画像待完善");
    expect(PRIORITY_RULE_EXPLANATION).toContain("AI 不参与优先级计算");
  });
});
