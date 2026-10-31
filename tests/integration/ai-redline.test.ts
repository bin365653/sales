import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  registerTestModelConfig,
} from "./helpers";
import { createLead, updateLead } from "@/server/services/leads";
import { createModelConfig } from "@/server/ai/model-configs";
import { createAiRun, executeRun } from "@/server/ai/runner";
import { createInteraction } from "@/server/services/interactions";

// V2.0-T12 AI 红线验收（PRD 模块八 / 实施计划 §7 / V2.4 验收）：
// ① AI 全链路零业务写回：analysis/call_prep/followup_advice 三类 run 全部
//    成功后，线索行/核实元数据/沟通/任务/周期台账/事件表零变化（AI 输出
//    只写 ai_runs.output，K3）；
// ② 人工确认流回归：AI 摘要草稿仅作为来源引用（ai_run_id），客户信息更新
//    只发生在销售保存沟通记录时（服务链路），AI run 本身不被修改；
// ③ 空/极少画像客户：全空画像 run 成功且零写回（不编造 → 输出仅留痕）；
// ④ 快照脱敏：followup_context 与 profile_v2 均不含联系方式与核实人身份。

afterAll(cleanupTestUsers);

const SECRET_KEY = "sk-integration-secret-9876543210";

const OUTPUTS: Record<string, unknown> = {
  analysis: {
    fit: { level: "insufficient", reason: "信息不足，无法判断匹配度" },
    facts: [{ topic: "在用系统", detail: "手工台账", status: "unverified" }],
    pains: [],
    angles: ["先核实当前系统使用现状"],
    next_action: "电话核实当前系统与到期时间",
    verify_questions: ["目前用什么系统记账？", "软件什么时候到期？"],
    gaps: [{ field: "sales_team_scale", question: "业务员几个人？" }],
    contradictions: [],
  },
  call_prep: {
    goal: "核实系统现状与到期时间",
    opening: "您好，想跟您聊聊店里开单的流程。",
    diag_questions: ["现在用什么开单？", "几个人开单？", "到期续费谁负责？"],
    objections: [
      { objection: "再用用看", response: "好的，先发资料给您参考" },
      { objection: "没时间", response: "约个方便的短电话" },
    ],
    confirm_next: "确认下次联系时间",
    avoid: ["不要断言到期日期（未核实）"],
  },
  followup_advice: {
    reason_explanation: "该客户由系统按到期月度规则生成本月跟进任务。",
    communication_advice: "核实续费意向，顺带补全核心画像。",
  },
  interaction_summary: {
    summary: "客户要求下周再联系。",
    next_action: "下周回访",
  },
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function setupCase() {
  const admin = await createTestUser("admin");
  const sales = await createTestUser("sales");
  const config = await createModelConfig(admin, {
    baseUrl: "https://api.mock-provider.local/v1",
    modelName: "mock-model",
    apiKey: SECRET_KEY,
    timeoutMs: 5000,
    maxRetries: 1,
    isActive: true,
  });
  registerTestModelConfig(config.id);
  return { sales, config };
}

interface BusinessSnapshot {
  lead: { dataVersion: number; quadrantCode: string | null; lastContactAt: Date | null; profileStatus: string | null };
  verifications: number;
  interactions: number;
  tasks: number;
  cycles: number;
  events: number;
}

async function snapshotBusiness(leadId: string): Promise<BusinessSnapshot> {
  const [lead, verifications, interactions, tasks, cycles, events] = await Promise.all([
    prisma.lead.findUniqueOrThrow({ where: { id: leadId } }),
    prisma.leadFieldVerification.count({ where: { leadId } }),
    prisma.interaction.count({ where: { leadId } }),
    prisma.task.count({ where: { leadId } }),
    prisma.followUpCycle.count({ where: { leadId } }),
    prisma.leadEvent.count({ where: { leadId } }),
  ]);
  return {
    lead: {
      dataVersion: lead.dataVersion,
      quadrantCode: lead.quadrantCode,
      lastContactAt: lead.lastContactAt,
      profileStatus: lead.profileStatus,
    },
    verifications,
    interactions,
    tasks,
    cycles,
    events,
  };
}

function expectSameBusiness(before: BusinessSnapshot, after: BusinessSnapshot): void {
  expect(after.lead.dataVersion).toBe(before.lead.dataVersion);
  expect(after.lead.quadrantCode).toBe(before.lead.quadrantCode);
  expect(after.lead.profileStatus).toBe(before.lead.profileStatus);
  expect(after.lead.lastContactAt).toEqual(before.lead.lastContactAt);
  expect(after.verifications).toBe(before.verifications);
  expect(after.interactions).toBe(before.interactions);
  expect(after.tasks).toBe(before.tasks);
  expect(after.cycles).toBe(before.cycles);
  expect(after.events).toBe(before.events);
}

describe("AI 红线：全链路零业务写回（K3）", () => {
  it("三类 run 全部成功后业务表零变化；输出只写 ai_runs.output", async () => {
    const { sales } = await setupCase();
    const lead = await createLead(sales, {
      name: "T12 红线客户",
      currentSystem: "手工台账（Excel/纸质）",
      contactPhone: "13900009999",
    });
    const before = await snapshotBusiness(lead.id);

    for (const runType of ["analysis", "call_prep", "followup_advice"] as const) {
      const run = await createAiRun(sales, { leadId: lead.id, runType }, { execute: false });
      const finished = await executeRun(run.id, {
        fetchImpl: async () => okResponse(JSON.stringify(OUTPUTS[runType])),
      });
      expect(finished.status).toBe("success");
    }

    const after = await snapshotBusiness(lead.id);
    expectSameBusiness(before, after);

    // 快照脱敏：任一 run 的快照不含电话明文与核实人身份
    const runs = await prisma.aiRun.findMany({ where: { leadId: lead.id } });
    expect(runs).toHaveLength(3);
    for (const run of runs) {
      const text = JSON.stringify(run.inputSnapshot);
      expect(text).not.toContain("13900009999");
      expect(text).not.toContain("verifiedBy");
      expect(text).not.toContain("verified_by");
    }
    // runs 本身只写自己的行
    expect(runs.every((run) => run.status === "success")).toBe(true);
  });

  it("空画像客户（全空字段）run 成功且零写回（不编造→仅留痕）", async () => {
    const { sales } = await setupCase();
    const lead = await createLead(sales, { name: "T12 空画像客户" });
    const before = await snapshotBusiness(lead.id);
    const run = await createAiRun(sales, { leadId: lead.id, runType: "analysis" }, { execute: false });
    const finished = await executeRun(run.id, {
      fetchImpl: async () => okResponse(JSON.stringify(OUTPUTS.analysis)),
    });
    expect(finished.status).toBe("success");
    const output = finished.output as { fit?: { level?: string } };
    // 空画像 → 模型（mock 固定输出）与提示词口径下匹配度为信息不足
    expect(output.fit?.level).toBe("insufficient");
    expectSameBusiness(before, await snapshotBusiness(lead.id));
  });
});

describe("AI 红线：人工确认流（AI 建议 → 销售保存才更新客户）", () => {
  it("interaction_summary 草稿经 ai_run_id 引用；客户更新发生在沟通保存（AI run 不变）", async () => {
    const { sales } = await setupCase();
    const lead = await createLead(sales, {
      name: "T12 确认流客户",
      currentSystem: "手工台账（Excel/纸质）",
    });
    // AI 生成摘要草稿（不执行业务写）
    const run = await createAiRun(
      sales,
      {
        leadId: lead.id,
        runType: "interaction_summary",
        notes: "客户说下周再联系，目前在用表格记账。",
      },
      { execute: false },
    );
    const finished = await executeRun(run.id, {
      fetchImpl: async () => okResponse(JSON.stringify(OUTPUTS.interaction_summary)),
    });
    expect(finished.status).toBe("success");
    const runBefore = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });

    // 销售确认保存沟通记录（引用草稿 run；本次确认写值走服务链路）
    await createInteraction(sales, lead.id, {
      occurredAt: new Date().toISOString().slice(0, 10),
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      feedback: "客户说下周再联系（已按 AI 草稿核对修改）。",
      aiRunId: run.id,
    } as never);

    const after = await prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    // AI run 本身不被后续业务操作修改（历史可复现）
    expect(after.output).toEqual(runBefore.output);
    expect(after.status).toBe(runBefore.status);
    // 客户更新来自销售保存（lastContactAt 被沟通写入），不是 AI 写回
    const leadAfter = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(leadAfter.lastContactAt).not.toBeNull();
    const interactions = await prisma.interaction.findMany({ where: { leadId: lead.id } });
    expect(interactions).toHaveLength(1);
    expect(interactions[0]!.aiRunId).toBe(run.id);
  });

  it("对照：AI 输出本身不改变核实状态——updateLead 由销售动作驱动", async () => {
    const { sales } = await setupCase();
    const lead = await createLead(sales, {
      name: "T12 对照客户",
      currentSystem: "手工台账（Excel/纸质）",
    });
    const beforeVerifications = await prisma.leadFieldVerification.findMany({
      where: { leadId: lead.id },
    });
    const run = await createAiRun(sales, { leadId: lead.id, runType: "followup_advice" }, { execute: false });
    await executeRun(run.id, {
      fetchImpl: async () => okResponse(JSON.stringify(OUTPUTS.followup_advice)),
    });
    const afterVerifications = await prisma.leadFieldVerification.findMany({
      where: { leadId: lead.id },
    });
    // AI 成功后核实行原样（状态/来源/核实人/时间）
    expect(afterVerifications).toEqual(beforeVerifications);

    // 销售编辑保存 → 核实状态才变化（值变化自动 unverified，T01 链路）
    const leadRow = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    await updateLead(sales, lead.id, {
      dataVersion: leadRow.dataVersion,
      currentSystem: "管家婆",
    } as never);
    const changed = await prisma.leadFieldVerification.findFirstOrThrow({
      where: { leadId: lead.id, fieldKey: "current_system" },
    });
    expect(changed.status).toBe("unverified");
    expect(changed.source).toBe("manual");
  });
});
