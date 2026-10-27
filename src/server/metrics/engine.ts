import { AuthUser } from "@/lib/auth";
import {
  computeRates,
  EMPTY_FUNNEL_COUNTS,
  FunnelCounts,
  MetricRates,
  MetricsPeriod,
} from "@/lib/metrics";
import {
  formatRelativeShanghai,
  oneLineSnippet,
  shanghaiWeekdayLabel,
  toShanghaiDateString,
} from "@/lib/format";
import { CHANNEL_LABELS, DIRECTION_LABELS } from "@/lib/schemas/interaction";
import { leadListQuerySchema } from "@/lib/schemas/lead";
import { shiftDateString, workweekDays, workweekStart } from "@/lib/worktime";
import { prisma } from "@/server/db";
import { leadReadScope } from "@/server/permissions";
import { buildLeadListWhere } from "@/server/services/leads";
import { getTaskCounts } from "@/server/services/tasks";
import { listRecentInteractions } from "@/server/services/interactions";
import {
  PriorityCandidateView,
  suggestPriorityLeads,
} from "@/server/metrics/priority";

// 指标引擎（T12，实施计划 §2.2 原则 3 / §9 T12；PRD §5.9 全口径）。
// server/metrics 是统计口径唯一出处——工作台（P2，本任务）与看板（P7，T13）
// 一律调用本模块，口径不靠约定靠同一段代码。纯函数口径见 src/lib/metrics.ts
// （比率/"—"规则/优先规则，固定 fixtures 单测逐项对账）。
//
// 口径决策（与 K5/K2/C03/C13 一致）：
// - 沟通类指标（呼出/接通/有效）：interactions.occurred_at 落在周期内；
//   含软删除客户的沟通（沟通发生过就是发生过，与个人全量导出 M9 同口径）；
// - 阶段类指标（合格/预约/演示/报价/成交）：lead_events 首次进入语义锚点阶段
//   的时间落在周期内（同一线索多次进出只计首次；T13 阶段转化同批计算的基础）；
// - 平均处理时间（K5 ③）：线索创建 → 首次成为合格商机或关闭；首次终态时间
//   落在周期内的线索进均值，未到终态不进（K5 原文）；
// - 工时分母（K5/C03）：周期内 work_time_entries 合计；销售=本人、管理员=全量；
//   无填报行 → null → 界面"—"，绝不显示 0；
// - 数据范围：一律经 leadReadScope（销售=本人线索，管理员=全量）；
//   AI 使用次数按 ai_runs.user_id（与个人全量导出口径一致）。

// 参与漏斗计数的语义锚点（seed 保证存在；REQUIRED_METRIC_ANCHORS + demo_completed）
const FUNNEL_STAGE_ANCHORS = [
  "qualified",
  "booked_demo",
  "demo_completed",
  "quoted",
  "won",
] as const;
// 平均处理时间的终点锚点（K5 ③：首次成为合格商机或关闭）
const TERMINAL_STAGE_ANCHORS = ["qualified", "closed"] as const;

// 周期类型下沉至纯函数层（lib/metrics），此处再导出保持既有引用不变
export type { MetricsPeriod } from "@/lib/metrics";

/**
 * 线索圈选筛选（T13 看板，PRD §5.9"按客户来源、行业和客户阶段筛选"）。
 * 语义：按线索属性圈定"同批线索"后计算全部指标——
 * - 沟通/阶段事件/AI 调用：经线索归属过滤（含软删除客户——发生过就是发生过，
 *   与 T12 无筛选口径一致）；
 * - 各阶段客户数量：当前快照，本就不含软删除；
 * - 工时（每小时有效沟通的分母）不挂在线索上，来源/行业/阶段圈选不影响分母；
 *   但用户维度恒随"生效归属"：销售=本人、管理员按负责人筛选时=该负责人、
 *   其余情况管理员=全量——工时属于人，不属于线索圈选维度。
 * ownerId 仅管理员可用（销售强制本人，由 leadReadScope 兜底）。
 */
export interface MetricsCohortFilter {
  source?: string;
  industry?: string;
  stageId?: string;
  ownerId?: string;
}

export interface StageDistributionRow {
  stageId: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  count: number;
}

export interface MetricsSnapshot {
  period: MetricsPeriod;
  counts: FunnelCounts;
  rates: MetricRates;
  /** 周期内工时合计（小时）；无填报行 = null（"—" 的数据前提，C03） */
  workHours: number | null;
  /** 平均处理时间（天，1 位小数）；周期内无终态线索 = null */
  avgHandleTimeDays: number | null;
  /** 各阶段客户数量（当前快照，不含软删除；停用阶段仍持有线索时照常列出） */
  stageDistribution: StageDistributionRow[];
  /** 周期内 AI 调用次数（发起即计，含失败/重试） */
  aiRunCount: number;
}

/** 纯日期 → UTC 零点（@db.Date 落库口径，同 worktime/contract_expiry） */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** 上海日历日 from 00:00（含）到 to 次日 00:00（不含）的 UTC 区间 */
export function periodInstantBounds(period: MetricsPeriod): { start: Date; end: Date } {
  const start = new Date(`${period.from}T00:00:00+08:00`);
  const end = new Date(`${shiftDateString(period.to, 1)}T00:00:00+08:00`);
  return { start, end };
}

/** 语义锚点 → 阶段 UUID 映射（seed 预置；缺失时该锚点恒计 0 而非报错） */
export async function loadAnchorStageMap(): Promise<Map<string, string>> {
  const stages = await prisma.leadStage.findMany({
    where: {
      semanticKey: {
        in: [...FUNNEL_STAGE_ANCHORS, ...TERMINAL_STAGE_ANCHORS],
      },
    },
    select: { id: true, semanticKey: true },
  });
  const map = new Map<string, string>();
  for (const stage of stages) {
    if (stage.semanticKey !== null) {
      map.set(stage.id, stage.semanticKey);
    }
  }
  return map;
}

/**
 * 首次进入语义（PRD §5.9"同一批线索的阶段推进记录"）：对每条
 * (线索, 锚点阶段) 取最早进入时刻，落在 [start, end) 才计入——
 * 同一线索多次进出该阶段只计首次，不随反弹重复计数。
 */
export function firstEntryCounts(
  events: { leadId: string; toStageId: string | null; occurredAt: Date }[],
  start: Date,
  end: Date,
  stageIdToAnchor: Map<string, string>,
): Map<string, number> {  const firstEntry = new Map<string, Date>(); // key = `${leadId}:${anchor}`
  for (const event of events) {
    if (event.toStageId === null) {
      continue;
    }
    const anchor = stageIdToAnchor.get(event.toStageId);
    if (anchor === undefined) {
      continue;
    }
    const key = `${event.leadId}:${anchor}`;
    const existing = firstEntry.get(key);
    if (existing === undefined || event.occurredAt < existing) {
      firstEntry.set(key, event.occurredAt);
    }
  }
  const counts = new Map<string, number>();
  for (const [key, occurredAt] of firstEntry) {
    if (occurredAt >= start && occurredAt < end) {
      const anchor = key.slice(key.indexOf(":") + 1);
      counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 全口径指标快照：给定用户数据范围、周期（上海日历日闭区间）与可选的
 * 线索圈选筛选（T13 看板；不传 = 全量口径，与 T12 完全一致）。
 */
export async function computeMetricsSnapshot(
  user: AuthUser,
  period: MetricsPeriod,
  cohort: MetricsCohortFilter = {},
): Promise<MetricsSnapshot> {
  const { start, end } = periodInstantBounds(period);
  const scope = leadReadScope(user);

  // 圈选 where（线索属性维度）：owner 维度销售恒为本人（cohort.ownerId 只对
  // 管理员生效，与 buildLeadListWhere 同语义）；其余维度按传入值精确匹配。
  // 不含 deletedAt——沟通/事件/AI"发生过就是发生过"，阶段分布另行排除软删除。
  const cohortLeadWhere: Record<string, unknown> = {
    ...(scope.ownerId
      ? { ownerId: scope.ownerId }
      : cohort.ownerId
        ? { ownerId: cohort.ownerId }
        : {}),
    ...(cohort.source ? { source: cohort.source } : {}),
    ...(cohort.industry ? { industry: cohort.industry } : {}),
    ...(cohort.stageId ? { stageId: cohort.stageId } : {}),
  };
  const hasCohort = Object.keys(cohortLeadWhere).length > 0;
  // 沟通/事件/AI 查询的线索归属过滤：无圈选时保持 T12 原 where（不引入空关联）
  const leadRelationFilter = hasCohort ? { lead: cohortLeadWhere } : {};

  const anchorMap = await loadAnchorStageMap();

  const [
    outboundCalls,
    connectedCalls,
    effectiveCommunications,
    stageEvents,
    workAggregate,
    distributionGroups,
    stages,
  ] = await Promise.all([
    prisma.interaction.count({
      where: {
        occurredAt: { gte: start, lt: end },
        channel: "phone",
        direction: "outbound",
        ...leadRelationFilter,
      },
    }),
    prisma.interaction.count({
      where: {
        occurredAt: { gte: start, lt: end },
        channel: "phone",
        direction: "outbound",
        connected: true,
        ...leadRelationFilter,
      },
    }),
    prisma.interaction.count({
      where: {
        occurredAt: { gte: start, lt: end },
        effective: true,
        ...leadRelationFilter,
      },
    }),
    // 首次进入语义需要周期之前的历史事件，故只设上界
    prisma.leadEvent.findMany({
      where: {
        eventType: "stage_changed",
        occurredAt: { lt: end },
        toStageId: { in: Array.from(anchorMap.keys()) },
        ...leadRelationFilter,
      },
      select: { leadId: true, toStageId: true, occurredAt: true },
    }),
    prisma.workTimeEntry.aggregate({
      where: {
        workDate: { gte: toDateOnly(period.from), lte: toDateOnly(period.to) },
        // 工时不挂线索：来源/行业/阶段圈选不影响分母（K5 分母=实际销售工作小时）；
        // 用户维度恒随"生效归属"——销售=本人，管理员按负责人筛选时=该负责人，
        // 其余情况管理员=全量。工时属于人，不属于线索圈选维度。
        ...(scope.ownerId || cohort.ownerId
          ? { userId: scope.ownerId ?? cohort.ownerId }
          : {}),
      },
      _sum: { hours: true },
    }),
    prisma.lead.groupBy({
      by: ["stageId"],
      where: {
        deletedAt: null,
        ...cohortLeadWhere,
      },
      _count: { stageId: true },
    }),
    prisma.leadStage.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        sortOrder: true,
        isActive: true,
      },
    }),
  ]);

  const funnelCounts = firstEntryCounts(stageEvents, start, end, anchorMap);

  const counts: FunnelCounts = {
    ...EMPTY_FUNNEL_COUNTS,
    outboundCalls,
    connectedCalls,
    effectiveCommunications,
    qualifiedLeads: funnelCounts.get("qualified") ?? 0,
    demoBookings: funnelCounts.get("booked_demo") ?? 0,
    demoCompletions: funnelCounts.get("demo_completed") ?? 0,
    quotes: funnelCounts.get("quoted") ?? 0,
    deals: funnelCounts.get("won") ?? 0,
  };

  const workHours =
    workAggregate._sum.hours === null ? null : Number(workAggregate._sum.hours);

  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const stageDistribution: StageDistributionRow[] = distributionGroups
    .map((group) => {
      const stage = stageById.get(group.stageId);
      return {
        stageId: group.stageId,
        code: stage?.code ?? "",
        name: stage?.name ?? "未知阶段",
        sortOrder: stage?.sortOrder ?? 9999,
        isActive: stage?.isActive ?? false,
        count: group._count.stageId,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));

  const avgHandleTimeDays = await computeAvgHandleTimeDays(
    user,
    anchorMap,
    start,
    end,
    cohortLeadWhere,
  );

  return {
    period,
    counts,
    rates: computeRates(counts, workHours),
    workHours,
    avgHandleTimeDays,
    stageDistribution,
    aiRunCount: await prisma.aiRun.count({
      where: {
        createdAt: { gte: start, lt: end },
        // 圈选时按线索归属过滤（管理员按负责人筛选同此路径）；
        // 无圈选时保持 T12 口径（销售=本人发起，管理员=全量）
        ...(hasCohort
          ? { lead: cohortLeadWhere }
          : scope.ownerId
            ? { userId: scope.ownerId }
            : {}),
      },
    }),
  };
}

/**
 * 平均处理时间（K5 ③）：线索创建 → 首次成为合格商机或关闭。
 * 终态首次进入时间落在周期内的线索参与平均（天，1 位小数）；未到终态不进。
 * cohortLeadWhere：看板圈选（T13）——圈选维度作用于同批线索的创建→终态配对。
 */
async function computeAvgHandleTimeDays(
  user: AuthUser,
  anchorMap: Map<string, string>,
  start: Date,
  end: Date,
  cohortLeadWhere: Record<string, unknown> = {},
): Promise<number | null> {
  const terminalStageIds = Array.from(anchorMap.entries())
    .filter(([, anchor]) =>
      (TERMINAL_STAGE_ANCHORS as readonly string[]).includes(anchor),
    )
    .map(([stageId]) => stageId);
  if (terminalStageIds.length === 0) {
    return null;
  }

  // cohortLeadWhere 已含生效的归属过滤（销售=本人 / 管理员按负责人圈选）
  const hasCohort = Object.keys(cohortLeadWhere).length > 0;
  const leadRelationFilter = hasCohort ? { lead: cohortLeadWhere } : {};

  const events = await prisma.leadEvent.findMany({
    where: {
      eventType: "stage_changed",
      toStageId: { in: terminalStageIds },
      occurredAt: { lt: end },
      ...leadRelationFilter,
    },
    select: { leadId: true, occurredAt: true },
  });
  // 每条线索的首次终态时刻（qualified 与 closed 取更早者）
  const firstTerminal = new Map<string, Date>();
  for (const event of events) {
    const existing = firstTerminal.get(event.leadId);
    if (existing === undefined || event.occurredAt < existing) {
      firstTerminal.set(event.leadId, event.occurredAt);
    }
  }
  const inPeriodLeadIds = Array.from(firstTerminal.entries())
    .filter(([, occurredAt]) => occurredAt >= start && occurredAt < end)
    .map(([leadId]) => leadId);
  if (inPeriodLeadIds.length === 0) {
    return null;
  }

  const leads = await prisma.lead.findMany({
    where: {
      id: { in: inPeriodLeadIds },
      ...cohortLeadWhere,
    },
    select: { id: true, createdAt: true },
  });

  let totalMs = 0;
  let counted = 0;
  for (const lead of leads) {
    const terminal = firstTerminal.get(lead.id);
    if (terminal === undefined) {
      continue;
    }
    totalMs += terminal.getTime() - lead.createdAt.getTime();
    counted += 1;
  }
  if (counted === 0) {
    return null;
  }
  return Math.round((totalMs / counted / 86_400_000) * 10) / 10;
}

// ---------- 工作台汇总（P2，GET /api/dashboard/summary 与首页共用） ----------

export interface RecentInteractionView {
  id: string;
  leadId: string;
  leadName: string;
  /** "YYYY-MM-DD HH:mm"（上海） */
  occurredAtDisplay: string;
  /** 相对时间（"2 小时前"，UIUX P2） */
  relativeTime: string;
  channelLabel: string;
  directionLabel: string;
  connected: boolean;
  effective: boolean;
  feedbackSnippet: string | null;
}

export interface WorkbenchSummary {
  today: {
    /** 上海日历日 YYYY-MM-DD */
    date: string;
    /** 星期文案（"周二"） */
    weekday: string;
    /** 今日待联系客户数（与 /leads?nextContact=today 同一 where） */
    dueTodayLeads: number;
    /** 今日待办任务数（与任务中心 counts 同一实现） */
    tasksToday: number;
    /** 逾期任务数 */
    tasksOverdue: number;
  };
  week: {
    from: string;
    to: string;
    counts: FunnelCounts;
    rates: MetricRates;
  };
  priorities: PriorityCandidateView[];
  recentInteractions: RecentInteractionView[];
  generatedAt: string;
}

/** 上海时区"本周"周期（周一 → 周日，C13） */
export function currentWeekPeriod(now: Date): MetricsPeriod {
  const today = toShanghaiDateString(now);
  const days = workweekDays(workweekStart(today));
  return { from: days[0], to: days[6] };
}

/**
 * 工作台首页汇总：今日三卡（待联系/今日任务/逾期任务）+ 本周概览 +
 * 建议优先联系（规则引擎）+ 最近沟通记录。SSR 首页与
 * GET /api/dashboard/summary 共用本实现（口径必然一致）。
 */
export async function getWorkbenchSummary(
  user: AuthUser,
  options: { now?: Date } = {},
): Promise<WorkbenchSummary> {
  const now = options.now ?? new Date();
  const period = currentWeekPeriod(now);

  // 今日待联系 = 线索池"下次联系=今天"筛选的同一 where（buildLeadListWhere 唯一口径）
  const dueTodayWhere = buildLeadListWhere(
    user,
    leadListQuerySchema.parse({ nextContact: "today" }),
    { now },
  );

  const [dueTodayLeads, taskCounts, week, priorities, recent] =
    await Promise.all([
      prisma.lead.count({ where: dueTodayWhere }),
      getTaskCounts(user, now),
      computeMetricsSnapshot(user, period),
      suggestPriorityLeads(user, { now }),
      listRecentInteractions(user, 10),
    ]);

  return {
    today: {
      date: toShanghaiDateString(now),
      weekday: shanghaiWeekdayLabel(now),
      dueTodayLeads,
      tasksToday: taskCounts.today,
      tasksOverdue: taskCounts.overdue,
    },
    week: {
      from: period.from,
      to: period.to,
      counts: week.counts,
      rates: week.rates,
    },
    priorities,
    recentInteractions: recent.map((row) => ({
      id: row.id,
      leadId: row.leadId,
      leadName: row.leadName,
      occurredAtDisplay: toShanghaiDateString(row.occurredAt),
      relativeTime: formatRelativeShanghai(row.occurredAt, now),
      channelLabel: CHANNEL_LABELS[row.channel],
      directionLabel: DIRECTION_LABELS[row.direction],
      connected: row.connected,
      effective: row.effective,
      feedbackSnippet: oneLineSnippet(row.feedback, 48),
    })),
    generatedAt: now.toISOString(),
  };
}
