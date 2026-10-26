import { describe, expect, it } from "vitest";
import {
  comparePriorityCandidates,
  contractExpiryReason,
  countFilledProfileFields,
  evaluatePriorityReasons,
  PriorityCandidateCore,
  PriorityRuleInput,
} from "@/lib/metrics";

// T12 规则引擎固化（K6 / UIUX P2）：优先联系理由与规则逐条一致（验收项）。
// 规则理由是封闭集合——无采购信号不产生理由，绝无"高意向"话术（验收项）。

const TODAY = "2026-10-28";

function input(overrides: Partial<PriorityRuleInput>): PriorityRuleInput {
  return {
    contractExpiryDate: null,
    contractExpiryStatus: "unknown",
    nextContactDate: null,
    neverContacted: false,
    profileFilledCount: 0,
    ...overrides,
  };
}

describe("规则 1：合同 30 天内到期（已确认）", () => {
  it("到期前 10 天且已确认 → 理由含具体天数", () => {
    const result = evaluatePriorityReasons(
      input({
        contractExpiryDate: "2026-11-07",
        contractExpiryStatus: "confirmed",
      }),
      TODAY,
    );
    expect(result.reasons).toEqual(["合同 10 天内到期（已确认）"]);
    expect(result.score).toBe(3);
  });

  it("窗口边界：恰 30 天计入，31 天不计入", () => {
    const at30 = evaluatePriorityReasons(
      input({ contractExpiryDate: "2026-11-27", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(at30.reasons).toEqual(["合同 30 天内到期（已确认）"]);

    const at31 = evaluatePriorityReasons(
      input({ contractExpiryDate: "2026-11-28", contractExpiryStatus: "confirmed" }),
      TODAY,
    );
    expect(at31.reasons).toEqual([]);
  });

  it("今日到期与已过期给出可执行措辞（跨月由日期数学保证）", () => {
    expect(contractExpiryReason("2026-10-28", TODAY)).toBe(
      "合同今日到期（已确认）",
    );
    expect(contractExpiryReason("2026-10-23", TODAY)).toBe(
      "合同已过期 5 天（已确认）",
    );
    // 跨月：10-28 → 12-01 = 34 天
    expect(contractExpiryReason("2026-12-01", TODAY)).toBe(
      "合同 34 天内到期（已确认）",
    );
  });

  it("未确认/未知状态不产生理由（K6：无采购信号不得凭空标记）", () => {
    for (const status of ["unverified", "unknown"] as const) {
      const result = evaluatePriorityReasons(
        input({ contractExpiryDate: "2026-11-07", contractExpiryStatus: status }),
        TODAY,
      );
      expect(result.reasons).toEqual([]);
      expect(result.score).toBe(0);
    }
  });
});

describe("规则 2：今日待联系（上海日界）", () => {
  it("下次联系=今天命中；昨天/明天不命中", () => {
    expect(
      evaluatePriorityReasons(input({ nextContactDate: TODAY }), TODAY).reasons,
    ).toEqual(["今日待联系"]);
    expect(
      evaluatePriorityReasons(input({ nextContactDate: "2026-10-27" }), TODAY)
        .reasons,
    ).toEqual([]);
    expect(
      evaluatePriorityReasons(input({ nextContactDate: "2026-10-29" }), TODAY)
        .reasons,
    ).toEqual([]);
  });
});

describe("规则 3：画像完整且从未联系", () => {
  it("从未联系 + 画像 8/10 命中；7/10 或已联系不命中", () => {
    const hit = evaluatePriorityReasons(
      input({ neverContacted: true, profileFilledCount: 8 }),
      TODAY,
    );
    expect(hit.reasons).toEqual(["画像完整且从未联系"]);
    expect(hit.score).toBe(1);

    expect(
      evaluatePriorityReasons(
        input({ neverContacted: true, profileFilledCount: 7 }),
        TODAY,
      ).reasons,
    ).toEqual([]);
    expect(
      evaluatePriorityReasons(
        input({ neverContacted: false, profileFilledCount: 10 }),
        TODAY,
      ).reasons,
    ).toEqual([]);
  });
});

describe("多规则命中与 score", () => {
  it("三条全中：理由全部保留、顺序稳定，score 取最高权重", () => {
    const result = evaluatePriorityReasons(
      input({
        contractExpiryDate: "2026-11-07",
        contractExpiryStatus: "confirmed",
        nextContactDate: TODAY,
        neverContacted: true,
        profileFilledCount: 10,
      }),
      TODAY,
    );
    expect(result.reasons).toEqual([
      "合同 10 天内到期（已确认）",
      "今日待联系",
      "画像完整且从未联系",
    ]);
    expect(result.score).toBe(3);
  });
});

describe("countFilledProfileFields", () => {
  it("null/undefined/空串/NaN 视为未填", () => {
    expect(countFilledProfileFields({})).toBe(0);
    expect(
      countFilledProfileFields({
        city: "合肥",
        industry: "",
        mainCategory: null,
        contactName: undefined,
        contactPhone: "13800000001",
        salesTeamSize: Number.NaN,
        salesMode: "访销",
      }),
    ).toBe(3);
  });
});

describe("comparePriorityCandidates：排序规则", () => {
  function candidate(overrides: Partial<PriorityCandidateCore>): PriorityCandidateCore {
    return {
      reasons: ["今日待联系"],
      score: 2,
      contractExpiryDate: null,
      nextContactDate: null,
      createdAt: "2026-10-20T00:00:00.000Z",
      ...overrides,
    };
  }

  it("规则权重高者在前", () => {
    const contract = candidate({ score: 3 });
    const due = candidate({ score: 2 });
    expect(comparePriorityCandidates(contract, due)).toBeLessThan(0);
  });

  it("同分：合同到期早者在前，无合同殿后", () => {
    const early = candidate({ contractExpiryDate: "2026-11-01" });
    const late = candidate({ contractExpiryDate: "2026-11-20" });
    const none = candidate({ contractExpiryDate: null });
    expect(comparePriorityCandidates(early, late)).toBeLessThan(0);
    expect(comparePriorityCandidates(none, early)).toBeGreaterThan(0);
  });

  it("同分同合同：下次联系早者在前，无下次联系殿后", () => {
    const early = candidate({ nextContactDate: "2026-10-28" });
    const late = candidate({ nextContactDate: "2026-10-30" });
    const none = candidate({ nextContactDate: null });
    expect(comparePriorityCandidates(early, late)).toBeLessThan(0);
    expect(comparePriorityCandidates(none, early)).toBeGreaterThan(0);
  });

  it("全并列：创建时间早者在前（结果稳定）", () => {
    const older = candidate({ createdAt: "2026-10-01T00:00:00.000Z" });
    const newer = candidate({ createdAt: "2026-10-02T00:00:00.000Z" });
    expect(comparePriorityCandidates(older, newer)).toBeLessThan(0);
  });
});

describe("合规红线：理由为封闭集合，无'高意向'话术（验收项）", () => {
  it("状态 × 信号全矩阵：每条理由只来自三条规则", () => {
    const statusList = ["unknown", "unverified", "confirmed"] as const;
    const signalMatrix = [true, false];
    for (const status of statusList) {
      for (const hasContract of signalMatrix) {
        for (const dueToday of signalMatrix) {
          for (const neverContacted of signalMatrix) {
            for (const filled of [0, 7, 8, 10]) {
              const { reasons } = evaluatePriorityReasons(
                input({
                  contractExpiryDate: hasContract ? "2026-11-07" : null,
                  contractExpiryStatus: status,
                  nextContactDate: dueToday ? TODAY : null,
                  neverContacted,
                  profileFilledCount: filled,
                }),
                TODAY,
              );
              for (const reason of reasons) {
                expect(reason).not.toContain("高意向");
                const allowed =
                  /^合同(今日到期| \d+ 天内到期|已过期 \d+ 天)（已确认）$/.test(
                    reason,
                  ) ||
                  reason === "今日待联系" ||
                  reason === "画像完整且从未联系";
                expect(allowed, `未预期的话术：${reason}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it("未确认合同即使采购信号齐全也不出现任何理由", () => {
    const result = evaluatePriorityReasons(
      input({
        contractExpiryDate: "2026-11-07",
        contractExpiryStatus: "unverified",
        nextContactDate: TODAY,
        neverContacted: true,
        profileFilledCount: 10,
      }),
      TODAY,
    );
    expect(result.reasons).toEqual(["今日待联系", "画像完整且从未联系"]);
  });
});
