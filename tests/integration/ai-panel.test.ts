import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  registerTestModelConfig,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import { createModelConfig } from "@/server/ai/model-configs";
import {
  createAiRun,
  executeRun,
  getAiRun,
  listLeadAiRuns,
  retryAiRun,
} from "@/server/ai/runner";
import { getTodayUsage } from "@/server/ai/rate-limit";

// T09 面板链路集成验收（实施计划 §9 T09 / PRD §5.4、§5.5 / UIUX §4.7）：
// - 常规组 403：guard 钩子抛 ai_control_group 时（T14 将替换为真实分组表查询），
//   发起与重试一律 403，且不落 pending run、不消耗每日频控额度；
// - 面板展示字段：历史/轮询返回含模型名与服务商（不含密钥列）+ 提示词版本号；
// - 空线索实测（验收项）：仅名称的线索发起分析/准备卡，输出按"信息不足/unknown"
//   呈现（insufficient + 空 facts），不编造；两种 run 六/八项结构经同一 Zod 校验落库。
// 模型交互经注入 fetchImpl 模拟（真实服务商联调待 C15 提供 base_url+key）。

afterAll(cleanupTestUsers);

// guard mock：默认透传原实现（恒通过）；blockedLeadIds 命中时抛常规组 403。
// 该 mock 仅本文件生效，模拟 T14 接入后的服务端行为契约。
const guardState = vi.hoisted(() => ({ blockedLeadIds: new Set<string>() }));

vi.mock("@/server/ai/guard", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/ai/guard")>();
  return {
    ...original,
    assertAiAllowedForLead: async (leadId: string) => {
      if (guardState.blockedLeadIds.has(leadId)) {
        throw original.controlGroupError();
      }
      return original.assertAiAllowedForLead(leadId);
    },
  };
});

const SECRET_KEY = "sk-t09-integration-secret-1234567890";

const INSUFFICIENT_ANALYSIS = {
  fit: {
    level: "insufficient",
    reason: "输入资料仅含客户名称，信息不足以判断匹配度",
  },
  facts: [],
  pains: [],
  angles: [],
  next_action: "先核实主营业务、团队规模与在用系统",
  verify_questions: ["主营业务是什么", "销售团队规模", "现用系统与到期时间"],
};

const VALID_CALL_PREP = {
  goal: "确认需求与采购时间",
  opening: "您好，占用您一分钟",
  diag_questions: ["现在怎么管理客户？", "几个人用？", "最大的麻烦是什么？"],
  objections: [
    { objection: "太贵", response: "先看效果" },
    { objection: "不需要", response: "先了解现状" },
  ],
  confirm_next: "约定演示时间",
  avoid: ["承诺具体降本比例"],
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function mockFetch(content: string): typeof fetch {
  return (async () =>
    okResponse(content)) as unknown as typeof fetch;
}

function expectApiError(error: unknown, status: number, code?: string): void {
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.status).toBe(status);
  if (code) {
    expect(apiError.code).toBe(code);
  }
}

async function setupCase(leadName: string): Promise<{
  lead: Awaited<ReturnType<typeof createLead>>;
  user: Awaited<ReturnType<typeof createTestUser>>;
}> {
  const admin = await createTestUser("admin");
  const user = await createTestUser("sales");
  const config = await createModelConfig(admin, {
    baseUrl: "https://api.mock-provider.local/v1",
    modelName: "t09-mock-model",
    apiKey: SECRET_KEY,
    timeoutMs: 5000,
    maxRetries: 1,
    isActive: true,
  });
  registerTestModelConfig(config.id);
  const lead = await createLead(user, { name: leadName });
  return { lead, user };
}

describe("常规组拦截（T14 接入位，服务端契约 T09 固化）", () => {
  it("发起 → 403 ai_control_group，不留 run、不消耗频控额度", async () => {
    const { lead, user } = await setupCase("常规组客户");
    guardState.blockedLeadIds.add(lead.id);
    try {
      const runsBefore = await prisma.aiRun.count({ where: { leadId: lead.id } });
      const usageBefore = await getTodayUsage(user.id);

      try {
        await createAiRun(
          user,
          { leadId: lead.id, runType: "analysis" },
          { execute: false },
        );
        throw new Error("should fail");
      } catch (error) {
        expectApiError(error, 403, "ai_control_group");
      }

      expect(await prisma.aiRun.count({ where: { leadId: lead.id } })).toBe(runsBefore);
      const usageAfter = await getTodayUsage(user.id);
      expect(usageAfter.used).toBe(usageBefore.used);
    } finally {
      guardState.blockedLeadIds.delete(lead.id);
    }
  });

  it("重试同样被拦截：失败 run 的重试 → 403（分组后固定，C04）", async () => {
    const { lead, user } = await setupCase("常规组重试客户");
    const failed = await createAiRun(
      user,
      { leadId: lead.id, runType: "call_prep" },
      { execute: false },
    );
    await executeRun(failed.id, { fetchImpl: mockFetch("bad json") });

    guardState.blockedLeadIds.add(lead.id);
    try {
      try {
        await retryAiRun(user, failed.id, { execute: false });
        throw new Error("should fail");
      } catch (error) {
        expectApiError(error, 403, "ai_control_group");
      }
      expect(
        await prisma.aiRun.count({ where: { leadId: lead.id, retryOfId: failed.id } }),
      ).toBe(0);
    } finally {
      guardState.blockedLeadIds.delete(lead.id);
    }
  });
});

describe("面板展示字段（历史/轮询响应）", () => {
  it("含模型名/服务商与提示词版本号，绝无密钥列", async () => {
    const { lead, user } = await setupCase("展示字段客户");
    const run = await createAiRun(
      user,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    await executeRun(run.id, {
      fetchImpl: mockFetch(JSON.stringify(INSUFFICIENT_ANALYSIS)),
    });

    const history = await listLeadAiRuns(user, lead.id);
    expect(history).toHaveLength(1);
    const row = history[0] as unknown as {
      modelConfig: { provider: string; modelName: string };
      promptVersion: { version: number };
    };
    expect(row.modelConfig.modelName).toBe("t09-mock-model");
    expect(row.modelConfig.provider).toBeTruthy();
    expect(row.promptVersion.version).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(history)).not.toContain(SECRET_KEY);
    expect(JSON.stringify(history)).not.toContain("api_key_cipher");

    const single = (await getAiRun(user, run.id)) as unknown as {
      modelConfig: { modelName: string };
      promptVersion: { version: number };
    };
    expect(single.modelConfig.modelName).toBe("t09-mock-model");
    expect(single.promptVersion.version).toBeGreaterThanOrEqual(1);
  });
});

describe("空线索实测（验收项：信息不足输出 unknown，不编造）", () => {
  it("仅名称的线索发起分析：输出 insufficient + 空 facts，结构校验通过并留痕", async () => {
    const { lead, user } = await setupCase("T09 空线索分析");
    const run = await createAiRun(
      user,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const finished = await executeRun(run.id, {
      fetchImpl: mockFetch(JSON.stringify(INSUFFICIENT_ANALYSIS)),
    });
    expect(finished.status).toBe("success");
    const output = finished.output as typeof INSUFFICIENT_ANALYSIS;
    expect(output.fit.level).toBe("insufficient");
    expect(output.facts).toHaveLength(0);
    expect(output.verify_questions.length).toBeGreaterThan(0);
  });

  it("空线索电话准备卡：六项结构齐全落库", async () => {
    const { lead, user } = await setupCase("T09 空线索准备卡");
    const run = await createAiRun(
      user,
      { leadId: lead.id, runType: "call_prep" },
      { execute: false },
    );
    const finished = await executeRun(run.id, {
      fetchImpl: mockFetch(JSON.stringify(VALID_CALL_PREP)),
    });
    expect(finished.status).toBe("success");
    const output = finished.output as typeof VALID_CALL_PREP;
    expect(output.diag_questions).toHaveLength(3);
    expect(output.objections).toHaveLength(2);
    expect(output.avoid.length).toBeGreaterThan(0);
  });
});
