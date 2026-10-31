import { describe, expect, it } from "vitest";
import {
  followupPoliciesUpdateSchema,
  followupPolicyUpdateItemSchema,
} from "@/lib/schemas/settings";

// 跟进策略入参校验（V2.0-T05，UIUX §5.5/§7.3）：周期 1–365 整数、
// 提前量 0–90、任务类型白名单；载荷 1–4 行。

const VALID_ID = "0f0a9a7e-1111-4222-8333-444455556666";

function validItem(overrides: Record<string, unknown> = {}) {
  return {
    id: VALID_ID,
    intervalDays: 30,
    taskType: "follow_up",
    advanceDays: 0,
    isActive: true,
    ...overrides,
  };
}

describe("followupPolicyUpdateItemSchema", () => {
  it("合法行通过", () => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(validItem());
    expect(parsed.success).toBe(true);
  });

  it.each([0, -5, 366, 30.5])("周期 %s 拒绝（1–365 整数）", (intervalDays) => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(
      validItem({ intervalDays }),
    );
    expect(parsed.success).toBe(false);
  });

  it.each([1, 365, 90])("周期 %s 通过", (intervalDays) => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(
      validItem({ intervalDays }),
    );
    expect(parsed.success).toBe(true);
  });

  it.each([-1, 91])("提前量 %s 拒绝（0–90）", (advanceDays) => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(
      validItem({ advanceDays }),
    );
    expect(parsed.success).toBe(false);
  });

  it("任务类型白名单外拒绝", () => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(
      validItem({ taskType: "not_a_type" }),
    );
    expect(parsed.success).toBe(false);
  });

  it("非法 id 拒绝", () => {
    const parsed = followupPolicyUpdateItemSchema.safeParse(
      validItem({ id: "not-a-uuid" }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("followupPoliciesUpdateSchema", () => {
  it("1–4 行通过", () => {
    expect(
      followupPoliciesUpdateSchema.safeParse({ policies: [validItem()] }).success,
    ).toBe(true);
    expect(
      followupPoliciesUpdateSchema.safeParse({ policies: [] }).success,
    ).toBe(false);
  });

  it("载荷含系统行（试图改系统策略）在载荷层不区分——由服务层按 id 拒绝", () => {
    // 系统行同样以 id 提交，Schema 层无法区分（与阶段/字典同构）；
    // P6 只读约束固化在服务层（followup-policies.test.ts 集成断言）。
    expect(
      followupPoliciesUpdateSchema.safeParse({ policies: [validItem()] }).success,
    ).toBe(true);
  });
});
