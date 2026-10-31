import { describe, expect, it } from "vitest";
import {
  autoTaskReasonLabel,
  decideAutoTasks,
  FollowupPolicyLite,
  GenerationLeadContext,
} from "@/lib/followup";
import { addExpiryMonths, expiryMonthToUtcDate, currentExpiryMonth } from "@/lib/expiry";
import { startOfShanghaiDay } from "@/lib/tasks";

// 任务生成决策规则（V2.0-T06，实施计划 §4.5 / §4.2 口径单测固化——R6）：
// 6 个月边界、到期未知/已过、互斥、anchor+提前量、轮次、约定优先、幂等跳过。

const NOW = new Date("2026-11-15T04:00:00.000Z"); // 上海 2026-11-15 12:00
const MONTH = currentExpiryMonth(NOW); // 2026-11

const SYSTEM_POLICY: FollowupPolicyLite = {
  id: "sys-0000-0000",
  quadrantCode: null,
  intervalDays: 30,
  advanceDays: 0,
  taskType: "follow_up",
  isActive: true,
  isSystem: true,
};

function quadrantPolicy(code: "a" | "b" | "c" | "d", intervalDays: number): FollowupPolicyLite {
  return {
    id: `pol-${code}-0000`,
    quadrantCode: code,
    intervalDays,
    advanceDays: 0,
    taskType: "follow_up",
    isActive: true,
    isSystem: false,
  };
}

function ctx(overrides: Partial<GenerationLeadContext> = {}): GenerationLeadContext {
  return {
    now: NOW,
    quadrant: "a",
    contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 12)),
    expiryVerificationStatus: "confirmed",
    anchor: new Date("2026-09-01T00:00:00.000Z"),
    hasPendingManualTask: false,
    systemPolicy: SYSTEM_POLICY,
    quadrantPolicies: { a: quadrantPolicy("a", 30) },
    activeCycleKeys: new Map(),
    roundCount: new Map(),
    ...overrides,
  };
}

describe("到期窗口与四源互斥", () => {
  it("恰 6 个月后到期 → 当月月度任务（含第 6 个月边界）", () => {
    const result = decideAutoTasks(
      ctx({ contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 6)) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceType: "expiry_monthly",
      cycleKey: `M${MONTH}`,
      priority: 3,
      title: `软件到期月度跟进（${MONTH}）`,
    });
    expect(result[0]!.title).toContain("2026-11");
  });

  it("6 个月+1 月到期 → 超半年：无月度任务，按 A 策略生成周期任务", () => {
    const result = decideAutoTasks(
      ctx({ contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 7)) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceType).toBe("quadrant_periodic");
    expect(result[0]!.cycleKey).toBe("1");
    expect(result[0]!.title).toBe("四象限周期跟进（A·30天）");
  });

  it("到期已过 → 月度核实任务「软件到期状态核实」", () => {
    const result = decideAutoTasks(
      ctx({ contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, -1)) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceType).toBe("expiry_monthly");
    expect(result[0]!.title).toBe("软件到期状态核实");
  });

  it("到期值未知（null）→ 画像补充任务（今天+3 天，不套长期策略）", () => {
    const result = decideAutoTasks(ctx({ contractExpiry: null }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      sourceType: "profile_gap",
      cycleKey: `G${MONTH}`,
      priority: 4,
      title: "画像补充核实",
    });
  });

  it("到期值存在但核实状态 unknown → 视为未知 → 画像补充", () => {
    const result = decideAutoTasks(ctx({ expiryVerificationStatus: "unknown" }));
    expect(result[0]!.sourceType).toBe("profile_gap");
  });

  it("互斥：半年内窗口即使象限已定也只生成月度任务（月度优先）", () => {
    const result = decideAutoTasks(
      ctx({ contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 3)) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.sourceType).toBe("expiry_monthly");
  });

  it("stated（客户自述待复核）按已知窗口处理（P3 口径）", () => {
    const result = decideAutoTasks(
      ctx({
        contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 3)),
        expiryVerificationStatus: "stated",
      }),
    );
    expect(result[0]!.sourceType).toBe("expiry_monthly");
  });
});

describe("象限周期任务：anchor / 提前量 / 轮次", () => {
  it("anchor+interval 未到 → 不生成（窗口未到）", () => {
    const result = decideAutoTasks(
      ctx({ anchor: new Date("2026-11-10T00:00:00.000Z") }), // +30d = 12-10 > today
    );
    expect(result).toHaveLength(0);
  });

  it("提前量：advance=5 时距自然到期 5 天内即生成，dueAt=自然到期日", () => {
    const anchor = new Date("2026-10-18T00:00:00.000Z"); // +30d = 2026-11-17（未来）
    const result = decideAutoTasks(
      ctx({
        anchor,
        quadrantPolicies: { a: { ...quadrantPolicy("a", 30), advanceDays: 5 } },
      }),
    );
    // 无提前量时生成窗口 11-17 > 今天 11-15 不生成；提前 5 天 → 11-12 ≤ 今天即生成
    expect(result).toHaveLength(1);
    expect(result[0]!.dueAt.toISOString().slice(0, 10)).toBe("2026-11-17");
    expect(decideAutoTasks(ctx({ anchor }))).toHaveLength(0);
  });

  it("欠账只补当前一轮：anchor+interval 已过 → dueAt 收敛到今天，cycleKey=轮次+1", () => {
    const result = decideAutoTasks(
      ctx({ anchor: new Date("2026-09-01T00:00:00.000Z"), roundCount: new Map([["pol-a-0000", 3]]) }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.cycleKey).toBe("4");
    // dueAt = 上海今天 00:00（dueToday 语义，不计逾期）
    expect(result[0]!.dueAt.getTime()).toBe(startOfShanghaiDay(0, NOW).getTime());
    expect(result[0]!.plannedDate).toBe("2026-11-15");
  });

  it("同一策略同周期已有有效计划 → 跳过（幂等）", () => {
    const result = decideAutoTasks(
      ctx({
        contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 12)),
        activeCycleKeys: new Map([["pol-a-0000", new Set(["1"])]]),
      }),
    );
    expect(result).toHaveLength(0);
  });

  it("象限未定（null）不生成周期任务；策略停用不生成", () => {
    expect(decideAutoTasks(ctx({ quadrant: null }))).toHaveLength(0);
    expect(
      decideAutoTasks(
        ctx({
          quadrantPolicies: { a: { ...quadrantPolicy("a", 30), isActive: false } },
        }),
      ),
    ).toHaveLength(0);
  });

  it("客户有 pending 约定任务 → 本轮跳过周期任务（约定优先，不被覆盖）", () => {
    const result = decideAutoTasks(ctx({ hasPendingManualTask: true }));
    expect(result).toHaveLength(0);
  });

  it("系统策略停用时月度/画像任务均不生成", () => {
    expect(
      decideAutoTasks(
        ctx({
          contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 3)),
          systemPolicy: { ...SYSTEM_POLICY, isActive: false },
        }),
      ),
    ).toHaveLength(0);
  });

  it("2099-12 买断属超半年 → 按象限策略周期跟进", () => {
    const result = decideAutoTasks(
      ctx({ contractExpiry: expiryMonthToUtcDate("2099-12") }),
    );
    expect(result[0]!.sourceType).toBe("quadrant_periodic");
  });
});

describe("原因行文案（UIUX §5.4/§7.2 红线）", () => {
  it("月度/过期/画像/周期四类原因可派生，manual 不显示", () => {
    const base = {
      contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, 3)),
      expiryVerificationStatus: "confirmed",
      quadrant: "c" as const,
      intervalDays: 14,
      now: NOW,
    };
    expect(autoTaskReasonLabel("expiry_monthly", base)).toContain("半年内窗口");
    expect(
      autoTaskReasonLabel("expiry_monthly", {
        ...base,
        contractExpiry: expiryMonthToUtcDate(addExpiryMonths(MONTH, -1)),
      }),
    ).toContain("已过期");
    expect(autoTaskReasonLabel("profile_gap", { ...base, contractExpiry: null })).toContain(
      "到期时间未知",
    );
    expect(autoTaskReasonLabel("quadrant_periodic", base)).toContain("14 天");
    expect(autoTaskReasonLabel("manual", base)).toBeNull();
  });
});
