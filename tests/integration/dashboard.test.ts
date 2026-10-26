import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  registerTestModelConfig,
  type TestUser,
} from "./helpers";
import { computeMetricsSnapshot, currentWeekPeriod, getWorkbenchSummary } from "@/server/metrics/engine";
import { suggestPriorityLeads } from "@/server/metrics/priority";
import { getTaskCounts, listTasks } from "@/server/services/tasks";
import { taskListQuerySchema } from "@/lib/schemas/task";
import { upsertWorktime } from "@/server/services/worktime";

// T12 验收：固定 fixtures 数据集与手工计算逐项一致（实施计划 §9 T12）。
// 数据集固定在 2027-03-08（周一）～03-14（周日）这一周（上海日历日，C13），
// 远离其他测试的固定日期，管理员全量口径不受共享库内历史数据干扰。
// 全部直接落库造数（显式 occurredAt/createdAt），期望值均为手工计算结果。
//
// 手工对账表（销售 A，本周）：
//   呼出 4（A1 三通 + A2 一通电话）｜接通 3｜有效 3（A1 一通 + A2 微信/电话）
//   合格 2（A1 周二首次进入、A5 周五首次进入；A3/A7 上周进入不计）
//   预约 1（A4 两次进入去重）｜工时 12h（8+4+0）→ 每小时 3/12 = 0.25 → 0.3
//   接通率 3/4 = 75.0；有效沟通率 3/3 = 100.0；合格率 2/3 = 66.7；预约率 1/3 = 33.3
//   平均处理时间 (A1: 3 天 + A5: 3 天 + A6: 10 天)/3 = 5.333 → 5.3
//   （A1 创建 03-06 09:00 → 03-09 09:00 首次合格；A7 上周已到终态、A8 未到终态不进均值）
// 管理员（全量）：呼出 5｜接通 4｜有效 4｜合格 3｜预约 1｜工时 18h → 4/18 = 0.222 → 0.2
//   平均 (3+3+10+6)/4 = 5.5｜AI 次数 3

const NOW = new Date("2027-03-10T10:00:00+08:00"); // 周三
const PERIOD = { from: "2027-03-08", to: "2027-03-14" };
const TODAY = "2027-03-10";

const SH = (spec: string) => new Date(`${spec}+08:00`);
const DAY = (spec: string) => new Date(`${spec}T00:00:00.000Z`);

let admin: TestUser;
let salesA: TestUser;
let salesB: TestUser;
let stageQualified: { id: string };
let stageBooked: { id: string };
let stageClosed: { id: string };
let stageNew: { id: string };
let modelConfigId: string;

async function createLead(params: {
  name: string;
  ownerId: string;
  stageId: string;
  createdAt?: Date;
  contractExpiry?: Date | null;
  contractExpiryStatus?: "unknown" | "unverified" | "confirmed";
  nextContactAt?: Date | null;
  lastContactAt?: Date | null;
  profile?: "complete" | "minimal";
}) {
  return prisma.lead.create({
    data: {
      name: params.name,
      ownerId: params.ownerId,
      stageId: params.stageId,
      contactName: params.profile === "complete" ? "王经理" : null,
      contactPhone: params.profile === "complete" ? "13800000001" : null,
      city: params.profile === "complete" ? "合肥" : null,
      industry: params.profile === "complete" ? "快消-酒水" : null,
      mainCategory: params.profile === "complete" ? "酒水" : null,
      source: params.profile === "complete" ? "转介绍" : null,
      salesTeamSize: params.profile === "complete" ? 12 : null,
      salesMode: params.profile === "complete" ? "访销" : null,
      currentSystem: params.profile === "complete" ? "某友" : null,
      contractExpiry: params.contractExpiry ?? null,
      contractExpiryStatus: params.contractExpiryStatus ?? "unknown",
      nextContactAt: params.nextContactAt ?? null,
      lastContactAt: params.lastContactAt ?? null,
      ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
    },
  });
}

async function addStageEvent(params: {
  leadId: string;
  toStageId: string;
  occurredAt: Date;
}) {
  await prisma.leadEvent.create({
    data: {
      leadId: params.leadId,
      eventType: "stage_changed",
      toStageId: params.toStageId,
      occurredAt: params.occurredAt,
    },
  });
}

async function addInteraction(params: {
  leadId: string;
  userId: string;
  occurredAt: Date;
  channel: "phone" | "wechat";
  connected: boolean;
  effective: boolean;
}) {
  await prisma.interaction.create({
    data: {
      leadId: params.leadId,
      userId: params.userId,
      occurredAt: params.occurredAt,
      channel: params.channel,
      direction: "outbound",
      connected: params.connected,
      effective: params.effective,
      feedback: params.effective ? "约了下一步" : null,
    },
  });
}

async function addAiRun(params: {
  leadId: string;
  userId: string;
  createdAt: Date;
}) {
  const promptVersion = await prisma.promptVersion.findFirstOrThrow({
    orderBy: { createdAt: "asc" },
  });
  await prisma.aiRun.create({
    data: {
      leadId: params.leadId,
      userId: params.userId,
      runType: "analysis",
      modelConfigId,
      promptVersionId: promptVersion.id,
      inputSnapshot: {},
      inputDataVersion: 1,
      status: "success",
      ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
    },
  });
}

beforeAll(async () => {
  admin = await createTestUser("admin");
  salesA = await createTestUser("sales");
  salesB = await createTestUser("sales");
  stageQualified = await getPresetStage("qualified");
  stageBooked = await getPresetStage("booked_demo");
  stageClosed = await getPresetStage("closed");
  stageNew = await getPresetStage("new_lead");

  const config = await prisma.modelConfig.create({
    data: {
      provider: "local-test",
      baseUrl: "http://127.0.0.1:9",
      modelName: "test-model",
      apiKeyCipher: "0".repeat(32),
      keyLast4: "0000",
      isActive: false,
    },
  });
  modelConfigId = config.id;
  registerTestModelConfig(config.id);

  // ---------- 销售 A 的固定数据集 ----------
  // A1：三通电话（2 接通 1 有效 1 未接通）+ 周二首次合格 + 今日待联系 + 合同 8 天到期（已确认）
  // 创建 03-06 09:00 → 03-09 09:00 首次合格 = 3.0 天（进平均处理时间队列）
  const l1 = await createLead({
    name: "指标A1",
    ownerId: salesA.id,
    stageId: stageQualified.id,
    createdAt: SH("2027-03-06T09:00"),
    contractExpiry: DAY("2027-03-18"),
    contractExpiryStatus: "confirmed",
    nextContactAt: SH("2027-03-10T14:00"),
  });
  await addInteraction({ leadId: l1.id, userId: salesA.id, occurredAt: SH("2027-03-08T09:00"), channel: "phone", connected: true, effective: true });
  await addInteraction({ leadId: l1.id, userId: salesA.id, occurredAt: SH("2027-03-08T10:00"), channel: "phone", connected: true, effective: false });
  await addInteraction({ leadId: l1.id, userId: salesA.id, occurredAt: SH("2027-03-10T09:00"), channel: "phone", connected: false, effective: false });
  await addStageEvent({ leadId: l1.id, toStageId: stageQualified.id, occurredAt: SH("2027-03-09T09:00") });

  // A2：微信有效 + 电话有效（均未联系过、画像 8/10、今日待联系）
  const l2 = await createLead({
    name: "指标A2",
    ownerId: salesA.id,
    stageId: stageNew.id,
    nextContactAt: SH("2027-03-10T09:00"),
    profile: "complete",
  });
  await addInteraction({ leadId: l2.id, userId: salesA.id, occurredAt: SH("2027-03-09T15:00"), channel: "wechat", connected: true, effective: true });
  await addInteraction({ leadId: l2.id, userId: salesA.id, occurredAt: SH("2027-03-10T08:00"), channel: "phone", connected: true, effective: true });

  // A3：上周首次合格（本周期不计）
  const l3 = await createLead({ name: "指标A3", ownerId: salesA.id, stageId: stageQualified.id });
  await addStageEvent({ leadId: l3.id, toStageId: stageQualified.id, occurredAt: SH("2027-03-02T10:00") });

  // A4：本周两次进入已预约演示（去重计 1）+ 合同到期但未核实（K6：不产生理由）
  const l4 = await createLead({
    name: "指标A4",
    ownerId: salesA.id,
    stageId: stageBooked.id,
    contractExpiry: DAY("2027-03-18"),
    contractExpiryStatus: "unverified",
    lastContactAt: SH("2027-03-09T10:00"),
  });
  await addStageEvent({ leadId: l4.id, toStageId: stageBooked.id, occurredAt: SH("2027-03-09T10:00") });
  await addStageEvent({ leadId: l4.id, toStageId: stageBooked.id, occurredAt: SH("2027-03-11T10:00") });

  // A5：创建 03-09 10:00 → 周五首次合格 03-12 10:00（处理时间 3.0 天）
  const l5 = await createLead({ name: "指标A5", ownerId: salesA.id, stageId: stageQualified.id, createdAt: SH("2027-03-09T10:00") });
  await addStageEvent({ leadId: l5.id, toStageId: stageQualified.id, occurredAt: SH("2027-03-12T10:00") });

  // A6：创建 03-02 16:00 → 周五首次关闭 03-12 16:00（处理时间 10.0 天）
  const l6 = await createLead({ name: "指标A6", ownerId: salesA.id, stageId: stageClosed.id, createdAt: SH("2027-03-02T16:00") });
  await addStageEvent({ leadId: l6.id, toStageId: stageClosed.id, occurredAt: SH("2027-03-12T16:00") });

  // A7：上周首次合格（终态在周期前，不进均值）
  const l7 = await createLead({ name: "指标A7", ownerId: salesA.id, stageId: stageQualified.id, createdAt: SH("2027-03-01T09:00") });
  await addStageEvent({ leadId: l7.id, toStageId: stageQualified.id, occurredAt: SH("2027-03-02T11:00") });

  // A8：从未到终态（不进均值；画像不完整，无优先理由）
  await createLead({ name: "指标A8", ownerId: salesA.id, stageId: stageNew.id });

  // A9：合同 2 天到期（已确认）+ 今日待联系 → 优先联系第一名
  await createLead({
    name: "指标A9",
    ownerId: salesA.id,
    stageId: stageNew.id,
    contractExpiry: DAY("2027-03-12"),
    contractExpiryStatus: "confirmed",
    nextContactAt: SH("2027-03-10T08:00"),
  });

  // 工时（A：8+4+0 = 12h）与 AI 次数（A：2 次）
  await upsertWorktime(salesA, "2027-03-08", 8);
  await upsertWorktime(salesA, "2027-03-09", 4);
  await upsertWorktime(salesA, "2027-03-10", 0);
  await addAiRun({ leadId: l1.id, userId: salesA.id, createdAt: SH("2027-03-09T12:00") });
  await addAiRun({ leadId: l2.id, userId: salesA.id, createdAt: SH("2027-03-10T08:00") });

  // 任务：今日 1（03-10 18:00）、逾期 1（03-08）、已完成不计、明日不计
  await prisma.task.create({ data: { leadId: l1.id, assigneeId: salesA.id, createdBy: salesA.id, type: "follow_up", title: "今日任务", dueAt: SH("2027-03-10T18:00") } });
  await prisma.task.create({ data: { leadId: l1.id, assigneeId: salesA.id, createdBy: salesA.id, type: "follow_up", title: "逾期任务", dueAt: SH("2027-03-08T09:00") } });
  await prisma.task.create({ data: { leadId: l2.id, assigneeId: salesA.id, createdBy: salesA.id, type: "follow_up", title: "已完成", dueAt: SH("2027-03-10T12:00"), status: "done", completedAt: SH("2027-03-10T09:30") } });
  await prisma.task.create({ data: { leadId: l2.id, assigneeId: salesA.id, createdBy: salesA.id, type: "follow_up", title: "明日任务", dueAt: SH("2027-03-11T09:00") } });

  // ---------- 销售 B 的固定数据集（隔离验证 + 管理员全量） ----------
  const lb1 = await createLead({ name: "指标B1", ownerId: salesB.id, stageId: stageQualified.id, createdAt: SH("2027-03-02T10:00") });
  await addInteraction({ leadId: lb1.id, userId: salesB.id, occurredAt: SH("2027-03-08T09:30"), channel: "phone", connected: true, effective: true });
  await addStageEvent({ leadId: lb1.id, toStageId: stageQualified.id, occurredAt: SH("2027-03-08T10:00") });
  await upsertWorktime(salesB, "2027-03-08", 6);
  await addAiRun({ leadId: lb1.id, userId: salesB.id, createdAt: SH("2027-03-10T09:00") });
});

afterAll(cleanupTestUsers);

describe("指标快照：固定 fixtures 与手工计算逐项一致", () => {
  it("销售 A：沟通/阶段/工时/比率/平均处理时间/AI 次数", async () => {
    const snapshot = await computeMetricsSnapshot(salesA, PERIOD);
    expect(snapshot.counts).toEqual({
      outboundCalls: 4,
      connectedCalls: 3,
      effectiveCommunications: 3,
      qualifiedLeads: 2,
      demoBookings: 1,
      demoCompletions: 0,
      quotes: 0,
      deals: 0,
    });
    expect(snapshot.rates).toEqual({
      connectRate: 75.0,
      effectiveRate: 100.0,
      qualifiedRate: 66.7,
      bookingRate: 33.3,
      effectivePerHour: 0.3,
    });
    expect(snapshot.workHours).toBe(12);
    expect(snapshot.avgHandleTimeDays).toBe(5.3);
    expect(snapshot.aiRunCount).toBe(2);
  });

  it("销售 B：仅本人数据", async () => {
    const snapshot = await computeMetricsSnapshot(salesB, PERIOD);
    expect(snapshot.counts.outboundCalls).toBe(1);
    expect(snapshot.counts.connectedCalls).toBe(1);
    expect(snapshot.counts.effectiveCommunications).toBe(1);
    expect(snapshot.counts.qualifiedLeads).toBe(1);
    expect(snapshot.workHours).toBe(6);
    expect(snapshot.rates.effectivePerHour).toBe(0.2);
    // B1 创建 03-02 10:00 → 03-08 10:00 合格 = 6.0 天
    expect(snapshot.avgHandleTimeDays).toBe(6.0);
    expect(snapshot.aiRunCount).toBe(1);
  });

  it("管理员：全量汇总（跨销售聚合）", async () => {
    const snapshot = await computeMetricsSnapshot(admin, PERIOD);
    expect(snapshot.counts).toEqual({
      outboundCalls: 5,
      connectedCalls: 4,
      effectiveCommunications: 4,
      qualifiedLeads: 3,
      demoBookings: 1,
      demoCompletions: 0,
      quotes: 0,
      deals: 0,
    });
    expect(snapshot.workHours).toBe(18);
    expect(snapshot.rates.effectivePerHour).toBe(0.2);
    expect(snapshot.rates.connectRate).toBe(80.0);
    expect(snapshot.avgHandleTimeDays).toBe(5.5);
    expect(snapshot.aiRunCount).toBe(3);
  });

  it("缺工时的用户：每小时有效沟通为 null（—，C03）", async () => {
    // admin 在另一周没有填报 → 该周期工时为 null
    const empty = await computeMetricsSnapshot(admin, {
      from: "2027-03-01",
      to: "2027-03-07",
    });
    expect(empty.workHours).toBeNull();
    expect(empty.rates.effectivePerHour).toBeNull();
    expect(empty.counts.effectiveCommunications).toBe(0);
  });

  it("首次进入语义：上周已进入的阶段不重复计入本周", async () => {
    // A3/A7 上周首次合格——若按事件行数计会把本周误计为 4；
    // 首次进入语义下本周只有 A1/A5。
    const snapshot = await computeMetricsSnapshot(salesA, PERIOD);
    expect(snapshot.counts.qualifiedLeads).toBe(2);
  });

  it("阶段分布：非删除线索按当前阶段计数（管理员全量）", async () => {
    const snapshot = await computeMetricsSnapshot(admin, PERIOD);
    const qualified = snapshot.stageDistribution.find(
      (row) => row.stageId === stageQualified.id,
    );
    const booked = snapshot.stageDistribution.find(
      (row) => row.stageId === stageBooked.id,
    );
    // 合格 = A1/A3/A5/A7 + B1 = 5；已预约演示 = A4 = 1
    expect(qualified?.count).toBe(5);
    expect(booked?.count).toBe(1);
  });
});

describe("任务计数：工作台卡片与任务中心同一实现", () => {
  it("getTaskCounts 与 listTasks.counts 一致（今日 1 / 逾期 1）", async () => {
    const counts = await getTaskCounts(salesA, NOW);
    expect(counts).toEqual({ today: 1, overdue: 1 });

    const listed = await listTasks(salesA, taskListQuerySchema.parse({ view: "all" }), { now: NOW });
    expect(listed.counts).toEqual(counts);

    expect(await getTaskCounts(salesB, NOW)).toEqual({ today: 0, overdue: 0 });
    expect(await getTaskCounts(admin, NOW)).toEqual({ today: 1, overdue: 1 });
  });
});

describe("建议优先联系（K6 规则引擎，验收项）", () => {
  it("排序与理由逐条一致；未确认合同不产生理由", async () => {
    const suggestions = await suggestPriorityLeads(salesA, { now: NOW, limit: 5 });
    expect(suggestions.map((row) => row.name)).toEqual([
      "指标A9",
      "指标A1",
      "指标A2",
    ]);
    expect(suggestions[0]!.reasons).toEqual([
      "合同 2 天内到期（已确认）",
      "今日待联系",
    ]);
    expect(suggestions[1]!.reasons).toEqual([
      "合同 8 天内到期（已确认）",
      "今日待联系",
    ]);
    expect(suggestions[2]!.reasons).toEqual([
      "今日待联系",
      "画像完整且从未联系",
    ]);
    // A4：合同到期但 unverified → 不出现（无采购信号不标高意向）
    expect(suggestions.map((row) => row.name)).not.toContain("指标A4");
  });

  it("理由话术为封闭集合：全量输出无'高意向'", async () => {
    for (const user of [salesA, salesB, admin]) {
      const suggestions = await suggestPriorityLeads(user, { now: NOW });
      for (const row of suggestions) {
        for (const reason of row.reasons) {
          expect(reason).not.toContain("高意向");
        }
      }
    }
  });
});

describe("工作台汇总（SSR 与 API 共用实现）", () => {
  it("今日三卡 + 本周概览 + 优先联系 + 最近沟通", async () => {
    const summary = await getWorkbenchSummary(salesA, { now: NOW });
    expect(summary.today.date).toBe(TODAY);
    expect(summary.today.dueTodayLeads).toBe(3); // A1/A2/A9
    expect(summary.today.tasksToday).toBe(1);
    expect(summary.today.tasksOverdue).toBe(1);
    expect(summary.week.from).toBe(PERIOD.from);
    expect(summary.week.counts.outboundCalls).toBe(4);

    expect(summary.priorities.map((row) => row.name)).toEqual([
      "指标A9",
      "指标A1",
      "指标A2",
    ]);

    // 最近沟通：时间倒序，第一条 = A1 周三 09:00（相对 10:00 → 1 小时前）
    expect(summary.recentInteractions).toHaveLength(5);
    expect(summary.recentInteractions[0]!.leadName).toBe("指标A1");
    expect(summary.recentInteractions[0]!.relativeTime).toBe("1 小时前");
    expect(summary.recentInteractions[0]!.effective).toBe(false);
    expect(summary.recentInteractions[1]!.leadName).toBe("指标A2");
    expect(summary.recentInteractions[1]!.effective).toBe(true);
  });

  it("数据隔离：销售 B 的汇总不出现 A 的客户与沟通", async () => {
    const summary = await getWorkbenchSummary(salesB, { now: NOW });
    const names = summary.priorities.map((row) => row.name);
    expect(names).not.toContain("指标A1");
    for (const row of summary.recentInteractions) {
      expect(row.leadName).not.toBe("指标A1");
      expect(row.leadName).not.toBe("指标A2");
    }
  });

  it("currentWeekPeriod：以上海周一为起点", () => {
    expect(currentWeekPeriod(NOW)).toEqual({
      from: "2027-03-08",
      to: "2027-03-14",
    });
    // 周日归属当周
    expect(currentWeekPeriod(new Date("2027-03-14T23:00:00+08:00"))).toEqual({
      from: "2027-03-08",
      to: "2027-03-14",
    });
  });
});
