import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { createLead, updateLead } from "@/server/services/leads";
import { createTask } from "@/server/services/tasks";
import { runTaskGeneration } from "@/server/services/task-generation";
import { addExpiryMonths, currentExpiryMonth } from "@/lib/expiry";

// V2.0-T08：PRD 最终验收场景 A–H 全量自动化（实施计划 §9 映射表）。
// 走真实服务链路（createLead/updateLead/createTask + runTaskGeneration），
// 象限由 recomputeLeadClassification 重算（迭代一引擎），任务由迭代二引擎生成。

const admin: { value: TestUser | null } = { value: null };
const createdLeadIds: string[] = [];

beforeAll(async () => {
  admin.value = await createTestUser("admin");
});

afterAll(async () => {
  if (createdLeadIds.length > 0) {
    await prisma.task.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.followUpCycle.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.leadFieldVerification.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.leadEvent.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  }
  await cleanupTestUsers();
});

const MONTH = () => currentExpiryMonth(new Date());

/** 场景造数：经 createLead 真实链路（象限同事务重算），可回填 createdAt 模拟老客户 */
async function createScenarioLead(options: {
  name: string;
  nextGen: boolean | null;
  interest: boolean | null;
  expiryMonth?: string | null;
  /** created_at 回填天数（周期任务 anchor 欠账用） */
  backdateDays?: number;
}): Promise<string> {
  const verifications: Record<string, string> = {};
  if (options.nextGen !== null) {
    verifications.next_gen_mobile_order = "confirmed";
  }
  if (options.interest !== null) {
    verifications.qince_interest = "confirmed";
  }
  if (options.expiryMonth) {
    verifications.contract_expiry = "confirmed";
  }
  const lead = await createLead(admin.value!, {
    name: `${options.name}-${uniqueSuffix()}`,
    nextGenMobileOrder: options.nextGen ?? undefined,
    qinceInterest: options.interest ?? undefined,
    contractExpiry: options.expiryMonth ? `${options.expiryMonth}-01` : undefined,
    verifications,
  } as never);
  createdLeadIds.push(lead.id);
  if (options.backdateDays && options.backdateDays > 0) {
    // 模拟「N 天前已分类」的老客户：anchor = max(…, quadrant_computed_at, createdAt)
    // —— 分类时间不回填则 anchor 恒为现在，周期任务自然排期到未来（§4.5 语义）
    const backdated = new Date(Date.now() - options.backdateDays * 24 * 3600 * 1000);
    await prisma.lead.update({
      where: { id: lead.id },
      data: { createdAt: backdated, quadrantComputedAt: backdated },
    });
  }
  return lead.id;
}

async function pendingAutoTasks(leadId: string) {
  return prisma.task.findMany({
    where: { leadId, status: "pending" },
    orderBy: { createdAt: "asc" },
  });
}

describe("PRD 验收场景 A–H（实施计划 §9）", () => {
  it("场景 A：新一代+有意愿+10 个月后到期 → 象限 A；无月度；按 A 策略（30 天）周期任务", async () => {
    const leadId = await createScenarioLead({
      name: "场景A",
      nextGen: true,
      interest: true,
      expiryMonth: addExpiryMonths(MONTH(), 10),
      backdateDays: 40,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.quadrantCode).toBe("a");

    const stats = await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    expect(stats.createdTasks).toBe(1);
    const tasks = await pendingAutoTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sourceType).toBe("quadrant_periodic");
    expect(tasks[0]!.title).toBe("四象限周期跟进（A·30天）");
  });

  it("场景 B：新一代+无意愿+4 个月后到期 → 象限 B；当月月度任务生成（互斥：月度优先，无周期任务）", async () => {
    const leadId = await createScenarioLead({
      name: "场景B",
      nextGen: true,
      interest: false,
      expiryMonth: addExpiryMonths(MONTH(), 4),
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.quadrantCode).toBe("b");

    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    const tasks = await pendingAutoTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sourceType).toBe("expiry_monthly");
    expect(tasks[0]!.title).toBe(`软件到期月度跟进（${MONTH()}）`);
  });

  it("场景 C：未用新一代+有意愿+3 个月后到期 → 象限 C；当月月度任务", async () => {
    const leadId = await createScenarioLead({
      name: "场景C",
      nextGen: false,
      interest: true,
      expiryMonth: addExpiryMonths(MONTH(), 3),
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.quadrantCode).toBe("c");

    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    const tasks = await pendingAutoTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sourceType).toBe("expiry_monthly");
  });

  it("场景 D：未用新一代+无意愿+12 个月后到期 → 象限 D；按 D 策略（90 天）培育任务；无月度", async () => {
    const leadId = await createScenarioLead({
      name: "场景D",
      nextGen: false,
      interest: false,
      expiryMonth: addExpiryMonths(MONTH(), 12),
      backdateDays: 100,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.quadrantCode).toBe("d");

    const stats = await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    expect(stats.createdTasks).toBe(1);
    const tasks = await pendingAutoTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sourceType).toBe("quadrant_periodic");
    expect(tasks[0]!.title).toBe("四象限周期跟进（D·90天）");
  });

  it("场景 E：系统/意愿/到期全未知 → 画像待完善（不误分类）；生成画像补充任务", async () => {
    const leadId = await createScenarioLead({
      name: "场景E",
      nextGen: null,
      interest: null,
    });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.quadrantCode).toBeNull();

    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    const tasks = await pendingAutoTasks(leadId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.sourceType).toBe("profile_gap");
    expect(tasks[0]!.title).toBe("画像补充核实");
  });

  it("场景 F：无意愿 → 明确表达愿意 → 象限重算 D→C（quadrant_changed）；未来计划重算、旧周期任务取消", async () => {
    const leadId = await createScenarioLead({
      name: "场景F",
      nextGen: false,
      interest: false,
      expiryMonth: addExpiryMonths(MONTH(), 12),
      backdateDays: 100,
    });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).quadrantCode).toBe("d");
    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    const oldTask = (await pendingAutoTasks(leadId)).find(
      (task) => task.sourceType === "quadrant_periodic",
    )!;
    expect(oldTask).toBeDefined();

    // 意愿改是（显式确认状态，同沟通确认语义）
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    await updateLead(admin.value!, leadId, {
      dataVersion: before.dataVersion,
      qinceInterest: true,
      verifications: { qince_interest: "confirmed" },
    } as never);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(after.quadrantCode).toBe("c");
    // 旧周期任务取消；新 C 计划按 anchor=分类时间排期到 14 天后（当前不生成）
    expect((await prisma.task.findUniqueOrThrow({ where: { id: oldTask.id } })).status).toBe(
      "canceled",
    );
    expect((await pendingAutoTasks(leadId)).filter((t) => t.autoGenerated)).toHaveLength(0);
    const events = await prisma.leadEvent.findMany({
      where: { leadId, eventType: { in: ["quadrant_changed", "plan_changed"] } },
      orderBy: { occurredAt: "asc" },
    });
    expect(events.map((event) => event.eventType)).toContain("quadrant_changed");
    expect(events.map((event) => event.eventType)).toContain("plan_changed");
    const planEvent = events.find((event) => event.eventType === "plan_changed")!;
    expect((planEvent.detail as { reason: string }).reason).toBe("interest_updated");
  });

  it("场景 G：已预约下周演示 + 本月周期任务并存 → 预约任务不被覆盖；同月月度任务仅 1 条", async () => {
    const leadId = await createScenarioLead({
      name: "场景G",
      nextGen: false,
      interest: true,
      expiryMonth: addExpiryMonths(MONTH(), 2),
    });
    // 客户预约了下周演示（manual + online_demo，priority 2）
    const demo = await createTask(admin.value!, {
      leadId,
      type: "online_demo",
      title: "场景G-下周演示",
      dueAt: new Date(Date.now() + 7 * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10),
    } as never);

    // 生成执行两轮：预约任务存在期间，月度任务照常（系统强制）且同月仅 1 条
    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });

    const tasks = await prisma.task.findMany({ where: { leadId, status: "pending" } });
    const demoTask = tasks.find((task) => task.id === demo.id);
    expect(demoTask).toBeDefined();
    expect(demoTask!.sourceType).toBe("manual");
    expect(demoTask!.priority).toBe(2);
    const monthly = tasks.filter((task) => task.sourceType === "expiry_monthly");
    expect(monthly).toHaveLength(1);
    // 无周期任务（月度互斥 + 预约优先）
    expect(tasks.filter((task) => task.sourceType === "quadrant_periodic")).toHaveLength(0);
  });

  it("场景 H：到期 8 个月后更新为 4 个月后 → 旧周期任务取消、当月月度生成；历史保留（done 不动 + plan_changed）", async () => {
    const leadId = await createScenarioLead({
      name: "场景H",
      nextGen: true,
      interest: true,
      expiryMonth: addExpiryMonths(MONTH(), 8),
      backdateDays: 40,
    });
    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    const oldTask = (await pendingAutoTasks(leadId)).find(
      (task) => task.sourceType === "quadrant_periodic",
    )!;
    // 历史完成任务（更早轮次）
    const doneTask = await prisma.task.create({
      data: {
        leadId,
        assigneeId: admin.value!.id,
        createdBy: admin.value!.id,
        type: "follow_up",
        title: "场景H-历史已完成",
        dueAt: new Date(Date.now() - 20 * 24 * 3600 * 1000),
        status: "done",
        completedAt: new Date(Date.now() - 19 * 24 * 3600 * 1000),
        sourceType: "quadrant_periodic",
        autoGenerated: true,
        priority: 5,
      },
    });

    // 到期更新为 4 个月后（进入半年窗口）
    const before = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    await updateLead(admin.value!, leadId, {
      dataVersion: before.dataVersion,
      contractExpiry: `${addExpiryMonths(MONTH(), 4)}-01`,
    } as never);

    // 旧周期任务取消、当月月度生成、done 历史不动
    expect((await prisma.task.findUniqueOrThrow({ where: { id: oldTask.id } })).status).toBe(
      "canceled",
    );
    const monthly = (await pendingAutoTasks(leadId)).find(
      (task) => task.sourceType === "expiry_monthly",
    );
    expect(monthly).toBeDefined();
    expect(monthly!.title).toBe(`软件到期月度跟进（${MONTH()}）`);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: doneTask.id } })).status).toBe(
      "done",
    );
    // plan_changed 事件（reason=expiry_updated）
    const event = await prisma.leadEvent.findFirst({
      where: { leadId, eventType: "plan_changed" },
      orderBy: { occurredAt: "desc" },
    });
    expect((event!.detail as { reason: string }).reason).toBe("expiry_updated");
  });

  it("场景收尾：A–H 客户的阶段流转到 won 后 pending 自动任务全部取消（防重 #4）", async () => {
    const leadId = await createScenarioLead({
      name: "场景终态",
      nextGen: true,
      interest: true,
      expiryMonth: addExpiryMonths(MONTH(), 2),
    });
    await runTaskGeneration({ leadIds: [leadId], actorId: admin.value!.id });
    expect((await pendingAutoTasks(leadId)).length).toBeGreaterThan(0);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    const { transitionStage } = await import("@/server/services/leads");
    await transitionStage(admin.value!, leadId, {
      stageId: (await getPresetStage("won")).id,
      dataVersion: lead.dataVersion,
    } as never);
    expect(await pendingAutoTasks(leadId)).toHaveLength(0);
  });
});
