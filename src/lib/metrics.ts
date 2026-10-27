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

// ---------- 建议优先联系规则引擎（K6：确定性规则，AI 不参与） ----------
//
// 规则清单（UIUX P2 / PRD §5.1 例举）：
// 1. 合同 30 天内到期（核实状态=已确认才计入；含已过期——过期更需要尽快确认续约意向）；
// 2. 今日待联系（下次联系时间=今天，上海日界）；
// 3. 画像完整且从未联系（核心画像 10 项中已填 ≥8 且 lastContactAt 为空）。
// 未确认/未知的合同到期、缺少采购信号的客户不产生任何理由——
// 规则理由是封闭集合（下方三条），绝无"高意向"等推断话术（验收项）。

export const CONTRACT_EXPIRY_WINDOW_DAYS = 30;

/** 核心画像字段（内置列名）；已填 ≥ PROFILE_COMPLETE_THRESHOLD 项视为"画像完整" */
export const PROFILE_COMPLETE_FIELDS = [
  "city",
  "industry",
  "mainCategory",
  "contactName",
  "contactPhone",
  "source",
  "salesTeamSize",
  "salesMode",
  "currentSystem",
  "contractExpiry",
] as const;

export const PROFILE_COMPLETE_THRESHOLD = 8;

export const PRIORITY_RULE_WEIGHTS = {
  contractExpiring: 3,
  dueToday: 2,
  neverContacted: 1,
} as const;

export type FactStatusValue = "unknown" | "unverified" | "confirmed";

export interface PriorityRuleInput {
  /** 合同到期日（上海日历日 YYYY-MM-DD，@db.Date 纯日期） */
  contractExpiryDate: string | null;
  contractExpiryStatus: FactStatusValue;
  /** 下次联系时间所在上海日历日 */
  nextContactDate: string | null;
  /** 从未联系 = true（lastContactAt 为空） */
  neverContacted: boolean;
  /** 核心画像已填项数（PROFILE_COMPLETE_FIELDS 计数） */
  profileFilledCount: number;
}

export interface PriorityRuleResult {
  reasons: string[];
  /** 命中的最高规则权重（排序主键） */
  score: number;
}

function calendarDayDiff(from: string, to: string): number {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    throw new Error(`非法日期字符串：${from} / ${to}`);
  }
  return Math.round((toMs - fromMs) / 86_400_000);
}

/** 规则 1 理由：按到期距离给出可执行措辞（天数手工可对账） */
export function contractExpiryReason(
  expiryDate: string,
  today: string,
): string {
  const diff = calendarDayDiff(today, expiryDate);
  if (diff === 0) {
    return "合同今日到期（已确认）";
  }
  if (diff > 0) {
    return `合同 ${diff} 天内到期（已确认）`;
  }
  return `合同已过期 ${-diff} 天（已确认）`;
}

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
    input.contractExpiryStatus === "confirmed"
  ) {
    const diff = calendarDayDiff(today, input.contractExpiryDate);
    if (diff <= CONTRACT_EXPIRY_WINDOW_DAYS) {
      reasons.push(contractExpiryReason(input.contractExpiryDate, today));
      score = Math.max(score, PRIORITY_RULE_WEIGHTS.contractExpiring);
    }
  }

  if (input.nextContactDate === today) {
    reasons.push("今日待联系");
    score = Math.max(score, PRIORITY_RULE_WEIGHTS.dueToday);
  }

  if (
    input.neverContacted &&
    input.profileFilledCount >= PROFILE_COMPLETE_THRESHOLD
  ) {
    reasons.push("画像完整且从未联系");
    score = Math.max(score, PRIORITY_RULE_WEIGHTS.neverContacted);
  }

  return { reasons, score };
}

/** 核心画像已填项数（null/undefined/空串/NaN 视为未填） */
export function countFilledProfileFields(
  values: Record<string, unknown>,
): number {
  return PROFILE_COMPLETE_FIELDS.filter((key) => {
    const value = values[key];
    if (value === null || value === undefined || value === "") {
      return false;
    }
    if (typeof value === "number" && Number.isNaN(value)) {
      return false;
    }
    return true;
  }).length;
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

/** 建议优先联系排序：规则权重降序 → 合同到期升序 → 下次联系升序 → 创建时间升序 */
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

/** 规则说明（UIUX §7.2 合规文案原样，工作台 ⓘ 展示） */
export const PRIORITY_RULE_EXPLANATION =
  "建议优先联系由固定规则生成并附理由；AI 不参与优先级计算。缺少采购信号时不会将客户标记为高意向。";

/** 全部可能出现的规则理由（封闭集合，供测试断言"无高意向话术"） */
export const PRIORITY_REASON_VOCABULARY = [
  "合同今日到期（已确认）",
  "合同已过期",
  "天内到期（已确认）",
  "天（已确认）",
  "今日待联系",
  "画像完整且从未联系",
] as const;
