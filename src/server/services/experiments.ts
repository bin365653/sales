import { Prisma, Experiment, ExperimentAssignment } from "@prisma/client";
import { randomInt } from "node:crypto";
import { AuthUser } from "@/lib/auth";
import { MetricsPeriod } from "@/lib/metrics";
import {
  ExperimentComparisonRow,
  ExperimentGroupValue,
  ASSIGN_CONFIRM_RULE_NOTE,
} from "@/lib/experiments";
import type {
  ExperimentCreateInput,
  ExperimentUpdateInput,
} from "@/lib/schemas/experiment";
import { ApiError } from "@/server/http/api";
import { assertAdmin } from "@/server/permissions";
import { prisma } from "@/server/db";
import { toShanghaiDateString } from "@/lib/format";
import { AuditAction, writeAudit } from "@/server/auth/audit";
import {
  computeExperimentComparison,
  buildProfileSnapshot,
} from "@/server/metrics/experiment";

// 实验分组服务（T14，实施计划 §9 T14 / PRD §5.10 / UIUX P8 / M3、C04）：
// - 管理员独占创建/编辑/执行分组/关闭（UIUX 权限矩阵：销售只读查看结果）；
// - 生命周期 draft →（执行分组）running →（关闭）closed；
//   分组执行后配置冻结（C04"分组后固定不可改"），仅可关闭；
// - 随机分组：圈选（排除已分组线索）→ 洗牌 → 按 AI 辅助组占比切分
//   （n≥2 时两侧各至少 1 条——实验设计基本要求）；同一线索全局唯一分组
//   （experiment_assignments.lead_id 唯一约束兜底，T14 验收项）；
// - 留痕：分组规则 + 客户画像快照随每条 assignment 落库（PRD §5.10），
//   生命周期动作写审计日志（experiment.created/updated/assigned/closed）；
// - 统计一律经 server/metrics/experiment（唯一口径）+ lib 层 computeGroupComparison，
//   本模块不自行计算比率。

export interface ExperimentListItem {
  id: string;
  name: string;
  status: Experiment["status"];
  source: string | null;
  industry: string | null;
  stageId: string | null;
  ownerId: string | null;
  assistedRatio: number;
  minSampleSize: number;
  assignedAt: string | null;
  assignedCount: number | null;
  closedAt: string | null;
  createdAt: string;
  controlCount: number;
  assistedCount: number;
}

export interface ExperimentAssignmentView {
  id: string;
  leadId: string;
  leadName: string;
  group: ExperimentGroupValue;
  assignedAt: string;
}

export interface ExperimentDetailView {
  experiment: ExperimentListItem;
  /** 两组名单仅管理员可见（销售只读查看结果=对比数据，§4.4 数据范围精神） */
  assignments: ExperimentAssignmentView[] | null;
}

export interface ExperimentStatsView {
  experimentId: string;
  experimentName: string;
  status: Experiment["status"];
  minSampleSize: number;
  /** 统计周期（上海日历日闭区间）：分组日 → 关闭日/今日 */
  period: MetricsPeriod;
  periodLabel: string;
  controlSampleSize: number;
  assistedSampleSize: number;
  rows: ExperimentComparisonRow[];
}

/** P7 看板 AI 组对比（PRD §5.10）：进行中实验 × 看板所选周期 */
export interface ExperimentComparisonView {
  experimentId: string;
  experimentName: string;
  periodLabel: string;
  controlSampleSize: number;
  assistedSampleSize: number;
  minSampleSize: number;
  rows: ExperimentComparisonRow[];
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

async function loadExperiment(id: string): Promise<Experiment> {
  const experiment = await prisma.experiment.findUnique({ where: { id } });
  if (!experiment) {
    throw new ApiError(404, "not_found", "实验不存在");
  }
  return experiment;
}

async function groupCounts(experimentIds: string[]): Promise<
  Map<string, { control: number; assisted: number }>
> {
  const counts = new Map<string, { control: number; assisted: number }>();
  if (experimentIds.length === 0) {
    return counts;
  }
  const groups = await prisma.experimentAssignment.groupBy({
    by: ["experimentId", "group"],
    where: { experimentId: { in: experimentIds } },
    _count: { _all: true },
  });
  for (const row of groups) {
    const entry = counts.get(row.experimentId) ?? { control: 0, assisted: 0 };
    if (row.group === "control") {
      entry.control = row._count._all;
    } else {
      entry.assisted = row._count._all;
    }
    counts.set(row.experimentId, entry);
  }
  return counts;
}

function toItem(
  experiment: Experiment,
  counts?: { control: number; assisted: number },
): ExperimentListItem {
  return {
    id: experiment.id,
    name: experiment.name,
    status: experiment.status,
    source: experiment.source,
    industry: experiment.industry,
    stageId: experiment.stageId,
    ownerId: experiment.ownerId,
    assistedRatio: experiment.assistedRatio,
    minSampleSize: experiment.minSampleSize,
    assignedAt: iso(experiment.assignedAt),
    assignedCount: experiment.assignedCount,
    closedAt: iso(experiment.closedAt),
    createdAt: experiment.createdAt.toISOString(),
    controlCount: counts?.control ?? 0,
    assistedCount: counts?.assisted ?? 0,
  };
}

// ---------- 查询（所有登录用户：销售只读查看结果） ----------

export async function listExperiments(): Promise<ExperimentListItem[]> {
  const rows = await prisma.experiment.findMany({
    orderBy: { createdAt: "desc" },
  });
  const counts = await groupCounts(rows.map((row) => row.id));
  return rows.map((row) => toItem(row, counts.get(row.id)));
}

export async function getExperimentDetailView(
  actor: AuthUser,
  id: string,
): Promise<ExperimentDetailView> {
  const experiment = await loadExperiment(id);
  const isAdmin = actor.role === "admin";
  const counts = await groupCounts([experiment.id]);
  let assignments: ExperimentAssignmentView[] | null = null;
  if (isAdmin) {
    const rows: (ExperimentAssignment & {
      lead: { name: string };
    })[] = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id },
      include: { lead: { select: { name: true } } },
      orderBy: [{ group: "asc" }, { assignedAt: "asc" }],
    });
    assignments = rows.map((row) => ({
      id: row.id,
      leadId: row.leadId,
      leadName: row.lead.name,
      group: row.group,
      assignedAt: row.assignedAt.toISOString(),
    }));
  }
  return { experiment: toItem(experiment, counts.get(experiment.id)), assignments };
}

/** 实验统计（P8 效果对比；P7 不走此函数——P7 用看板所选周期） */
export async function getExperimentStats(
  id: string,
  options: { now?: Date } = {},
): Promise<ExperimentStatsView> {
  const experiment = await loadExperiment(id);
  const now = options.now ?? new Date();
  if (experiment.assignedAt === null) {
    throw new ApiError(409, "experiment_not_assigned", "实验尚未执行分组，暂无统计数据");
  }
  const period: MetricsPeriod = {
    from: toShanghaiDateString(experiment.assignedAt),
    to: experiment.closedAt
      ? toShanghaiDateString(experiment.closedAt)
      : toShanghaiDateString(now),
  };
  const comparison = await computeExperimentComparison(experiment, period);
  return {
    experimentId: experiment.id,
    experimentName: experiment.name,
    status: experiment.status,
    minSampleSize: experiment.minSampleSize,
    period,
    periodLabel: `${period.from} ~ ${period.to}`,
    controlSampleSize: comparison.controlSampleSize,
    assistedSampleSize: comparison.assistedSampleSize,
    rows: comparison.rows,
  };
}

/**
 * P7 看板 AI 组对比：最近一个"进行中"实验（多次执行取最新分组时间），
 * 统计周期 = 看板所选周期。无进行中实验 → null（页面展示占位说明）。
 */
export async function buildDashboardComparison(
  period: MetricsPeriod,
  options: { now?: Date } = {},
): Promise<ExperimentComparisonView | null> {
  void options;
  const experiment = await prisma.experiment.findFirst({
    where: { status: "running", assignedAt: { not: null } },
    orderBy: { assignedAt: "desc" },
  });
  if (!experiment) {
    return null;
  }
  const comparison = await computeExperimentComparison(experiment, period);
  return {
    experimentId: experiment.id,
    experimentName: experiment.name,
    periodLabel: `${period.from} ~ ${period.to}`,
    controlSampleSize: comparison.controlSampleSize,
    assistedSampleSize: comparison.assistedSampleSize,
    minSampleSize: experiment.minSampleSize,
    rows: comparison.rows,
  };
}

/** 线索池/详情页 GroupBadge 数据：进行中实验的 lead → 分组映射 */
export async function getRunningExperimentGroups(
  leadIds: string[],
): Promise<Map<string, ExperimentGroupValue>> {
  if (leadIds.length === 0) {
    return new Map();
  }
  const rows = await prisma.experimentAssignment.findMany({
    where: {
      leadId: { in: leadIds },
      experiment: { status: "running" },
    },
    select: { leadId: true, group: true },
  });
  return new Map(rows.map((row) => [row.leadId, row.group]));
}

// ---------- 写操作（管理员独占） ----------

async function assertRefsExist(input: {
  stageId?: string;
  ownerId?: string;
}): Promise<void> {
  if (input.stageId !== undefined) {
    const stage = await prisma.leadStage.findUnique({
      where: { id: input.stageId },
      select: { id: true },
    });
    if (!stage) {
      throw new ApiError(400, "validation_error", "所选阶段不存在");
    }
  }
  if (input.ownerId !== undefined) {
    const owner = await prisma.user.findFirst({
      where: { id: input.ownerId, status: "active" },
      select: { id: true },
    });
    if (!owner) {
      throw new ApiError(400, "validation_error", "所选负责人不存在或已停用");
    }
  }
}

export async function createExperiment(
  actor: AuthUser,
  input: ExperimentCreateInput,
): Promise<ExperimentListItem> {
  assertAdmin(actor);
  await assertRefsExist(input);
  const experiment = await prisma.experiment.create({
    data: {
      name: input.name,
      source: input.source,
      industry: input.industry,
      stageId: input.stageId,
      ownerId: input.ownerId,
      assistedRatio: input.assistedRatio ?? 50,
      minSampleSize: input.minSampleSize ?? 50,
      createdBy: actor.id,
    },
  });
  await writeAudit({
    userId: actor.id,
    action: AuditAction.experimentCreated,
    objectType: "experiment",
    objectId: experiment.id,
    detail: { name: experiment.name },
  });
  return toItem(experiment);
}

/**
 * 草稿改配置 / 进行中或草稿关闭。分组执行后配置冻结（C04）：
 * running 状态只接受 {status:"closed"}（Schema 层已拒绝混传）。
 * 关闭语义（T14 确认 UIUX P8 建议）：停止分组效果——常规组禁 AI 规则随
 * 实验关闭而解除（guard 只拦 running 实验），历史与统计保留可查。
 */
export async function updateExperiment(
  actor: AuthUser,
  id: string,
  input: ExperimentUpdateInput,
): Promise<ExperimentListItem> {
  assertAdmin(actor);
  const experiment = await loadExperiment(id);
  if (experiment.status === "closed") {
    throw new ApiError(409, "experiment_closed", "实验已关闭，不能再修改");
  }

  if (input.status === "closed") {
    const updated = await prisma.experiment.update({
      where: { id: experiment.id },
      data: { status: "closed", closedAt: new Date() },
    });
    await writeAudit({
      userId: actor.id,
      action: AuditAction.experimentClosed,
      objectType: "experiment",
      objectId: experiment.id,
      detail: { name: experiment.name },
    });
    return toItem(updated);
  }

  if (experiment.status !== "draft") {
    throw new ApiError(
      409,
      "experiment_locked",
      "分组已执行，实验配置固定不可修改（C04）",
    );
  }
  await assertRefsExist(input);
  const updated = await prisma.experiment.update({
    where: { id: experiment.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.industry !== undefined ? { industry: input.industry } : {}),
      ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.assistedRatio !== undefined
        ? { assistedRatio: input.assistedRatio }
        : {}),
      ...(input.minSampleSize !== undefined
        ? { minSampleSize: input.minSampleSize }
        : {}),
    },
  });
  await writeAudit({
    userId: actor.id,
    action: AuditAction.experimentUpdated,
    objectType: "experiment",
    objectId: experiment.id,
    detail: { name: updated.name },
  });
  return toItem(updated);
}

/** 圈选 where：与看板圈选同语义 + 排除已分组线索（同一线索不可重复分组） */
function assignmentCohortWhere(
  experiment: Pick<
    Experiment,
    "source" | "industry" | "stageId" | "ownerId"
  >,
): Prisma.LeadWhereInput {
  return {
    deletedAt: null,
    ...(experiment.source ? { source: experiment.source } : {}),
    ...(experiment.industry ? { industry: experiment.industry } : {}),
    ...(experiment.stageId ? { stageId: experiment.stageId } : {}),
    ...(experiment.ownerId ? { ownerId: experiment.ownerId } : {}),
    experimentAssignments: { none: {} },
  };
}

/** 预览圈选（UIUX P8：执行前显示"N 条线索，将分为常规组 A / AI 辅助组 B"） */
export async function previewAssignment(
  actor: AuthUser,
  id: string,
): Promise<{
  matched: number;
  alreadyGrouped: number;
  controlEstimate: number;
  assistedEstimate: number;
}> {
  assertAdmin(actor);
  const experiment = await loadExperiment(id);
  if (experiment.status !== "draft") {
    throw new ApiError(409, "experiment_not_draft", "该实验已执行过分组");
  }
  const matched = await prisma.lead.count({
    where: assignmentCohortWhere(experiment),
  });
  return {
    matched,
    alreadyGrouped: await countAlreadyGrouped(experiment),
    ...estimateSplit(matched, experiment.assistedRatio),
  };
}

/** 圈选范围内已被其他实验占用的线索数（预览时说明排除原因） */
async function countAlreadyGrouped(
  experiment: Pick<Experiment, "source" | "industry" | "stageId" | "ownerId">,
): Promise<number> {
  return prisma.lead.count({
    where: {
      deletedAt: null,
      ...(experiment.source ? { source: experiment.source } : {}),
      ...(experiment.industry ? { industry: experiment.industry } : {}),
      ...(experiment.stageId ? { stageId: experiment.stageId } : {}),
      ...(experiment.ownerId ? { ownerId: experiment.ownerId } : {}),
      experimentAssignments: { some: {} },
    },
  });
}

/**
 * 切分估算：AI 辅助组 = round(n × ratio%)；n ≥ 2 时两侧各至少 1 条。
 * 执行分组与预览共用同一规则（预览数 = 实际执行数，除非并发变动）。
 */
export function estimateSplit(
  matched: number,
  assistedRatio: number,
): { controlEstimate: number; assistedEstimate: number } {
  let assisted = Math.round((matched * assistedRatio) / 100);
  if (matched >= 2) {
    assisted = Math.min(Math.max(assisted, 1), matched - 1);
  }
  return { controlEstimate: matched - assisted, assistedEstimate: assisted };
}

/**
 * 执行分组（M3 强确认由前端承担，服务端只执行）：
 * 事务内按圈选（排除已分组）取线索 → 洗牌 → 切分 → 批量落 assignment
 * （规则+画像快照，PRD §5.10）→ 实验 draft→running。
 * 唯一约束兜底并发：同一线索被并发分组时事务失败 → 409。
 */
export async function assignExperiment(
  actor: AuthUser,
  id: string,
  options: {
    now?: Date;
    /** 测试注入：[0,1) 伪随机源（缺省用 crypto randomInt） */
    rng?: () => number;
  } = {},
): Promise<{
  experiment: ExperimentListItem;
  assigned: number;
  control: number;
  assisted: number;
}> {
  assertAdmin(actor);
  const experiment = await loadExperiment(id);
  if (experiment.status !== "draft") {
    throw new ApiError(409, "experiment_not_draft", "该实验已执行过分组");
  }
  const now = options.now ?? new Date();

  const leads = await prisma.lead.findMany({
    where: assignmentCohortWhere(experiment),
    select: {
      id: true,
      name: true,
      city: true,
      industry: true,
      source: true,
      salesTeamSize: true,
      revenueRange: true,
      ownerId: true,
      stage: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (leads.length === 0) {
    throw new ApiError(
      400,
      "experiment_no_leads",
      "按当前圈选条件没有可分组的线索（可能全部已被其他实验分组）",
    );
  }

  const shuffled = fisherYatesShuffle(leads, options.rng);
  const { assistedEstimate } = estimateSplit(leads.length, experiment.assistedRatio);
  const assistedIds = new Set(
    shuffled.slice(0, assistedEstimate).map((lead) => lead.id),
  );

  const ruleSnapshot: Prisma.InputJsonValue = {
    filters: {
      source: experiment.source,
      industry: experiment.industry,
      stageId: experiment.stageId,
      ownerId: experiment.ownerId,
    },
    assistedRatio: experiment.assistedRatio,
    method: ASSIGN_CONFIRM_RULE_NOTE,
    assignedAt: now.toISOString(),
  };

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.experimentAssignment.createMany({
        data: leads.map((lead) => ({
          experimentId: experiment.id,
          leadId: lead.id,
          group: assistedIds.has(lead.id) ? "assisted" : "control",
          ruleSnapshot,
          profileSnapshot: buildProfileSnapshot({
            name: lead.name,
            city: lead.city,
            industry: lead.industry,
            source: lead.source,
            salesTeamSize: lead.salesTeamSize,
            revenueRange: lead.revenueRange,
            stageName: lead.stage.name,
            ownerId: lead.ownerId,
          }),
          assignedAt: now,
          assignedBy: actor.id,
        })),
      });
      return tx.experiment.update({
        where: { id: experiment.id },
        data: {
          status: "running",
          assignedAt: now,
          assignedBy: actor.id,
          assignedCount: leads.length,
        },
      });
    });
    const assisted = assistedIds.size;
    await writeAudit({
      userId: actor.id,
      action: AuditAction.experimentAssigned,
      objectType: "experiment",
      objectId: experiment.id,
      detail: {
        name: experiment.name,
        assigned: leads.length,
        control: leads.length - assisted,
        assisted,
      },
    });
    return {
      experiment: toItem(result, {
        control: leads.length - assisted,
        assisted,
      }),
      assigned: leads.length,
      control: leads.length - assisted,
      assisted,
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiError(
        409,
        "experiment_lead_conflict",
        "部分线索已被其他实验分组（同一线索不可重复分组）",
      );
    }
    throw error;
  }
}

/** Fisher-Yates 洗牌（随机分组；rng 可注入以便测试固定切分） */
function fisherYatesShuffle<T>(items: T[], rng?: () => number): T[] {
  const array = [...items];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = rng
      ? Math.floor(rng() * (i + 1))
      : randomInt(0, i + 1);
    const temp = array[i] as T;
    array[i] = array[j] as T;
    array[j] = temp;
  }
  return array;
}
