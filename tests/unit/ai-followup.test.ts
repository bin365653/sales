import { describe, expect, it } from "vitest";
import {
  followupAdviceSchema,
  validateOutput,
} from "@/server/ai/validator";
import {
  buildAiInput,
  buildFollowupContext,
} from "@/server/ai/context";
import type { Lead, LeadStage } from "@prisma/client";

// V2.0-T11 单测：followup_advice 输出校验、analysis v2 可选段（v1 输出仍可解析）、
// 快照 profile_v2 组（象限/完善度/核实状态汇总，不含核实人）与 followup_context。

function fakeLead(): Lead & { stage: LeadStage } {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    name: "快照客户",
    city: "合肥",
    industry: "快消",
    mainCategory: null,
    contactName: "王经理",
    contactTitle: null,
    contactPhone: "13900001111",
    source: null,
    salesTeamSize: null,
    revenueRange: null,
    salesMode: null,
    currentSystem: "管家婆",
    systemModules: null,
    contractExpiry: new Date("2026-12-01T00:00:00.000Z"),
    knownPains: null,
    consideringSwitch: null,
    hasClearDemand: null,
    purchaseTime: null,
    budget: null,
    decisionMaker: null,
    decisionProcess: null,
    mainConcerns: null,
    currentSystemStatus: "confirmed",
    contractExpiryStatus: "confirmed",
    purchaseTimeStatus: "unknown",
    decisionMakerStatus: "unknown",
    nextGenMobileOrder: false,
    qinceInterest: true,
    quadrantCode: "c",
    quadrantComputedAt: new Date(),
    profileStatus: "basic",
    lastProfileVerifiedAt: null,
    softwareVersion: null,
    salesTeamScale: null,
    customerCount: null,
    businessMgmtMode: null,
    orderMgmtMode: null,
    deliveryMgmtMode: null,
    financeMgmtMode: null,
    warehouseArea: null,
    warehouseType: null,
    pickerCount: null,
    purchaseIntent: null,
    expressedNeeds: null,
    noInterestReason: null,
    isBossContact: null,
    stageId: "00000000-0000-7000-8000-000000000002",
    priority: "mid",
    ownerId: "00000000-0000-7000-8000-000000000003",
    lastContactAt: null,
    nextContactAt: null,
    remark: null,
    customValues: null,
    dataVersion: 3,
    deletedAt: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date(),
    stage: {
      id: "00000000-0000-7000-8000-000000000002",
      semanticKey: "to_contact",
      code: "to_contact",
      name: "待联系",
      sortOrder: 2,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  } as unknown as Lead & { stage: LeadStage };
}

describe("followupAdviceSchema（V2.0-T11 输出校验）", () => {
  const VALID = {
    reason_explanation: "该客户软件 2026-12 到期，处于半年内窗口，系统按月度规则生成本月跟进任务。",
    communication_advice: "结合 C 象限建议：优先演示手机开单效率对比，核实续费时间表。",
  };

  it("合法输出通过", () => {
    expect(followupAdviceSchema.safeParse(VALID).success).toBe(true);
  });

  it.each(["reason_explanation", "communication_advice"])(
    "缺失 %s 拒绝",
    (field) => {
      const broken = { ...VALID } as Record<string, unknown>;
      delete broken[field];
      expect(followupAdviceSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("validateOutput 分发 followup_advice（含围栏宽容解析）", () => {
    const verdict = validateOutput(
      "followup_advice",
      "```json\n" + JSON.stringify(VALID) + "\n```",
    );
    expect(verdict.ok).toBe(true);
  });

  it("validateOutput 对未知 runType 拒绝", () => {
    expect(validateOutput("unknown_type", "{}").ok).toBe(false);
  });
});

describe("analysis v2：gaps/contradictions 可选段", () => {
  const V1 = {
    fit: { level: "mid", reason: "行业匹配" },
    facts: [{ topic: "在用系统", detail: "Excel", status: "confirmed" }],
    pains: [],
    angles: [],
    next_action: "预约演示",
    verify_questions: ["客户数量级"],
  };

  it("v1 输出（无 gaps/contradictions）仍可解析（历史留痕可读）", () => {
    expect(validateOutput("analysis", JSON.stringify(V1)).ok).toBe(true);
  });

  it("v2 输出带 gaps/contradictions 通过", () => {
    const verdict = validateOutput(
      "analysis",
      JSON.stringify({
        ...V1,
        gaps: [{ field: "sales_team_scale", question: "咱们业务员大概几个人？" }],
        contradictions: [
          { conflict: "客户自述在用舟谱，但字典标记舟谱为新一代而画像选了否", suggestion: "电话中再次确认" },
        ],
      }),
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("快照 profile_v2（核实状态汇总，不含核实人）", () => {
  it("含 quadrant/profile_status/到期月/核实状态汇总；不含 contact_phone 与核实人", () => {
    const snapshot = buildAiInput(fakeLead(), [], {
      verifications: [
        { fieldKey: "current_system", status: "confirmed" },
        { fieldKey: "contract_expiry", status: "stated" },
        { fieldKey: "industry", status: "unknown" },
      ],
    });
    const v2 = snapshot.profile_v2 as Record<string, unknown>;
    expect(v2.quadrant_code).toBe("c");
    expect(v2.profile_status).toBe("basic");
    expect(v2.contract_expiry_month).toBe("2026-12");
    expect(v2.contract_expiry_window).toBe("within_6m");
    const summary = v2.verification_summary as Record<string, string>;
    expect(summary.current_system).toBe("confirmed");
    expect(summary.contract_expiry).toBe("stated");
    expect(summary.industry).toBe("unknown");
    expect(Object.values(summary).every((status) => typeof status === "string")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("13900001111");
    expect(JSON.stringify(snapshot)).not.toContain("verified_by");
    expect(JSON.stringify(snapshot)).not.toContain("verifiedBy");
  });
});

describe("buildFollowupContext（任务来源+策略快照）", () => {
  it("pending 任务映射 source_type/title/due/priority/policy", () => {
    const context = buildFollowupContext([
      {
        sourceType: "expiry_monthly",
        title: "软件到期月度跟进（2026-11）",
        dueAt: new Date("2026-11-15T00:00:00.000Z"),
        priority: 3,
        policy: { name: "软件到期月度跟进（系统强制）", quadrantCode: null, intervalDays: 30 },
      },
    ]);
    expect(context.pending_tasks).toHaveLength(1);
    expect(context.pending_tasks[0]).toMatchObject({
      source_type: "expiry_monthly",
      priority: 3,
    });
    expect(context.pending_tasks[0]!.policy!.interval_days).toBe(30);
    expect(context.note).toContain("不允许编造策略");
  });

  it("空任务列表如实呈现（无系统任务）", () => {
    const context = buildFollowupContext([]);
    expect(context.pending_tasks).toHaveLength(0);
  });
});
