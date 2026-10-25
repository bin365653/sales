import { describe, expect, it } from "vitest";
import {
  interactionCreateSchema,
  interactionUpdateSchema,
} from "@/lib/schemas/interaction";

// T06 沟通记录入参 Schema（前后端共用，验收项：direction/effective 定义文案与联动）：
// - effective 依赖 connected（未接通不可能有效）；
// - occurred_at 不允许未来时间（5 分钟容差），允许补录过去；
// - 可空文本空串归一化为 null；修正 Schema 不含"本次确认"标记。

const PAST = "2026-01-01 09:30";

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    occurredAt: PAST,
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: false,
    ...overrides,
  };
}

describe("沟通时间 occurredAt", () => {
  it("接受 YYYY-MM-DD HH:mm / T 分隔 / 秒 / 紧凑时区偏移", () => {
    for (const occurredAt of [
      "2026-01-01 09:30",
      "2026-01-01T09:30",
      "2026-01-01 09:30:00",
      "2026-01-01T09:30:00+08:00",
      "2026-01-01 09:30:00+0800",
      "2026-01-01",
    ]) {
      const parsed = interactionCreateSchema.safeParse(validInput({ occurredAt }));
      expect(parsed.success, `${occurredAt} 应通过`).toBe(true);
    }
  });

  it("拒绝未来时间（5 分钟容差外）", () => {
    const parsed = interactionCreateSchema.safeParse(
      validInput({ occurredAt: "2099-01-01 09:30" }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("不能晚于当前时间");
    }
  });

  it("拒绝乱格式", () => {
    const parsed = interactionCreateSchema.safeParse(
      validInput({ occurredAt: "01/02/2026" }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("effective 与 connected 联动", () => {
  it("未接通却标记有效 → 拒绝", () => {
    const parsed = interactionCreateSchema.safeParse(
      validInput({ connected: false, effective: true }),
    );
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("未接通的沟通不能标记为有效沟通");
    }
  });

  it("未接通且未标记有效 → 通过", () => {
    const parsed = interactionCreateSchema.safeParse(
      validInput({ connected: false, effective: false }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("可空文本归一化与长度", () => {
  it("空串/纯空白 → null；未传字段不报错", () => {
    const parsed = interactionCreateSchema.parse(
      validInput({ feedback: "  ", nextAction: "", objections: "\n\t" }),
    );
    expect(parsed.feedback).toBeNull();
    expect(parsed.nextAction).toBeNull();
    expect(parsed.objections).toBeNull();
    expect(parsed.confirmedPains).toBeUndefined();
  });

  it("超长文本拒绝并报字段名", () => {
    const feedback = "长".repeat(2001);
    const parsed = interactionCreateSchema.safeParse(validInput({ feedback }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["feedback"]);
    }
  });

  it("渠道/方向/布尔枚举非法值拒绝", () => {
    expect(
      interactionCreateSchema.safeParse(validInput({ channel: "email" })).success,
    ).toBe(false);
    expect(
      interactionCreateSchema.safeParse(validInput({ direction: "unknown" })).success,
    ).toBe(false);
    expect(
      interactionCreateSchema.safeParse(validInput({ connected: "yes" })).success,
    ).toBe(false);
  });
});

describe("修正 Schema（M11）", () => {
  it("与新建同一套校验，但剥离'本次确认'标记（一次性动作不随修正重复触发）", () => {
    const parsed = interactionUpdateSchema.parse(
      validInput({ confirmCurrentSystem: true, confirmPurchaseTime: true }),
    );
    expect(parsed).not.toHaveProperty("confirmCurrentSystem");
    expect(parsed).not.toHaveProperty("confirmPurchaseTime");
  });

  it("修正同样拒绝未来沟通时间与未接通却有效", () => {
    expect(
      interactionUpdateSchema.safeParse(validInput({ occurredAt: "2099-01-01 09:30" }))
        .success,
    ).toBe(false);
    expect(
      interactionUpdateSchema.safeParse(
        validInput({ connected: false, effective: true }),
      ).success,
    ).toBe(false);
  });
});
