import { describe, expect, it } from "vitest";
import {
  aiRunCreateSchema,
  modelConfigCreateSchema,
  modelConfigUpdateSchema,
  RUN_TYPE_LABELS,
} from "@/lib/schemas/ai";
import { dailyAiLimit } from "@/server/ai/rate-limit";

// T08 入参 Schema 与频控配置解析。

const UUID = "22222222-2222-2222-2222-222222222222";

describe("aiRunCreateSchema", () => {
  it("合法入参通过", () => {
    expect(
      aiRunCreateSchema.parse({ leadId: UUID, runType: "analysis" }),
    ).toEqual({ leadId: UUID, runType: "analysis" });
  });

  it("runType 枚举外拒绝；leadId 非 UUID 拒绝", () => {
    expect(
      aiRunCreateSchema.safeParse({ leadId: UUID, runType: "summary" }).success,
    ).toBe(false);
    expect(
      aiRunCreateSchema.safeParse({ leadId: "abc", runType: "analysis" }).success,
    ).toBe(false);
  });

  it("notes（T10）：interaction_summary 必填，其余类型禁止携带", () => {
    // 摘要缺 notes → 拒绝（防"无原始内容"调用导致模型无料可依）
    expect(
      aiRunCreateSchema.safeParse({ leadId: UUID, runType: "interaction_summary" })
        .success,
    ).toBe(false);
    // 空白/超长 notes → 拒绝
    expect(
      aiRunCreateSchema.safeParse({
        leadId: UUID,
        runType: "interaction_summary",
        notes: "   ",
      }).success,
    ).toBe(false);
    expect(
      aiRunCreateSchema.safeParse({
        leadId: UUID,
        runType: "interaction_summary",
        notes: "x".repeat(5001),
      }).success,
    ).toBe(false);
    // analysis/call_prep 携带 notes → 拒绝（防止误用语义）
    expect(
      aiRunCreateSchema.safeParse({
        leadId: UUID,
        runType: "analysis",
        notes: "原始内容",
      }).success,
    ).toBe(false);
    expect(
      aiRunCreateSchema.safeParse({
        leadId: UUID,
        runType: "call_prep",
        notes: "原始内容",
      }).success,
    ).toBe(false);
    // 合法：摘要带 notes，其余不带
    expect(
      aiRunCreateSchema.parse({
        leadId: UUID,
        runType: "interaction_summary",
        notes: "客户说现有系统太分散，想了解报价",
      }).notes,
    ).toBe("客户说现有系统太分散，想了解报价");
    expect(
      aiRunCreateSchema.safeParse({ leadId: UUID, runType: "call_prep" }).success,
    ).toBe(true);
  });

  it("三类 run 均有中文标签（UI 文案）", () => {
    expect(Object.keys(RUN_TYPE_LABELS)).toEqual([
      "analysis",
      "call_prep",
      "interaction_summary",
    ]);
  });
});

describe("modelConfig 入参 Schema", () => {
  const base = {
    baseUrl: "https://api.example.com/v1",
    modelName: "glm-4",
    apiKey: "sk-1234567890",
  };

  it("创建：provider 缺省为 openai_compatible", () => {
    const parsed = modelConfigCreateSchema.parse(base);
    expect(parsed.provider).toBe("openai_compatible");
    expect(parsed.timeoutMs).toBeUndefined();
  });

  it("创建：Base URL 必须为 http(s)、密钥至少 8 位、超时范围受限", () => {
    expect(
      modelConfigCreateSchema.safeParse({ ...base, baseUrl: "ftp://x" }).success,
    ).toBe(false);
    expect(
      modelConfigCreateSchema.safeParse({ ...base, apiKey: "short" }).success,
    ).toBe(false);
    expect(
      modelConfigCreateSchema.safeParse({ ...base, timeoutMs: 100 }).success,
    ).toBe(false);
    expect(
      modelConfigCreateSchema.safeParse({ ...base, maxRetries: 5 }).success,
    ).toBe(false);
  });

  it("更新：全部可选但至少一项；apiKey 缺省=不替换密钥", () => {
    expect(modelConfigUpdateSchema.safeParse({}).success).toBe(false);
    expect(modelConfigUpdateSchema.safeParse({ isActive: true }).success).toBe(true);
    expect(modelConfigUpdateSchema.safeParse({ apiKey: "sk-new-key-123" }).success).toBe(
      true,
    );
  });
});

describe("每日频控配置", () => {
  it("默认 50；非法值回退默认；下限 1", () => {
    const previous = process.env.AI_DAILY_LIMIT;
    try {
      delete process.env.AI_DAILY_LIMIT;
      expect(dailyAiLimit()).toBe(50);
      process.env.AI_DAILY_LIMIT = "not-a-number";
      expect(dailyAiLimit()).toBe(50);
      process.env.AI_DAILY_LIMIT = "3.7";
      expect(dailyAiLimit()).toBe(3);
      process.env.AI_DAILY_LIMIT = "0";
      expect(dailyAiLimit()).toBe(50);
    } finally {
      if (previous === undefined) {
        delete process.env.AI_DAILY_LIMIT;
      } else {
        process.env.AI_DAILY_LIMIT = previous;
      }
    }
  });
});
