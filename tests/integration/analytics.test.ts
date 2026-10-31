import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  registerTestModelConfig,
  type TestUser,
} from "./helpers";
import { getAnalyticsDashboard } from "@/server/metrics/analytics";
import { analyticsQuerySchema } from "@/lib/schemas/analytics";
import { upsertWorktime } from "@/server/services/worktime";

// T13 验收（实施计划 §9 T13）：过滤条件正确影响所有指标（对比手工 SQL）；
// 阶段转化基于 lead_events 同批计算（圈选后首次进入语义仍然成立）。
//
// 数据集固定在 2027-06-07（周一）～06-13（周日）这一周（上海日历日，C13）。
// 全部直接落库造数（显式 occurredAt/createdAt），期望值均为手工计算结果。
//
// 手工对账表（销售 A，本周 06-07~06-13，无圈选）：
//   呼出 4（A1 两通 06-08 + A2 一通 06-09 + A6 一通 06-08；A1 的 06-01 通话在本周外）
//   接通 2（A1 一通 + A2 一通）｜有效 1（A2）
//   合格 2（A2 06-08、A3 06-09 首次进入）｜预约 1（A4 06-10）
//   工时 10h（仅 06-08 填报）→ 每小时 1/10 = 0.1
//   平均处理时间 (A2: 2.0 + A3: 4.0 + A5: 9.0)/3 = 5.0 天
//   AI 次数 1（A1 上的 analysis run）
// 圈选（同批线索语义）：
//   source=电商（A1/A3/A5/A6）：呼出 3｜接通 1｜有效 0 → 合格率/预约率 null；
//     合格 1（A3）｜平均 (4+9)/2 = 6.5｜工时仍 10（工时不挂线索）→ 每小时 0/10 = 0
//   industry=机械（A3/A4）：呼出 0 → 接通率/有效沟通率 null；合格 1、预约 1
//     但有效 0 → 合格率/预约率 null；平均 4.0；AI 0
//   stageId=合格快照（A2/A3）：呼出 1｜接通 1｜有效 1｜合格 2（同批首次进入）
//     → 合格率 2/1 = 200（圈选口径的诚实计算值，公式原样）｜平均 (2+4)/2 = 3.0
// today（06-09）：呼出 1（A2）｜接通 1｜有效 1｜合格 1（A3）｜平均 4.0｜
//   工时未填报 → null → 每小时 "—"（C03）
// month（06-01~06-30）：呼出 5（A1 06-01 通话计入）｜接通 3
// 管理员全量：呼出 5｜接通 3｜有效 2｜工时 16 → 2/16 = 0.1｜AI 2｜平均 5.0
// 管理员 + 负责人 A = 销售 A 视图；负责人 B：呼出 1｜工时 6 → 1/6 = 0.2
// 销售 A 传 ownerId=B：忽略（范围恒本人）——与 A 视图完全一致

const NOW = new Date("2027-06-09T16:00:00+08:00"); // 周三
const WEEK = { from: "2027-06-07", to: "2027-06-13" };
const SH = (spec: string) => new Date(`${spec}+08:00`);

let admin: TestUser;
let salesA: TestUser;
let salesB: TestUser;
let stageNew: { id: string };
let stageQualified: { id: string };
let stageBooked: { id: string };
let stageClosed: { id: string };
let modelConfigId: string;
// 全量口径断言的基线：集成测试直连开发库，库中可能存在真实/冒烟残留数据；
// 「管理员全量」类精确断言一律用「基线 ∪ 夹具增量」表达，避免环境数据污染。
let baselineSources: Set<string>;

async function createLead(params: {
  name: string;
  ownerId: string;
  stageId: string;
  source: string;
  industry?: string | null;
  createdAt?: Date;
  deleted?: boolean;
}) {
  const lead = await prisma.lead.create({
    data: {
      name: params.name,
      ownerId: params.ownerId,
      stageId: params.stageId,
      source: params.source,
      industry: params.industry ?? null,
      ...(params.createdAt !== undefined ? { createdAt: params.createdAt } : {}),
      ...(params.deleted ? { deletedAt: SH("2027-06-10T00:00") } : {}),
    },
  });
  return lead;
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
  connected: boolean;
  effective: boolean;
}) {
  await prisma.interaction.create({
    data: {
      leadId: params.leadId,
      userId: params.userId,
      occurredAt: params.occurredAt,
      channel: "phone",
      direction: "outbound",
      connected: params.connected,
      effective: params.effective,
    },
  });
}

async function addAiRun(params: { leadId: string; userId: string; createdAt: Date }) {
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
      createdAt: params.createdAt,
    },
  });
}

beforeAll(async () => {
  admin = await createTestUser("admin");
  salesA = await createTestUser("sales");
  salesB = await createTestUser("sales");
  stageNew = await getPresetStage("new_lead");
  stageQualified = await getPresetStage("qualified");
  stageBooked = await getPresetStage("booked_demo");
  stageClosed = await getPresetStage("closed");

  // 基线：夹具创建前库内已有的非空 source 去重（管理员全量口径下可见）
  baselineSources = new Set(
    (
      await prisma.lead.findMany({
        where: { deletedAt: null, source: { not: null } },
        select: { source: true },
      })
    ).map((row) => row.source as string),
  );

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

  // ---------- 销售 A ----------
  // A1 电商/快消：两通本周电话（1 接通）+ 一通 06-01 电话（本周外、6 月内）
  const a1 = await createLead({
    name: "看板A1",
    ownerId: salesA.id,
    stageId: stageNew.id,
    source: "电商",
    industry: "快消",
  });
  await addInteraction({ leadId: a1.id, userId: salesA.id, occurredAt: SH("2027-06-01T09:00"), connected: true, effective: false });
  await addInteraction({ leadId: a1.id, userId: salesA.id, occurredAt: SH("2027-06-08T09:00"), connected: true, effective: false });
  await addInteraction({ leadId: a1.id, userId: salesA.id, occurredAt: SH("2027-06-08T10:00"), connected: false, effective: false });

  // A2 转介绍/快消：本周一通有效电话；06-06 创建 → 06-08 首次合格（2.0 天）
  const a2 = await createLead({
    name: "看板A2",
    ownerId: salesA.id,
    stageId: stageQualified.id,
    source: "转介绍",
    industry: "快消",
    createdAt: SH("2027-06-06T10:00"),
  });
  await addInteraction({ leadId: a2.id, userId: salesA.id, occurredAt: SH("2027-06-09T09:00"), connected: true, effective: true });
  await addStageEvent({ leadId: a2.id, toStageId: stageQualified.id, occurredAt: SH("2027-06-08T10:00") });

  // A3 电商/机械：06-05 创建 → 06-09 首次合格（4.0 天），无沟通
  const a3 = await createLead({
    name: "看板A3",
    ownerId: salesA.id,
    stageId: stageQualified.id,
    source: "电商",
    industry: "机械",
    createdAt: SH("2027-06-05T10:00"),
  });
  await addStageEvent({ leadId: a3.id, toStageId: stageQualified.id, occurredAt: SH("2027-06-09T10:00") });

  // A4 门店/机械：06-10 首次进入已预约演示
  const a4 = await createLead({
    name: "看板A4",
    ownerId: salesA.id,
    stageId: stageBooked.id,
    source: "门店",
    industry: "机械",
  });
  await addStageEvent({ leadId: a4.id, toStageId: stageBooked.id, occurredAt: SH("2027-06-10T10:00") });

  // A5 电商：06-01 创建 → 06-10 首次关闭（9.0 天）
  const a5 = await createLead({
    name: "看板A5",
    ownerId: salesA.id,
    stageId: stageClosed.id,
    source: "电商",
    industry: "快消",
    createdAt: SH("2027-06-01T09:00"),
  });
  await addStageEvent({ leadId: a5.id, toStageId: stageClosed.id, occurredAt: SH("2027-06-10T09:00") });

  // A6 电商：已软删除——沟通"发生过就是发生过"（口径与 T12 一致）
  const a6 = await createLead({
    name: "看板A6",
    ownerId: salesA.id,
    stageId: stageNew.id,
    source: "电商",
    industry: "快消",
    deleted: true,
  });
  await addInteraction({ leadId: a6.id, userId: salesA.id, occurredAt: SH("2027-06-08T11:00"), connected: false, effective: false });

  await upsertWorktime(salesA, "2027-06-08", 10);
  await addAiRun({ leadId: a1.id, userId: salesA.id, createdAt: SH("2027-06-09T09:30") });

  // ---------- 销售 B ----------
  const b1 = await createLead({
    name: "看板B1",
    ownerId: salesB.id,
    stageId: stageNew.id,
    source: "直播",
    industry: "快消",
  });
  await addInteraction({ leadId: b1.id, userId: salesB.id, occurredAt: SH("2027-06-08T15:00"), connected: true, effective: true });
  await upsertWorktime(salesB, "2027-06-08", 6);
  await addAiRun({ leadId: b1.id, userId: salesB.id, createdAt: SH("2027-06-08T16:00") });
});

afterAll(cleanupTestUsers);

describe("无圈选：与手工 SQL 逐项一致（继承 T12 全量口径）", () => {
  it("销售 A 本周：漏斗/比率/工时/平均处理时间/AI 次数", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(view.period).toEqual(WEEK);
    expect(view.counts).toEqual({
      outboundCalls: 4,
      connectedCalls: 2,
      effectiveCommunications: 1,
      qualifiedLeads: 2,
      demoBookings: 1,
      demoCompletions: 0,
      quotes: 0,
      deals: 0,
    });
    expect(view.rates).toEqual({
      connectRate: 50.0,
      effectiveRate: 50.0,
      // 合格率 = 合格 2 / 有效 1 = 200（公式原样的诚实计算值）
      qualifiedRate: 200.0,
      bookingRate: 100.0,
      effectivePerHour: 0.1,
    });
    expect(view.workHours).toBe(10);
    expect(view.avgHandleTimeDays).toBe(5.0);
    expect(view.aiRunCount).toBe(1);
  });

  it("today：仅 06-09 当日数据；工时未填报 → 每小时 '—'（C03）", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "today" }),
      { now: NOW },
    );
    expect(view.period).toEqual({ from: "2027-06-09", to: "2027-06-09" });
    expect(view.counts.outboundCalls).toBe(1);
    expect(view.counts.connectedCalls).toBe(1);
    expect(view.counts.effectiveCommunications).toBe(1);
    expect(view.counts.qualifiedLeads).toBe(1);
    expect(view.avgHandleTimeDays).toBe(4.0);
    expect(view.workHours).toBeNull();
    expect(view.rates.effectivePerHour).toBeNull();
  });

  it("month：06-01 的呼出计入（周期口径差异）", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "month" }),
      { now: NOW },
    );
    expect(view.period).toEqual({ from: "2027-06-01", to: "2027-06-30" });
    expect(view.counts.outboundCalls).toBe(5);
    expect(view.counts.connectedCalls).toBe(3);
    // A2/A3 的首次合格都在 6 月
    expect(view.counts.qualifiedLeads).toBe(2);
  });

  it("custom：显式闭区间原样生效", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({
        period: "custom",
        from: "2027-06-07",
        to: "2027-06-08",
      }),
      { now: NOW },
    );
    expect(view.period).toEqual({ from: "2027-06-07", to: "2027-06-08" });
    // 06-07~06-08：A1 两通 + A6 一通（A2 的电话在 06-09）
    expect(view.counts.outboundCalls).toBe(3);
    expect(view.counts.connectedCalls).toBe(1);
  });
});

describe("圈选联动：过滤条件正确影响所有指标（手工 SQL 对账）", () => {
  it("source=电商：同批线索（A1/A3/A5/A6）全部指标随之收窄", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week", source: "电商" }),
      { now: NOW },
    );
    expect(view.counts).toEqual({
      outboundCalls: 3,
      connectedCalls: 1,
      effectiveCommunications: 0,
      qualifiedLeads: 1,
      demoBookings: 0,
      demoCompletions: 0,
      quotes: 0,
      deals: 0,
    });
    // 有效 0 → 合格率/预约率分母 0 → null（"—"）
    expect(view.rates.qualifiedRate).toBeNull();
    expect(view.rates.bookingRate).toBeNull();
    expect(view.rates.connectRate).toBe(33.3);
    // 含软删除客户的沟通（A6，发生过就是发生过）
    expect(view.counts.outboundCalls).toBe(3);
    // 平均处理时间 = (A3 4.0 + A5 9.0)/2 = 6.5
    expect(view.avgHandleTimeDays).toBe(6.5);
    // 工时不挂线索：来源圈选不影响分母（仍 10h）→ 每小时 0/10 = 0（真实计算值）
    expect(view.workHours).toBe(10);
    expect(view.rates.effectivePerHour).toBe(0);
    // AI 次数：A1 上的 run 仍在圈内
    expect(view.aiRunCount).toBe(1);
  });

  it("industry=机械：呼出 0 → 比率 null 而非 0%（C03）", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week", industry: "机械" }),
      { now: NOW },
    );
    expect(view.counts.outboundCalls).toBe(0);
    expect(view.counts.qualifiedLeads).toBe(1);
    expect(view.counts.demoBookings).toBe(1);
    expect(view.rates.connectRate).toBeNull();
    expect(view.rates.effectiveRate).toBeNull();
    expect(view.rates.qualifiedRate).toBeNull();
    expect(view.rates.bookingRate).toBeNull();
    expect(view.avgHandleTimeDays).toBe(4.0);
    expect(view.aiRunCount).toBe(0);
  });

  it("stageId=合格（当前快照圈定同批）：阶段转化基于 lead_events 同批计算", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({
        period: "week",
        stageId: stageQualified.id,
      }),
      { now: NOW },
    );
    // 圈内 A2/A3：A2 的沟通计入，A3 的首次合格计入——同批口径
    expect(view.counts.outboundCalls).toBe(1);
    expect(view.counts.connectedCalls).toBe(1);
    expect(view.counts.effectiveCommunications).toBe(1);
    expect(view.counts.qualifiedLeads).toBe(2);
    // 合格率 = 2/1 = 200：公式原样的诚实计算值（圈选口径说明见页面口径折叠）
    expect(view.rates.qualifiedRate).toBe(200.0);
    expect(view.avgHandleTimeDays).toBe(3.0); // (A2 2.0 + A3 4.0)/2
    expect(view.aiRunCount).toBe(0); // run 在 A1（不在合格快照圈内）
    // 阶段分布只剩圈选阶段
    expect(view.stageDistribution).toHaveLength(1);
    expect(view.stageDistribution[0]!.stageId).toBe(stageQualified.id);
    expect(view.stageDistribution[0]!.count).toBe(2);
    // 圈选标注回显
    expect(view.filters.stageId).toBe(stageQualified.id);
    expect(view.stageName).toBeTruthy();
  });

  it("圈选后首次进入语义不被破坏：圈外线索的周期前进出不计入", async () => {
    // 电商圈内的合格只有 A3；A2（转介绍）虽本周首次合格但不进 电商 圈
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week", source: "电商" }),
      { now: NOW },
    );
    expect(view.counts.qualifiedLeads).toBe(1);
  });
});

describe("数据范围：负责人筛选（管理员）与销售强制本人", () => {
  it("管理员无圈选 = 全量汇总", async () => {
    const view = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(view.counts.outboundCalls).toBe(5);
    expect(view.counts.effectiveCommunications).toBe(2);
    // 工时 10 + 6 = 16 → 2/16 = 0.125 → 0.1
    expect(view.workHours).toBe(16);
    expect(view.rates.effectivePerHour).toBe(0.1);
    expect(view.aiRunCount).toBe(2);
    expect(view.avgHandleTimeDays).toBe(5.0);
    // 管理员选项 = 全量去重（基线 ∪ A 的 3 个 + B 的 直播）
    expect(new Set(view.options.sources)).toEqual(
      new Set([...baselineSources, "电商", "门店", "转介绍", "直播"]),
    );
    expect(view.options.owners.length).toBeGreaterThanOrEqual(3);
  });

  it("管理员 + ownerId：工时/AI 随负责人收窄", async () => {
    const viewA = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "week", ownerId: salesA.id }),
      { now: NOW },
    );
    expect(viewA.counts.outboundCalls).toBe(4);
    expect(viewA.workHours).toBe(10);
    expect(viewA.aiRunCount).toBe(1);
    expect(viewA.filters.ownerId).toBe(salesA.id);
    expect(viewA.ownerName).toBe(salesA.name);

    const viewB = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "week", ownerId: salesB.id }),
      { now: NOW },
    );
    expect(viewB.counts.outboundCalls).toBe(1);
    expect(viewB.counts.effectiveCommunications).toBe(1);
    expect(viewB.workHours).toBe(6);
    expect(viewB.rates.effectivePerHour).toBe(0.2);
  });

  it("销售传 ownerId：忽略（范围恒本人，与 buildLeadListWhere 同语义）", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week", ownerId: salesB.id }),
      { now: NOW },
    );
    expect(view.counts.outboundCalls).toBe(4);
    expect(view.filters.ownerId).toBeUndefined();
    // 销售的负责人下拉恒为空
    expect(view.options.owners).toEqual([]);
  });

  it("销售隔离：选项与指标不泄露他人数据", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(new Set(view.options.sources)).toEqual(
      new Set(["电商", "门店", "转介绍"]),
    );
    const viewB = await getAnalyticsDashboard(
      salesB,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(viewB.counts.outboundCalls).toBe(1);
    expect(new Set(viewB.options.sources)).toEqual(new Set(["直播"]));
  });
});

describe("视图组装：漏斗行/选项/实验对比接入位", () => {
  it("漏斗 8 行固定顺序（UIUX P7）", async () => {
    const view = await getAnalyticsDashboard(
      salesA,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(view.funnelRows.map((row) => row.label)).toEqual([
      "呼出",
      "接通",
      "有效沟通",
      "合格线索",
      "预约演示",
      "演示完成",
      "报价",
      "成交",
    ]);
    expect(view.funnelRows[0]!.value).toBe(4);
  });

  it("无进行中实验时实验对比为 null（T14 语义），阶段下拉来自启用阶段", async () => {
    const view = await getAnalyticsDashboard(
      admin,
      analyticsQuerySchema.parse({ period: "week" }),
      { now: NOW },
    );
    expect(view.experimentComparison).toBeNull();
    expect(view.options.stages.length).toBeGreaterThanOrEqual(13);
    expect(view.options.stages.some((stage) => stage.id === stageNew.id)).toBe(
      true,
    );
  });
});
