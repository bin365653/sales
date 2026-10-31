// 指标口径与优先级规则引擎（T12，PRD §5.9 / K5 / K6 / C03 / C13）。
//
// 本模块是纯函数层：比率计算、口径常量、优先联系规则与排序全部在此固化，
// server/metrics 引擎（DB 聚合）与前端展示共用同一份——手工计算对账（单测固化）
// 只需对本文件。约定：
// - 分母为 0 或缺工时 → null，界面显示"—"，绝不显示 0%（C03 / PRD §5.9）；
// - 百分比数值已乘 100、保留 1 位小数（66.7 表示 66.7%），前后端不再二次舍入；
// - 周期一律按上海日历日（YYYY-MM-DD，C13），周起点为周一；
// - 优先级建议由确定性规则生成并附理由，AI 不参与（K6），
//   规则理由是封闭集合，不含"高意向"等采购信号推断话术。

// ---------- 漏斗计数（口径注解随字段，DB 聚合见 server/metrics/engine.ts） ----------

/** 统计周期：上海日历日（YYYY-MM-DD）闭区间（C13；T12 引擎 / T13 看板共用） */
export interface MetricsPeriod {
  /** 起始日（含） */
  from: string;
  /** 结束日（含） */
  to: string;
}

export interface FunnelCounts {
  /** 呼出电话数：channel=phone 且 direction=outbound 的沟通记录 */
  outboundCalls: number;
  /** 接通电话数：呼出电话中 connected=true */
  connectedCalls: number;
  /** 有效沟通数：effective=true（不限渠道；有效定义见 interaction schema 常驻文案） */
  effectiveCommunications: number;
  /** 合格线索数：周期内首次进入 qualified 锚点阶段的线索（lead_events 首次进入语义） */
  qualifiedLeads: number;
  /** 预约数：周期内首次进入 booked_demo 锚点阶段的线索 */
  demoBookings: number;
  /** 演示数：周期内首次进入 demo_completed 锚点阶段的线索 */
  demoCompletions: number;
  /** 报价数：周期内首次进入 quoted 锚点阶段的线索 */
  quotes: number;
  /** 成交数：周期内首次进入 won 锚点阶段的线索 */
  deals: number;
}

export interface MetricRates {
  /** 接通率 = 接通电话数 / 呼出电话数；分母 0 → null（"—"） */
  connectRate: number | null;
  /** 有效沟通率 = 有效沟通数 / 接通电话数；分母 0 → null（PRD §5.9 原公式） */
  effectiveRate: number | null;
  /** 合格线索率 = 合格线索数 / 有效沟通数；分母 0 → null */
  qualifiedRate: number | null;
  /** 预约转化率 = 预约数 / 有效沟通数；分母 0 → null */
  bookingRate: number | null;
  /** 每小时有效沟通数 = 有效沟通数 / 实际销售工作小时（K5）；缺工时或 0 → null（C03） */
  effectivePerHour: number | null;
}

export const EMPTY_FUNNEL_COUNTS: FunnelCounts = {
  outboundCalls: 0,
  connectedCalls: 0,
  effectiveCommunications: 0,
  qualifiedLeads: 0,
  demoBookings: 0,
  demoCompletions: 0,
  quotes: 0,
  deals: 0,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 由漏斗计数与工时分母计算全部比率。
 * workHours：周期内工时合计；无填报行传 null（与合计为 0 区分，两者都得到 "—"）。
 */
export function computeRates(
  counts: FunnelCounts,
  workHours: number | null,
): MetricRates {
  const ratioPercent = (numerator: number, denominator: number): number | null =>
    denominator <= 0 ? null : round1((numerator / denominator) * 100);

  return {
    connectRate: ratioPercent(counts.connectedCalls, counts.outboundCalls),
    effectiveRate: ratioPercent(
      counts.effectiveCommunications,
      counts.connectedCalls,
    ),
    qualifiedRate: ratioPercent(
      counts.qualifiedLeads,
      counts.effectiveCommunications,
    ),
    bookingRate: ratioPercent(
      counts.demoBookings,
      counts.effectiveCommunications,
    ),
    effectivePerHour:
      workHours === null || workHours <= 0
        ? null
        : round1(counts.effectiveCommunications / workHours),
  };
}

// ---------- 建议优先联系规则引擎（K6 + V2.0 决策 D4：确定性规则，AI 不参与） ----------
//
// V2.0-T10 权重重排（UIUX §5.6/§7.2）——规则清单（封闭集合）：
// 1. 软件半年内到期（月粒度 P4，含已过期；核实状态 confirmed/stated 才计入，
//    P3 客户自述视同已确认）——**取代 V1.0 的「合同 30 天内到期」规则**（D4）；
// 2. 今日待联系（下次联系时间=今天，上海日界）；
// 3. 画像待完善（核心 7 项未全部核实，P5 核实口径；**取代 V1.0 的
//    「画像完整且从未联系」**——待完善才是待办，完整不是）。
// 未确认/未知的到期、无任何信号的客户不产生对应理由——规则理由是封闭集合
// （下方三条），绝无"高意向"等采购信号推断话术（验收项，V1.0 红线延续）。

import { addExpiryMonths, currentExpiryMonth } from "@/lib/expiry";

export const PRIORITY_RULE_WEIGHTS = {
  expiringSoon: 3,
  dueToday: 2,
  profileGap: 1,
} as const;

// V2.0（P2）：核实状态四态。半年内到期规则的「已确认」口径 = confirmed 或 stated
// （P3：客户自述即电话销售主要证据，分类/规则按已确认处理）。
export type FactStatusValue = "unknown" | "unverified" | "stated" | "confirmed";

export interface PriorityRuleInput {
  /** 软件到期日（上海日历日 YYYY-MM-DD，@db.Date 纯日期；null=未知） */
  contractExpiryDate: string | null;
  contractExpiryStatus: FactStatusValue;
  /** 下次联系时间所在上海日历日 */
  nextContactDate: string | null;
  /** 核心画像未全部核实（profileStatus ∈ {incomplete, null}，P5 核实口径） */
  profileIncomplete: boolean;
}

export interface PriorityRuleResult {
  reasons: string[];
  /** 命中的最高规则权重（排序主键） */
  score: number;
}

/** 上海日历日 → 当前月 "YYYY-MM"（P4 月粒度；当日按正午+08 取月避免时区偏移） */
function monthOfShanghaiDay(day: string): string {
  return currentExpiryMonth(new Date(`${day}T12:00:00+08:00`));
}

/**
 * 半年内到期判定（月粒度，与到期窗口 §4.2 同口径）：
 * M ≤ 到期月 ≤ M+6（含第 6 个月边界）；到期月 < M = 已过期（同样计入）。
 */
export function isExpiryWithinSixMonths(expiryDate: string, today: string): boolean {
  const expiryMonth = expiryDate.slice(0, 7);
  const currentMonth = monthOfShanghaiDay(today);
  return expiryMonth <= addExpiryMonths(currentMonth, 6);
}

/** 规则 1 理由：月粒度可执行措辞（已过期与半年内两种形态） */
export function expiryWindowReason(expiryDate: string, today: string): string {
  const expiryMonth = expiryDate.slice(0, 7);
  const currentMonth = monthOfShanghaiDay(today);
  if (expiryMonth < currentMonth) {
    return `软件 ${expiryMonth} 已过期，需核实续费状态`;
  }
  return `软件 ${expiryMonth} 到期，处于半年内窗口`;
}

export const PROFILE_GAP_REASON = "画像待完善：核心信息未全部核实";

/**
 * 逐条评估优先联系理由（纯函数，today 为上海日历日）。
 * 多规则命中时理由全部保留、score 取最高权重（工作台卡展示全部理由）。
 */
export function evaluatePriorityReasons(
  input: PriorityRuleInput,
  today: string,
): PriorityRuleResult {
  const reasons: string[] = [];
  let score = 0;

  if (
    input.contractExpiryDate !== null &&
    isExpiryWithinSixMonths(input.contractExpiryDate, today) &&
    (input.contractExpiryStatus === "confirmed" ||
      input.contractExpiryStatus === "stated")
  ) {
    reasons.push(expiryWindowReason(input.contractExpiryDate, today));
    score = Math.max(score, PRIORITY_RULE_WEIGHTS.expiringSoon);
  }

  if (input.nextContactDate === today) {
    reasons.push("今日待联系");
    score = Math.max(score, PRIORITY_RULE_WEIGHTS.dueToday);
  }

  if (input.profileIncomplete) {
    reasons.push(PROFILE_GAP_REASON);
    score = Math.max(score, PRIORITY_RULE_WEIGHTS.profileGap);
  }

  return { reasons, score };
}

export interface PriorityCandidateCore {
  reasons: string[];
  score: number;
  /** 上海日历日（排序：到期越早越靠前，无合同最后） */
  contractExpiryDate: string | null;
  /** 上海日历日（同分再按下次联系早者靠前） */
  nextContactDate: string | null;
  /** 创建时刻 ISO 串（末位并列保证结果稳定） */
  createdAt: string;
}

/** 建议优先联系排序：规则权重降序 → 到期升序 → 下次联系升序 → 创建时间升序 */
export function comparePriorityCandidates(
  a: PriorityCandidateCore,
  b: PriorityCandidateCore,
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.contractExpiryDate !== b.contractExpiryDate) {
    if (a.contractExpiryDate === null) return 1;
    if (b.contractExpiryDate === null) return -1;
    return a.contractExpiryDate < b.contractExpiryDate ? -1 : 1;
  }
  if (a.nextContactDate !== b.nextContactDate) {
    if (a.nextContactDate === null) return 1;
    if (b.nextContactDate === null) return -1;
    return a.nextContactDate < b.nextContactDate ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return 0;
}

/** 规则说明（UIUX §7.2 合规文案原样，工作台 ⓘ 展示；D4 替换 V1.0 30 天版本） */
export const PRIORITY_RULE_EXPLANATION =
  "建议优先联系由固定规则生成并附理由:软件半年内到期 > 今日待联系 > 画像待完善;AI 不参与优先级计算。";

/** 全部可能出现的规则理由（封闭集合，供测试断言"无高意向话术"） */
export const PRIORITY_REASON_VOCABULARY = [
  "软件 ",
  "已过期，需核实续费状态",
  "到期，处于半年内窗口",
  "今日待联系",
  PROFILE_GAP_REASON,
] as const;
