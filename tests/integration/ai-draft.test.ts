import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  registerTestModelConfig,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import { createModelConfig } from "@/server/ai/model-configs";
import { createAiRun, executeRun, retryAiRun } from "@/server/ai/runner";
import { createInteraction } from "@/server/services/interactions";
import { RAW_INTERACTION_NOTES_KEY } from "@/server/ai/context";

// T10 AI 摘要草稿验收项（实施计划 §9 T10 / §7.1 摘要审核流 / PRD §5.6）：
// - notes（原始沟通内容）随快照落 ai_runs.input_snapshot 留痕，重试按原 notes 重建；
// - 未确认不落正式记录：run 成功也不写 interactions，保存始终由用户触发；
// - 确认保存：aiRunId 校验（本人 + 本线索 + interaction_summary + success）后
//   落 interactions.ai_run_id；用户编辑后的最终值与 ai_runs.output 原始输出可区分；
// - 不合法来源（他人线索/其他类型/非终态成功/不存在）一律 400 拒绝，不静默降级。
// 模型交互经注入 fetchImpl 模拟（真实服务商联调待 C15 提供 base_url+key）。

afterAll(cleanupTestUsers);

const SECRET_KEY = "sk-t10-integration-secret-1234567890";

const RAW_NOTES =
  "刚打给王经理，说现在用 Excel 和微信群管客户，导数据很麻烦，问了下价格说要比比看，让我先发资料。";

const SUMMARY_OUTPUT = {
  summary: "客户反馈现用 Excel+微信群管理客户资料，导出数据麻烦；对价格有比较心理，要求先看资料。",
  next_action: "发送产品资料并约定与决策人一起演示",
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function mockFetch(content: string): typeof fetch {
  return (async () => okResponse(content)) as unknown as typeof fetch;
}

async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      if (code) {
        expect(error.code).toBe(code);
      }
      return;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

async function setupCase(leadName: string): Promise<{
  sales: Awaited<ReturnType<typeof createTestUser>>;
  lead: Awaited<ReturnType<typeof createLead>>;
}> {
  const admin = await createTestUser("admin");
  const sales = await createTestUser("sales");
  const config = await createModelConfig(admin, {
    baseUrl: "https://api.mock-provider.local/v1",
    modelName: "t10-mock-model",
    apiKey: SECRET_KEY,
    timeoutMs: 5000,
    maxRetries: 1,
    isActive: true,
  });
  registerTestModelConfig(config.id);
  const lead = await createLead(sales, { name: leadName });
  return { sales, lead };
}

function baseInteractionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    occurredAt: "2026-10-26 10:00",
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: true,
    ...overrides,
  };
}

describe("摘要发起与快照留痕（notes）", () => {
  it("interaction_summary 带 notes：快照含 raw_interaction_notes，data_version 正确", async () => {
    const { sales, lead } = await setupCase("T10 快照留痕客户");
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    expect(run.status).toBe("pending");
    expect(run.inputDataVersion).toBe(lead.dataVersion);
    const snapshot = run.inputSnapshot as Record<string, unknown>;
    const notesEntry = snapshot[RAW_INTERACTION_NOTES_KEY] as
      | { content?: unknown }
      | undefined;
    expect(notesEntry).toBeTruthy();
    expect(notesEntry?.content).toBe(RAW_NOTES);
  });

  it("run 成功不写 interactions（未确认不落正式记录）", async () => {
    const { sales, lead } = await setupCase("T10 未确认客户");
    const before = await prisma.interaction.count({ where: { leadId: lead.id } });
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    const finished = await executeRun(run.id, {
      fetchImpl: mockFetch(JSON.stringify(SUMMARY_OUTPUT)),
    });
    expect(finished.status).toBe("success");
    const output = finished.output as typeof SUMMARY_OUTPUT;
    expect(output.summary).toBe(SUMMARY_OUTPUT.summary);
    expect(output.next_action).toBe(SUMMARY_OUTPUT.next_action);
    expect(await prisma.interaction.count({ where: { leadId: lead.id } })).toBe(before);
  });

  it("失败 run 重试：新 run 沿用原 notes、快照按当前数据重建（retry_of_id 留痕）", async () => {
    const { sales, lead } = await setupCase("T10 重试客户");
    const failed = await createAiRun(
      sales,
      { leadId: lead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    await executeRun(failed.id, { fetchImpl: mockFetch("不是 JSON 的输出") });
    const failedRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: failed.id } });
    expect(failedRow.status).toBe("invalid_output");

    const retried = await retryAiRun(sales, failed.id, { execute: false });
    expect(retried.retryOfId).toBe(failed.id);
    const snapshot = retried.inputSnapshot as Record<string, unknown>;
    const notesEntry = snapshot[RAW_INTERACTION_NOTES_KEY] as
      | { content?: unknown }
      | undefined;
    expect(notesEntry?.content).toBe(RAW_NOTES);
    expect(retried.inputDataVersion).toBe(lead.dataVersion);
  });
});

describe("确认保存：来源登记与可区分", () => {
  it("携带 aiRunId 保存：落 interactions.ai_run_id；用户编辑值与原始输出可区分", async () => {
    const { sales, lead } = await setupCase("T10 确认保存客户");
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    await executeRun(run.id, { fetchImpl: mockFetch(JSON.stringify(SUMMARY_OUTPUT)) });

    const editedFeedback = `${SUMMARY_OUTPUT.summary}（已人工核对：价格异议需重点跟进）`;
    const result = await createInteraction(
      sales,
      lead.id,
      baseInteractionInput({
        feedback: editedFeedback,
        nextAction: SUMMARY_OUTPUT.next_action,
        aiRunId: run.id,
      }) as never,
    );
    expect(result.interaction.aiRunId).toBe(run.id);
    // 原始输出留在 ai_runs.output（不可变），最终记录为用户确认后的值——两者可区分
    const runRow = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(runRow.output).toEqual(SUMMARY_OUTPUT);
    expect(result.interaction.feedback).toBe(editedFeedback);
    expect(result.interaction.feedback).not.toBe(SUMMARY_OUTPUT.summary);
  });

  it("不带 aiRunId 保存：来源为空（人工记录语义不变）", async () => {
    const { sales, lead } = await setupCase("T10 人工记录客户");
    const result = await createInteraction(
      sales,
      lead.id,
      baseInteractionInput({ feedback: "纯手工记录" }) as never,
    );
    expect(result.interaction.aiRunId).toBeNull();
  });
});

describe("aiRunId 校验（不合法来源 400 拒绝）", () => {
  it("他人线索的 run / 其他类型的 run / 非 success 的 run / 不存在的 run 一律 400", async () => {
    const { sales, lead } = await setupCase("T10 校验主客户");

    // 1) 不存在的 run id
    await expectApiError(
      () =>
        createInteraction(
          sales,
          lead.id,
          baseInteractionInput({
            aiRunId: "00000000-0000-0000-0000-000000000000",
          }) as never,
        ),
      400,
      "invalid_ai_run",
    );

    // 2) 他人线索的 interaction_summary run（本用户另一线索）
    const otherLead = await createLead(sales, { name: "T10 另一线索" });
    const foreignRun = await createAiRun(
      sales,
      { leadId: otherLead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    await executeRun(foreignRun.id, { fetchImpl: mockFetch(JSON.stringify(SUMMARY_OUTPUT)) });
    await expectApiError(
      () =>
        createInteraction(
          sales,
          lead.id,
          baseInteractionInput({ aiRunId: foreignRun.id }) as never,
        ),
      400,
      "invalid_ai_run",
    );

    // 3) 非 interaction_summary 类型（analysis 成功 run）
    const analysisRun = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    await executeRun(analysisRun.id, {
      fetchImpl: mockFetch(
        JSON.stringify({
          fit: { level: "mid", reason: "行业匹配" },
          facts: [],
          pains: [],
          angles: [],
          next_action: "跟进",
          verify_questions: ["规模"],
        }),
      ),
    });
    await expectApiError(
      () =>
        createInteraction(
          sales,
          lead.id,
          baseInteractionInput({ aiRunId: analysisRun.id }) as never,
        ),
      400,
      "invalid_ai_run",
    );

    // 4) 非 success 状态（invalid_output 的摘要 run）
    const failedSummary = await createAiRun(
      sales,
      { leadId: lead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    await executeRun(failedSummary.id, { fetchImpl: mockFetch("bad json") });
    await expectApiError(
      () =>
        createInteraction(
          sales,
          lead.id,
          baseInteractionInput({ aiRunId: failedSummary.id }) as never,
        ),
      400,
      "invalid_ai_run",
    );

    // 全部拒绝后：客户沟通记录仍为空（0 条落库）
    expect(await prisma.interaction.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("越权：销售 B 用本人 run 为 A 的线索保存 → 404（归属判定在前）", async () => {
    const owner = await createTestUser("sales");
    const stranger = await createTestUser("sales");
    const lead = await createLead(owner, { name: "T10 越权客户" });
    const strangerLead = await createLead(stranger, { name: "T10 越权他人线索" });
    const run = await createAiRun(
      stranger,
      { leadId: strangerLead.id, runType: "interaction_summary", notes: RAW_NOTES },
      { execute: false },
    );
    await executeRun(run.id, { fetchImpl: mockFetch(JSON.stringify(SUMMARY_OUTPUT)) });

    await expectApiError(
      () =>
        createInteraction(
          stranger,
          lead.id,
          baseInteractionInput({ aiRunId: run.id }) as never,
        ),
      404,
      "not_found",
    );
  });
});
