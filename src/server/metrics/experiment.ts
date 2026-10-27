import { Prisma } from "@prisma/client";
import { MetricsPeriod } from "@/lib/metrics";
import {
  ExperimentMetricCounts,
  ExperimentMetricKey,
  buildExperimentComparisonRows,
  ExperimentComparisonRow,
} from "@/lib/experiments";
import { prisma } from "@/server/db";
import {
  firstEntryCounts,
  loadAnchorStageMap,
  periodInstantBounds,
} from "@/server/metrics/engine";

// 实验分组统计（T14，PRD §5.10 / UIUX P8）：按组计算各对比指标在统计周期内的
// "命中线索数"，再经 lib 层 buildExperimentComparisonRows → computeGroupComparison
// （T13 固化口径）组装对比行。本模块是实验指标的 server 唯一口径：
// - 样本量 = 分组时组内线索数（固定不变，不随周期/软删除变化）；
// - 命中 = 周期内达成指标的"去重线索数"（与看板"数量"口径的区别：看板数事件次数，
//   实验对比看"多少条线索达成"——UIUX P7 示例 37.5% = 9/24 条线索）；
// - 命中口径与看板一致：有效沟通 = interactions.effective（含软删除客户，发生过
//   就是发生过）；阶段类 = lead_events 首次进入语义（复用 engine 同一实现）；
//   AI 使用 = ai_runs 成功记录（K3 决议：是否实际使用以成功记录为准）。

/** 某组、某周期内各指标的命中线索数（去重；组内无线索时全 0） */
export async function countExperimentGroupHits(
  leadIds: string[],
  period: MetricsPeriod,
): Promise<Record<ExperimentMetricKey, number>> {
  const empty: Record<ExperimentMetricKey, number> = {
    effective: 0,
    qualified: 0,
    booked_demo: 0,
    won: 0,
    ai_used: 0,
  };
  if (leadIds.length === 0) {
    return empty;
  }
  const { start, end } = periodInstantBounds(period);
  const anchorMap = await loadAnchorStageMap();
  const [effectiveGroups, stageEvents, aiGroups] = await Promise.all([
    prisma.interaction.groupBy({
      by: ["leadId"],
      where: {
        leadId: { in: leadIds },
        occurredAt: { gte: start, lt: end },
        effective: true,
      },
    }),
    prisma.leadEvent.findMany({
      where: {
        leadId: { in: leadIds },
        eventType: "stage_changed",
        occurredAt: { lt: end },
        toStageId: { in: Array.from(anchorMap.keys()) },
      },
      select: { leadId: true, toStageId: true, occurredAt: true },
    }),
    prisma.aiRun.groupBy({
      by: ["leadId"],
      where: {
        leadId: { in: leadIds },
        createdAt: { gte: start, lt: end },
        status: "success",
      },
    }),
  ]);

  const stageCounts = firstEntryCounts(stageEvents, start, end, anchorMap);
  // firstEntryCounts 以 `${leadId}:${anchor}` 计数，锚点维度转回键值
  const stageCountByAnchor = new Map<string, number>();
  for (const [anchor, count] of stageCounts) {
    stageCountByAnchor.set(anchor, count);
  }

  return {
    effective: effectiveGroups.length,
    qualified: stageCountByAnchor.get("qualified") ?? 0,
    booked_demo: stageCountByAnchor.get("booked_demo") ?? 0,
    won: stageCountByAnchor.get("won") ?? 0,
    ai_used: aiGroups.length,
  };
}

/**
 * 实验两组对比：读分组明细 → 每组命中统计 → 对比行。
 * period 由调用方决定（P7 = 看板所选周期；P8 = 分组日 → 关闭日/今日）。
 */
export async function computeExperimentComparison(
  experiment: {
    id: string;
    minSampleSize: number;
  },
  period: MetricsPeriod,
): Promise<{
  controlSampleSize: number;
  assistedSampleSize: number;
  rows: ExperimentComparisonRow[];
}> {
  const assignments = await prisma.experimentAssignment.findMany({
    where: { experimentId: experiment.id },
    select: { group: true, leadId: true },
  });
  const controlIds = assignments
    .filter((row) => row.group === "control")
    .map((row) => row.leadId);
  const assistedIds = assignments
    .filter((row) => row.group === "assisted")
    .map((row) => row.leadId);

  const [control, assisted] = await Promise.all([
    countExperimentGroupHits(controlIds, period),
    countExperimentGroupHits(assistedIds, period),
  ]);
  const counts: ExperimentMetricCounts = { control, assisted };

  return {
    controlSampleSize: controlIds.length,
    assistedSampleSize: assistedIds.length,
    rows: buildExperimentComparisonRows(
      counts,
      controlIds.length,
      assistedIds.length,
      experiment.minSampleSize,
    ),
  };
}

/** 客户基本画像快照（PRD §5.10"客户基本画像"白名单；不含联系方式） */
export function buildProfileSnapshot(lead: {
  name: string;
  city: string | null;
  industry: string | null;
  source: string | null;
  salesTeamSize: number | null;
  revenueRange: string | null;
  stageName: string;
  ownerId: string;
}): Prisma.InputJsonValue {
  return {
    name: lead.name,
    city: lead.city,
    industry: lead.industry,
    source: lead.source,
    salesTeamSize: lead.salesTeamSize,
    revenueRange: lead.revenueRange,
    stageName: lead.stageName,
    ownerId: lead.ownerId,
  } satisfies Record<string, unknown> as Prisma.InputJsonValue;
}
