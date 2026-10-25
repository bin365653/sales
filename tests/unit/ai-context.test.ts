import { describe, expect, it } from "vitest";
import { Lead, LeadStage } from "@prisma/client";
import { buildAiInput } from "@/server/ai/context";

// T08 Context Builder（实施计划 §7.1：白名单字段、不含联系人电话/邮箱，
// 落实 PRD §6.9"不向模型发送完成任务所不需要的敏感信息"）。

function fakeStage(): LeadStage {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    semanticKey: "contacted",
    code: "contacted",
    name: "已联系",
    sortOrder: 2,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakeLead(overrides: Partial<Lead> = {}): Lead {
  const stage = fakeStage();
  return {
    id: "22222222-2222-2222-2222-222222222222",
    name: "上海恒信贸易",
    city: "上海",
    industry: "外贸",
    mainCategory: "日用百货",
    contactName: "王经理",
    contactTitle: "采购负责人",
    contactPhone: "13800138000",
    source: "展会",
    salesTeamSize: 12,
    revenueRange: "1000-5000万",
    salesMode: "内销",
    currentSystem: "Excel 台账",
    systemModules: "客户资料",
    contractExpiry: new Date("2026-06-30T00:00:00Z"),
    knownPains: "客户资料分散",
    consideringSwitch: true,
    hasClearDemand: null,
    purchaseTime: "明年上半年",
    budget: null,
    decisionMaker: "王经理",
    decisionProcess: null,
    mainConcerns: null,
    currentSystemStatus: "unverified",
    contractExpiryStatus: "unknown",
    purchaseTimeStatus: "confirmed",
    decisionMakerStatus: "confirmed",
    stageId: stage.id,
    priority: "high",
    ownerId: "33333333-3333-3333-3333-333333333333",
    lastContactAt: new Date("2026-10-20T02:00:00Z"),
    nextContactAt: null,
    remark: null,
    customValues: null,
    dataVersion: 7,
    deletedAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-20T02:00:00Z"),
    ...overrides,
  } as Lead;
}

describe("AI 输入快照（白名单）", () => {
  it("快照整体与序列化文本均不包含联系人电话", () => {
    const snapshot = buildAiInput({ ...fakeLead(), stage: fakeStage() }, []);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("13800138000");
    expect(serialized).not.toContain("contact_phone");
    expect(snapshot.profile).not.toHaveProperty("contact_phone");
  });

  it("包含核实状态与阶段锚点，供模型区分事实/推断/未知", () => {
    const snapshot = buildAiInput({ ...fakeLead(), stage: fakeStage() }, []);
    expect(snapshot.current_system).toMatchObject({
      in_use: "Excel 台账",
      in_use_status: "unverified",
      contract_expiry: "2026-06-30",
      contract_expiry_status: "unknown",
    });
    expect(snapshot.purchasing).toMatchObject({
      purchase_time: "明年上半年",
      purchase_time_status: "confirmed",
      decision_maker: "王经理",
      decision_maker_status: "confirmed",
    });
    expect(snapshot.management).toMatchObject({
      stage: { name: "已联系", semantic_key: "contacted" },
    });
  });

  it("最近沟通按时间倒序、最多 5 条纳入快照", () => {
    const lead = fakeLead();
    const interactions = Array.from({ length: 7 }, (_, i) => ({
      occurredAt: new Date(Date.UTC(2026, 9, 10 + i, 1, 0, 0)),
      channel: "phone" as const,
      direction: "outbound" as const,
      connected: true,
      effective: i % 2 === 0,
      feedback: `第${i}次反馈`,
      confirmedPains: null,
      currentSystemConfirmed: null,
      purchaseTimeConfirmed: null,
      decisionMakerNote: null,
      objections: null,
      nextAction: `第${i}步`,
      isQualified: false,
      demoBooked: false,
    }));
    const snapshot = buildAiInput(
      { ...lead, stage: fakeStage() },
      interactions,
    );
    const recent = snapshot.recent_interactions as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(5);
    expect(recent[0]?.feedback).toBe("第6次反馈");
    expect(recent[4]?.feedback).toBe("第2次反馈");
    expect(recent[0]?.next_action).toBe("第6步");
  });

  it("空线索（全空字段）也能产出合法快照——输入不足场景的基础", () => {
    const emptyLead = fakeLead({
      city: null,
      industry: null,
      currentSystem: null,
      purchaseTime: null,
      decisionMaker: null,
      contactName: null,
    });
    const snapshot = buildAiInput({ ...emptyLead, stage: fakeStage() }, []);
    expect(snapshot.profile).toMatchObject({ name: "上海恒信贸易", city: null });
  });
});
