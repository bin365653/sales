import { Interaction, Lead, LeadStage } from "@prisma/client";
import { currentExpiryMonth, expiryWindow } from "@/lib/expiry";

// Context Builder（T08，实施计划 §7.1 / PRD §6.1、§6.9）：
// 从线索构建 AI 输入快照——白名单字段（画像 + 阶段 + 最近沟通摘要），
// 不含联系人电话等联系方式（分析与话术不需要，落实"最小化敏感信息"）。
// 快照整体落 ai_runs.input_snapshot（Run Logger 留痕 + 历史可复现），
// 含核实状态列（unknown/unverified/stated/confirmed），供模型区分事实/推断/未知。
//
// V2.0-T11 扩展（实施计划 §7）：
// - profile_v2 组：象限/完善度/到期月 + 全字段核实状态汇总
//   （不含核实人与核实时间——展示身份信息不进入模型输入）；
// - followup_context（仅 followup_advice）：pending 自动任务来源 + 策略快照，
//   由 runner 注入（服务端生成，AI 解释必须与其一致，不允许编造策略）。

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

/** 核实状态汇总行（不含核实人/时间） */
export interface VerificationSummaryRow {
  fieldKey: string;
  status: string;
}

/** followup_advice 专用快照组（runner 注入；来源/策略快照由服务端生成） */
export interface FollowupContextTask {
  source_type: string;
  title: string;
  due_at: string;
  priority: number | null;
  policy: { name: string; quadrant_code: string | null; interval_days: number } | null;
}

export interface FollowupContext {
  pending_tasks: FollowupContextTask[];
  note: string;
}

/**
 * 构建 AI 输入快照（JSON，直接落库与拼入提示词）。
 * 白名单组：基本信息 / 系统情况（含核实状态）/ 采购情况（含核实状态）/ 管理组 /
 * 最近沟通 / profile_v2（V2.0-T11：象限+完善度+到期月+核实状态汇总）。
 * 明确排除：contact_phone（§7.1——电话与分析和话术无关）；密钥类信息天然不在线索表。
 */
export function buildAiInput(
  lead: Lead & { stage: LeadStage },
  interactions: InteractionForSnapshot[],
  extras: { verifications?: VerificationSummaryRow[] } = {},
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

  // V2.0-T11：核实状态汇总（白名单字段 → 四态；不含核实人/时间）
  const verificationSummary: Record<string, string> = {};
  for (const row of extras.verifications ?? []) {
    verificationSummary[row.fieldKey] = row.status;
  }
  const now = new Date();
  const expiryMonth = lead.contractExpiry
    ? currentExpiryMonth(lead.contractExpiry)
    : null;

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
    // V2.0-T11：画像经营组（象限/完善度/到期窗口/核实状态汇总）
    profile_v2: {
      quadrant_code: lead.quadrantCode ?? null,
      profile_status: lead.profileStatus ?? null,
      contract_expiry_month: expiryMonth,
      contract_expiry_window:
        lead.contractExpiry === null
          ? "unknown"
          : expiryWindow(lead.contractExpiry, now),
      verification_summary: verificationSummary,
    },
    recent_interactions: recent,
    snapshot_note:
      "仅含白名单字段；电话等联系方式未提供。" +
      "核实状态取值：unknown(未知)/unverified(待核实)/stated(客户自述待复核)/confirmed(已确认)。" +
      "对状态非 confirmed/stated 的信息不得当作事实陈述。",
  };
}

/** followup_context 组（仅 followup_advice 快照携带；§7 任务来源+策略快照） */
export function buildFollowupContext(
  tasks: {
    sourceType: string;
    title: string;
    dueAt: Date;
    priority: number | null;
    policy: { name: string; quadrantCode: string | null; intervalDays: number } | null;
  }[],
): FollowupContext {
  return {
    pending_tasks: tasks.map((task) => ({
      source_type: task.sourceType,
      title: task.title,
      due_at: task.dueAt.toISOString(),
      priority: task.priority,
      policy: task.policy
        ? {
            name: task.policy.name,
            quadrant_code: task.policy.quadrantCode,
            interval_days: task.policy.intervalDays,
          }
        : null,
    })),
    note:
      "以下任务由系统按确定规则生成（来源/策略为服务端快照）；" +
      "reason_explanation 必须与之一致，不允许编造策略或来源。",
  };
}
