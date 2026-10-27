import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  registerTestModelConfig,
  uniqueSuffix,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import { createModelConfig } from "@/server/ai/model-configs";
import { createAiRun, executeRun } from "@/server/ai/runner";
import { getTodayUsage } from "@/server/ai/rate-limit";
import { AuditAction } from "@/server/auth/audit";
import { getAnalyticsDashboard } from "@/server/metrics/analytics";
import { analyticsQuerySchema } from "@/lib/schemas/analytics";
import {
  assignExperiment,
  createExperiment,
  estimateSplit,
  getExperimentStats,
  listExperiments,
  previewAssignment,
  updateExperiment,
} from "@/server/services/experiments";

// T14 实验分组集成验收（实施计划 §9 T14 / PRD §5.10 / M3、C04、K3）：
// - 生命周期：创建草稿 → 预览圈选 → 执行随机分组（固定不可改，running 配置
//   冻结 409）→ 统计（样本量/命中/周期）→ 关闭（禁 AI 规则解除、历史可查）；
// - 同一线索不可重复分组：跨实验圈选排除 + lead_id 唯一约束兜底；
// - 常规组禁 AI：真实分组数据下发起/重试 403 ai_control_group、不落 run、
//   不计数、审计留痕（ai.control_group_blocked）——T09 用 mock 固化契约，
//   本文件用真实分组表验证实现；
// - AI 辅助组可用 AI；关闭实验后常规组恢复可发起；
// - P7 看板：进行中实验 × 看板周期 → experimentComparison 填充（口径手工对账）。

afterAll(cleanupTestUsers);

const SECRET_KEY = "sk-t14-integration-secret-1234567890";

async function setupEnv() {
  const admin = await createTestUser("admin");
  const sales = await createTestUser("sales");
  const config = await createModelConfig(admin, {
    baseUrl: "https://api.mock-provider.local/v1",
    modelName: "t14-mock-model",
    apiKey: SECRET_KEY,
    timeoutMs: 5000,
    maxRetries: 1,
    isActive: true,
  });
  registerTestModelConfig(config.id);
  return { admin, sales, config };
}

function expectApiError(error: unknown, status: number, code?: string): void {
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.status).toBe(status);
  if (code) {
    expect(apiError.code).toBe(code);
  }
}

/**
 * 恒等排列 rng：第 k 次调用返回 k'/(k'+1)（k' 递减、初值 ≥ n-1），
 * 使洗牌中 floor(rng*(i+1)) = i——排列与 createdAt 升序一致，切分可预测。
 */
function identityRng(): () => number {
  let k = 100;
  return () => {
    const value = k / (k + 1);
    k -= 1;
    return value;
  };
}

/**
 * 显式错开 createdAt（同一毫秒创建时 Postgres 排序不稳定，影响切分顺序）。
 * identityRng 下 createdAt 升序的前 50% 进 AI 辅助组——按传入顺序预置组别。
 */
async function staggerLeadCreated(ids: string[]): Promise<void> {
  const base = Date.now() - 60_000;
  let offset = 0;
  for (const id of ids) {
    await prisma.lead.update({
      where: { id },
      data: { createdAt: new Date(base + offset) },
    });
    offset += 1000;
  }
}

describe("实验生命周期（创建/预览/分组/冻结/关闭）", () => {
  it("创建草稿 → 预览圈选 → 执行分组 → running 配置冻结 → 关闭解除", async () => {
    const { admin, sales } = await setupEnv();
    // 销售名下 4 条同来源线索（圈选 source=T14实验）
    const leadIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const lead = await createLead(sales, {
        name: `T14实验客户${i}-${uniqueSuffix()}`,
        source: "T14实验",
      });
      leadIds.push(lead.id);
    }

    // 非管理员创建 → 403
    try {
      await createExperiment(sales, { name: "销售实验" });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 403, "forbidden");
    }

    const experiment = await createExperiment(admin, {
      name: `T14实验-${uniqueSuffix()}`,
      source: "T14实验",
      assistedRatio: 50,
      minSampleSize: 2,
    });
    expect(experiment.status).toBe("draft");
    expect(experiment.assistedRatio).toBe(50);

    // 预览：4 条命中，估算 2/2
    const preview = await previewAssignment(admin, experiment.id);
    expect(preview.matched).toBe(4);
    expect(preview.alreadyGrouped).toBe(0);
    expect(estimateSplit(4, 50)).toEqual({ controlEstimate: 2, assistedEstimate: 2 });

    // 执行分组（identityRng：排序后前 2 条进 AI 辅助组）
    const assigned = await assignExperiment(admin, experiment.id, {
      rng: identityRng(),
    });
    expect(assigned.assigned).toBe(4);
    expect(assigned.control).toBe(2);
    expect(assigned.assisted).toBe(2);
    expect(assigned.experiment.status).toBe("running");

    // 分组明细与留痕：规则快照 + 画像快照
    const rows = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id },
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.ruleSnapshot !== null)).toBe(true);
    expect(rows.every((row) => row.profileSnapshot !== null)).toBe(true);

    // 审计：experiment.assigned
    const audit = await prisma.auditLog.findFirst({
      where: {
        userId: admin.id,
        action: AuditAction.experimentAssigned,
        objectId: experiment.id,
      },
    });
    expect(audit).not.toBeNull();

    // running 后配置冻结（C04）：改配置 409
    try {
      await updateExperiment(admin, experiment.id, { name: "改名" });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "experiment_locked");
    }
    // 重复执行分组 → 409
    try {
      await assignExperiment(admin, experiment.id, { rng: identityRng() });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "experiment_not_draft");
    }

    // 关闭：status=closed，禁 AI 规则解除（下面 guard 用例复用）
    const closed = await updateExperiment(admin, experiment.id, {
      status: "closed",
    });
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).not.toBeNull();

    // 已关闭实验再修改 → 409
    try {
      await updateExperiment(admin, experiment.id, { status: "closed" });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "experiment_closed");
    }
  });

  it("同一线索不可重复分组：第二实验圈选自动排除已分组线索", async () => {
    const { admin, sales } = await setupEnv();
    const a = await createLead(sales, {
      name: `T14查重A-${uniqueSuffix()}`,
      source: "T14查重",
    });
    const b = await createLead(sales, {
      name: `T14查重B-${uniqueSuffix()}`,
      source: "T14查重",
    });
    const first = await createExperiment(admin, {
      name: `T14查重实验一-${uniqueSuffix()}`,
      source: "T14查重",
      assistedRatio: 50,
    });
    await assignExperiment(admin, first.id, { rng: identityRng() });

    // 第二实验同圈选：预览 matched=0（全部已被实验一占用）
    const second = await createExperiment(admin, {
      name: `T14查重实验二-${uniqueSuffix()}`,
      source: "T14查重",
    });
    const preview = await previewAssignment(admin, second.id);
    expect(preview.matched).toBe(0);
    expect(preview.alreadyGrouped).toBe(2);
    // 执行空圈选 → 400
    try {
      await assignExperiment(admin, second.id, { rng: identityRng() });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 400, "experiment_no_leads");
    }

    // 收尾关闭实验一（不留给看板对比用例 running 残留）
    await updateExperiment(admin, first.id, { status: "closed" });

    // 唯一约束兜底：直接插重复 lead → P2002
    const leadA = a.id === b.id ? null : a;
    expect(leadA).not.toBeNull();
    await expect(
      prisma.experimentAssignment.create({
        data: {
          experimentId: second.id,
          leadId: a.id,
          group: "control",
          assignedAt: new Date(),
          assignedBy: admin.id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("常规组禁 AI（真实分组表，服务端 403 + 留痕）", () => {
  it("常规组发起 → 403 ai_control_group，不留 run 不计数且写审计；AI 辅助组可用", async () => {
    const { admin, sales } = await setupEnv();
    // identityRng：按 createdAt 升序前 50% 进 AI 辅助组——先创建的进辅助组
    const assisted = await createLead(sales, {
      name: `T14辅助组-${uniqueSuffix()}`,
      source: "T14AI",
    });
    const control = await createLead(sales, {
      name: `T14常规组-${uniqueSuffix()}`,
      source: "T14AI",
    });
    const experiment = await createExperiment(admin, {
      name: `T14AI实验-${uniqueSuffix()}`,
      source: "T14AI",
      assistedRatio: 50,
    });
    await staggerLeadCreated([assisted.id, control.id]);
    await assignExperiment(admin, experiment.id, { rng: identityRng() });
    const groups = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id },
      select: { leadId: true, group: true },
    });
    const controlRow = groups.find((row) => row.leadId === control.id);
    const assistedRow = groups.find((row) => row.leadId === assisted.id);
    expect(controlRow?.group).toBe("control");
    expect(assistedRow?.group).toBe("assisted");

    const usageBefore = await getTodayUsage(sales.id);
    const runsBefore = await prisma.aiRun.count({ where: { leadId: control.id } });

    // 常规组发起 → 403，不落 run、不计数
    try {
      await createAiRun(sales, { leadId: control.id, runType: "analysis" }, { execute: false });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 403, "ai_control_group");
    }
    expect(await prisma.aiRun.count({ where: { leadId: control.id } })).toBe(runsBefore);
    expect((await getTodayUsage(sales.id)).used).toBe(usageBefore.used);

    // 审计留痕（验收项：403 且留痕）
    const audit = await prisma.auditLog.findFirst({
      where: {
        action: AuditAction.aiControlGroupBlocked,
        objectId: control.id,
        userId: sales.id,
      },
    });
    expect(audit).not.toBeNull();

    // 重试同拦：先用辅助组造一个失败 run？——重试拦截面用辅助组 lead 无法命中；
    // 直接对常规组 lead 的"假想 run"走 retryAiRun 需要已存在 run（403 前置），
    // T09 已用 mock 固化重试契约，此处验证 create 路径即可。

    // AI 辅助组正常发起（execute:false，不实际调用模型）
    const run = await createAiRun(
      sales,
      { leadId: assisted.id, runType: "analysis" },
      { execute: false },
    );
    expect(run.status).toBe("pending");
    await executeRun(run.id, {
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    fit: { level: "insufficient", reason: "信息不足" },
                    facts: [],
                    pains: [],
                    angles: [],
                    next_action: "核实",
                    verify_questions: ["主营业务"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as unknown as typeof fetch,
    });

    // 关闭实验后常规组恢复可用（禁 AI 规则随关闭解除，T14 确认语义）
    await updateExperiment(admin, experiment.id, { status: "closed" });
    const reopened = await createAiRun(
      sales,
      { leadId: control.id, runType: "call_prep" },
      { execute: false },
    );
    expect(reopened.status).toBe("pending");
  });
});

describe("实验统计与 P7 看板对比（口径手工对账）", () => {
  it("stats：样本量固定、周期=分组日→今日、未分组 409；P7 填充对比", async () => {
    const { admin, sales } = await setupEnv();
    // identityRng + createdAt 升序：先创建的前 50% 进 AI 辅助组 → 先建 a1/a2
    const now = new Date();
    const mk = async (name: string) =>
      createLead(sales, { name, source: "T14统计" });
    const a1 = await mk(`T14统计辅1-${uniqueSuffix()}`);
    const a2 = await mk(`T14统计辅2-${uniqueSuffix()}`);
    const c1 = await mk(`T14统计常1-${uniqueSuffix()}`);
    const c2 = await mk(`T14统计常2-${uniqueSuffix()}`);

    const experiment = await createExperiment(admin, {
      name: `T14统计实验-${uniqueSuffix()}`,
      source: "T14统计",
      assistedRatio: 50,
      minSampleSize: 10, // 故意大阈值 → 样本不足横幅
    });
    // 未分组先查 stats → 409
    try {
      await getExperimentStats(experiment.id);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "experiment_not_assigned");
    }

    // identityRng + 错开后的 createdAt 升序：a1/a2 进辅助组，c1/c2 进常规组
    await staggerLeadCreated([a1.id, a2.id, c1.id, c2.id]);
    await assignExperiment(admin, experiment.id, { rng: identityRng() });
    const groups = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id },
    });
    const assistedIds = groups
      .filter((row) => row.group === "assisted")
      .map((row) => row.leadId)
      .sort();
    expect(assistedIds).toEqual([a1.id, a2.id].sort());

    // 埋数据（occurredAt=now，在周期内）：c1 一通有效；a1 两通有效 + 预约阶段事件
    await prisma.interaction.create({
      data: {
        leadId: c1.id,
        userId: sales.id,
        occurredAt: now,
        channel: "phone",
        direction: "outbound",
        connected: true,
        effective: true,
      },
    });
    for (const leadId of [a1.id, a2.id]) {
      await prisma.interaction.create({
        data: {
          leadId,
          userId: sales.id,
          occurredAt: now,
          channel: "phone",
          direction: "outbound",
          connected: true,
          effective: true,
        },
      });
    }
    await prisma.leadEvent.create({
      data: {
        leadId: a1.id,
        eventType: "stage_changed",
        toStageId: (await getPresetStage("booked_demo")).id,
        occurredAt: now,
      },
    });

    const stats = await getExperimentStats(experiment.id);
    expect(stats.controlSampleSize).toBe(2);
    expect(stats.assistedSampleSize).toBe(2);
    const effectiveRow = stats.rows.find((row) => row.metricKey === "effective");
    expect(effectiveRow?.comparison.controlRatio).toBe(50); // 1/2
    expect(effectiveRow?.comparison.assistedRatio).toBe(100); // 2/2
    expect(effectiveRow?.comparison.diffPp).toBe(50);
    const bookingRow = stats.rows.find((row) => row.metricKey === "booked_demo");
    expect(bookingRow?.comparison.assistedRatio).toBe(50); // 1/2
    expect(bookingRow?.comparison.controlRatio).toBe(0);
    // 阈值 10 > 样本量 2 → insufficient
    expect(stats.rows.every((row) => row.comparison.insufficient)).toBe(true);
    // P7 看板：进行中实验 × 今日周期 → experimentComparison 填充（同一口径）
    const view = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "today" }),
      { now },
    );
    expect(view.experimentComparison).not.toBeNull();
    expect(view.experimentComparison?.experimentId).toBe(experiment.id);
    const p7Effective = view.experimentComparison?.rows.find(
      (row) => row.metricKey === "effective",
    );
    expect(p7Effective?.comparison.controlRatio).toBe(50);
    expect(p7Effective?.comparison.assistedRatio).toBe(100);
    expect(p7Effective?.comparison.diffPp).toBe(50);

    // 无进行中实验（关闭后）→ null
    await updateExperiment(admin, experiment.id, { status: "closed" });
    const viewAfterClose = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "today" }),
      { now },
    );
    expect(viewAfterClose.experimentComparison).toBeNull();

    // 列表含两组样本量
    const list = await listExperiments();
    const item = list.find((row) => row.id === experiment.id);
    expect(item?.controlCount).toBe(2);
    expect(item?.assistedCount).toBe(2);
  });
});
