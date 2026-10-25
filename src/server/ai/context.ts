import { Interaction, Lead, LeadStage } from "@prisma/client";

// Context Builder（T08，实施计划 §7.1 / PRD §6.1、§6.9）：
// 从线索构建 AI 输入快照——白名单字段（画像 + 阶段 + 最近沟通摘要），
// 不含联系人电话等联系方式（分析与话术不需要，落实"最小化敏感信息"）。
// 快照整体落 ai_runs.input_snapshot（Run Logger 留痕 + 历史可复现），
// 含核实状态列（unknown/unverified/confirmed），供模型区分事实/推断/未知。

/** 最近沟通条数（快照摘要窗口） */
const RECENT_INTERACTIONS_LIMIT = 5;

/**
 * interaction_summary（T10）专用快照键：销售口述/粘贴的原始沟通内容。
 * 随快照落 ai_runs.input_snapshot 留痕（历史可复现）；重试按同键取回
 * （见 runner.extractRawNotes），保证重试任务口径一致。
 */
export const RAW_INTERACTION_NOTES_KEY = "raw_interaction_notes";

/** 从快照中取回原始沟通内容（无则 undefined；analysis/call_prep 快照无此键） */
export function extractRawNotes(snapshot: unknown): string | undefined {
  if (typeof snapshot !== "object" || snapshot === null) {
    return undefined;
  }
  const entry = (snapshot as Record<string, unknown>)[RAW_INTERACTION_NOTES_KEY];
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const content = (entry as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

type InteractionForSnapshot = Pick<
  Interaction,
  | "occurredAt"
  | "channel"
  | "direction"
  | "connected"
  | "effective"
  | "feedback"
  | "confirmedPains"
  | "currentSystemConfirmed"
  | "purchaseTimeConfirmed"
  | "decisionMakerNote"
  | "objections"
  | "nextAction"
  | "isQualified"
  | "demoBooked"
>;

function isoDateOrNull(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/**
 * 构建 AI 输入快照（JSON，直接落库与拼入提示词）。
 * 白名单组：基本信息 / 系统情况（含核实状态）/ 采购情况（含核实状态）/ 管理组 / 最近沟通。
 * 明确排除：contact_phone（§7.1——电话与分析和话术无关）；密钥类信息天然不在线索表。
 */
export function buildAiInput(
  lead: Lead & { stage: LeadStage },
  interactions: InteractionForSnapshot[],
): Record<string, unknown> {
  const recent = [...interactions]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, RECENT_INTERACTIONS_LIMIT)
    .map((item) => ({
      occurred_at: item.occurredAt.toISOString(),
      channel: item.channel,
      direction: item.direction,
      connected: item.connected,
      effective: item.effective,
      is_qualified: item.isQualified,
      demo_booked: item.demoBooked,
      feedback: item.feedback,
      confirmed_pains: item.confirmedPains,
      current_system_confirmed: item.currentSystemConfirmed,
      purchase_time_confirmed: item.purchaseTimeConfirmed,
      decision_maker_note: item.decisionMakerNote,
      objections: item.objections,
      next_action: item.nextAction,
    }));

  return {
    profile: {
      name: lead.name,
      city: lead.city,
      industry: lead.industry,
      main_category: lead.mainCategory,
      contact_name: lead.contactName,
      contact_title: lead.contactTitle,
      source: lead.source,
      sales_team_size: lead.salesTeamSize,
      revenue_range: lead.revenueRange,
      sales_mode: lead.salesMode,
    },
    current_system: {
      in_use: lead.currentSystem,
      in_use_status: lead.currentSystemStatus,
      modules: lead.systemModules,
      contract_expiry: isoDateOrNull(lead.contractExpiry),
      contract_expiry_status: lead.contractExpiryStatus,
      known_pains: lead.knownPains,
      considering_switch: lead.consideringSwitch,
    },
    purchasing: {
      has_clear_demand: lead.hasClearDemand,
      purchase_time: lead.purchaseTime,
      purchase_time_status: lead.purchaseTimeStatus,
      budget: lead.budget,
      decision_maker: lead.decisionMaker,
      decision_maker_status: lead.decisionMakerStatus,
      decision_process: lead.decisionProcess,
      main_concerns: lead.mainConcerns,
    },
    management: {
      stage: {
        name: lead.stage.name,
        code: lead.stage.code,
        semantic_key: lead.stage.semanticKey,
      },
      priority: lead.priority,
      last_contact_at: lead.lastContactAt?.toISOString() ?? null,
      next_contact_at: lead.nextContactAt?.toISOString() ?? null,
    },
    recent_interactions: recent,
    snapshot_note:
      "仅含白名单字段；电话等联系方式未提供。" +
      "核实状态取值：unknown(未知)/unverified(待核实)/confirmed(已确认)。" +
      "对状态非 confirmed 的信息不得当作事实陈述。",
  };
}
