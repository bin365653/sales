import { AuthUser } from "@/lib/auth";
import {
  buildFunnelRows,
  formatAnalyticsPeriodLabel,
  resolveAnalyticsPeriod,
} from "@/lib/analytics";
import type {
  AnalyticsPeriodPreset,
  AnalyticsQuery,
} from "@/lib/schemas/analytics";
import {
  FunnelCounts,
  MetricRates,
  MetricsPeriod,
} from "@/lib/metrics";
import { prisma } from "@/server/db";
import { leadReadScope } from "@/server/permissions";
import {
  computeMetricsSnapshot,
  MetricsCohortFilter,
  StageDistributionRow,
} from "@/server/metrics/engine";
import { listActiveUsers } from "@/server/services/users";
import { listStages } from "@/server/services/stages";
import {
  buildDashboardComparison,
  type ExperimentComparisonView,
} from "@/server/services/experiments";

// 看板服务（T13，PRD §5.9 / UIUX P7）：周期解析 + 线索圈选 → 指标快照 +
// 筛选选项组装。SSR /analytics 页与 GET /api/metrics 共用本实现（口径必然一致，
// 实施计划 §2.2 原则 3）；指标数值一律来自 computeMetricsSnapshot（server/metrics
// 唯一口径），本模块只做周期/圈选解析与视图组装，不自行计算任何指标。

export interface AnalyticsFilterOptions {
  /** 客户来源下拉（用户数据范围内去重，升序） */
  sources: string[];
  /** 行业下拉（同上） */
  industries: string[];
  /** 阶段下拉（启用中的阶段；与线索池筛选同源） */
  stages: { id: string; name: string }[];
  /** 负责人下拉（仅管理员；销售恒为空数组） */
  owners: { id: string; name: string }[];
}

export interface AnalyticsDashboardView {
  period: MetricsPeriod;
  periodPreset: AnalyticsPeriodPreset;
  periodLabel: string;
  counts: FunnelCounts;
  /** 漏斗 8 行（固定顺序与文案，UIUX P7） */
  funnelRows: ReturnType<typeof buildFunnelRows>;
  rates: MetricRates;
  /** 周期内工时合计；无填报 = null（"—" 的数据前提，C03） */
  workHours: number | null;
  avgHandleTimeDays: number | null;
  aiRunCount: number;
  stageDistribution: StageDistributionRow[];
  /** 当前生效圈选（销售传入的 ownerId 已剥离——其范围恒为本人） */
  filters: {
    source?: string;
    industry?: string;
    stageId?: string;
    ownerId?: string;
  };
  options: AnalyticsFilterOptions;
  /** 筛选下拉引用的阶段名（圈选标注展示用） */
  stageName: string | null;
  ownerName: string | null;
  /**
   * 实验对比数据（PRD §5.10，T14 接入）：最近一个"进行中"实验 × 看板所选
   * 周期的两组对比（经 computeGroupComparison，T13 固化口径）；
   * 无进行中实验 → null（页面展示占位说明）。
   */
  experimentComparison: ExperimentComparisonView | null;
  generatedAt: string;
}

/** 筛选选项：来源/行业在用户数据范围内去重（不含软删除——下拉圈定在管客户） */
async function loadCohortOptions(
  user: AuthUser,
): Promise<{ sources: string[]; industries: string[] }> {
  const scope = leadReadScope(user);
  const where = {
    deletedAt: null,
    ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
  };
  const [sourceRows, industryRows] = await Promise.all([
    prisma.lead.findMany({
      where: { ...where, source: { not: null } },
      distinct: ["source"],
      select: { source: true },
      orderBy: { source: "asc" },
    }),
    prisma.lead.findMany({
      where: { ...where, industry: { not: null } },
      distinct: ["industry"],
      select: { industry: true },
      orderBy: { industry: "asc" },
    }),
  ]);
  return {
    sources: sourceRows
      .map((row) => row.source)
      .filter((value): value is string => value !== null),
    industries: industryRows
      .map((row) => row.industry)
      .filter((value): value is string => value !== null),
  };
}

/**
 * 看板汇总：给定用户与已校验的查询入参（analyticsQuerySchema）。
 * 数据范围一律经 permissions 层；ownerId 仅管理员生效（销售传入即忽略，
 * 与 buildLeadListWhere 同语义）。
 */
export async function getAnalyticsDashboard(
  user: AuthUser,
  query: AnalyticsQuery,
  options: { now?: Date } = {},
): Promise<AnalyticsDashboardView> {
  const now = options.now ?? new Date();
  const isAdmin = user.role === "admin";
  const ownerId = isAdmin ? query.ownerId : undefined;

  const cohort: MetricsCohortFilter = {
    source: query.source,
    industry: query.industry,
    stageId: query.stageId,
    ...(ownerId ? { ownerId } : {}),
  };
  const period = resolveAnalyticsPeriod(
    query.period,
    now,
    query.period === "custom" && query.from && query.to
      ? { from: query.from, to: query.to }
      : undefined,
  );

  const [snapshot, cohortOptions, stages, owners, experimentComparison] =
    await Promise.all([
      computeMetricsSnapshot(user, period, cohort),
      loadCohortOptions(user),
      listStages({ activeOnly: true }),
      isAdmin ? listActiveUsers() : Promise.resolve([]),
      // P7 AI 组对比（T14）：进行中实验 × 看板所选周期（server/metrics/experiment 口径）
      buildDashboardComparison(period, { now }),
    ]);

  return {
    period,
    periodPreset: query.period,
    periodLabel: formatAnalyticsPeriodLabel(query.period, period),
    counts: snapshot.counts,
    funnelRows: buildFunnelRows(snapshot.counts),
    rates: snapshot.rates,
    workHours: snapshot.workHours,
    avgHandleTimeDays: snapshot.avgHandleTimeDays,
    aiRunCount: snapshot.aiRunCount,
    stageDistribution: snapshot.stageDistribution,
    filters: {
      source: query.source,
      industry: query.industry,
      stageId: query.stageId,
      ...(ownerId ? { ownerId } : {}),
    },
    options: {
      sources: cohortOptions.sources,
      industries: cohortOptions.industries,
      stages: stages.map((stage) => ({ id: stage.id, name: stage.name })),
      owners: owners.map((owner) => ({ id: owner.id, name: owner.name })),
    },
    stageName:
      stages.find((stage) => stage.id === query.stageId)?.name ?? null,
    ownerName:
      owners.find((owner) => owner.id === ownerId)?.name ?? null,
    experimentComparison,
    generatedAt: now.toISOString(),
  };
}
