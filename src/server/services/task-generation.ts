import { Prisma, Task } from "@prisma/client";
import { prisma } from "@/server/db";
import { describeError } from "@/server/http/redact";
import { expiryWindow } from "@/lib/expiry";
import {
  decideAutoTasks,
  FollowupPolicyLite,
  GenerationLeadContext,
  QuadrantCode,
} from "@/lib/followup";
import { cancelPendingAutoPlans } from "@/server/services/followup-plan";
import { TASK_GENERATION_TERMINAL_STAGES } from "@/server/services/followup-policies";

// 任务生成与重算引擎（V2.0-T06，实施计划 §4.5/§4.6）。
//
// 触发机制（决策 D3，零新增组件）：
// - 惰性触发：GET /api/tasks 与 GET /api/dashboard/summary（及 /tasks 页面 SSR）
//   处理前对当前用户范围执行（每天有人使用即完成当日生成，等效 PRD「每日运行」）；
// - 管理员手动：POST /api/tasks/generate 全量触发（盲区兜底 + 失败重试入口）；
// - 动态重算：五个触发字段（到期/系统/新一代/意愿/销售阶段）变化的写入事务内
//   调 recalcFollowUpPlan（取消未来计划 + 立即按新口径重建）。
//
// 幂等保证（PRD §2.4 / V2.2 第六节）：
// - 决策纯函数（lib/followup.ts）+ follow_up_cycles 有效行部分唯一索引 +
//   三类自动任务 pending 部分唯一索引；并发双事务冲突（P2002）捕获计 skipped；
// - 引擎只 INSERT；重算只把 pending 自动任务置 canceled（original_due_at 留痕）；
//   done/canceled 历史任何路径不可改（§4.5 防重 #6）；
// - 欠账只补当前一轮（anchor+interval 已过也只生成 dueAt=今天的一条）。
//
// 失败日志：异常写 audit_logs(action=task_generation_failed, 错误摘要脱敏)，
// 幂等保证可安全重试（§4.5）。

type Db = Prisma.TransactionClient | typeof prisma;

export interface GenerationStats {
  createdTasks: number;
  skippedTasks: number;
  bySource: Record<string, number>;
  createdCycleKeys: string[];
}

export type SourceType = Task["sourceType"];

function emptyStats(): GenerationStats {
  return { createdTasks: 0, skippedTasks: 0, bySource: {}, createdCycleKeys: [] };
}

/** 取复合键 `leadId:policyId` 映射中属于某客户的部分（键裁掉 lead 前缀） */
function scopeMapFor<T>(map: Map<string, T>, leadId: string): Map<string, T> {
  const prefix = `${leadId}:`;
  const result = new Map<string, T>();
  for (const [key, value] of map.entries()) {
    if (key.startsWith(prefix)) {
      result.set(key.slice(prefix.length), value);
    }
  }
  return result;
}

/** 加载策略表为决策上下文使用的轻量结构 */
async function loadPolicyContext(tx: Db): Promise<{
  systemPolicy: FollowupPolicyLite | null;
  quadrantPolicies: Partial<Record<QuadrantCode, FollowupPolicyLite>>;
}> {
  const rows = await tx.followUpPolicy.findMany();
  let systemPolicy: FollowupPolicyLite | null = null;
  const quadrantPolicies: Partial<Record<QuadrantCode, FollowupPolicyLite>> = {};
  for (const row of rows) {
    const lite: FollowupPolicyLite = {
      id: row.id,
      quadrantCode: row.quadrantCode,
      intervalDays: row.intervalDays,
      advanceDays: row.advanceDays,
      taskType: row.taskType,
      isActive: row.isActive,
      isSystem: row.isSystem,
    };
    if (row.isSystem) {
      systemPolicy = lite;
    } else if (row.quadrantCode) {
      quadrantPolicies[row.quadrantCode] = lite;
    }
  }
  return { systemPolicy, quadrantPolicies };
}

/**
 * 对指定客户集合执行一轮生成（幂等）。必须提供 leadIds（单客户重算）
 * 或 ownerId（销售范围）/无过滤（管理员全量）。在传入事务内执行，
 * 由 runTaskGeneration（自开事务）或 recalcFollowUpPlan（随调用方事务）调用。
 */
export async function generateForLeadsInTx(
  tx: Db,
  options: {
    leadIds?: string[];
    ownerId?: string;
    actorId?: string | null;
    now: Date;
  },
): Promise<GenerationStats> {
  const stats = emptyStats();
  const now = options.now;

  const leadWhere: Prisma.LeadWhereInput = {
    deletedAt: null,
    stage: { semanticKey: { notIn: [...TASK_GENERATION_TERMINAL_STAGES] } },
    ...(options.leadIds ? { id: { in: options.leadIds } } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
  };
  const leads = await tx.lead.findMany({
    where: leadWhere,
    select: {
      id: true,
      ownerId: true,
      quadrantCode: true,
      contractExpiry: true,
      quadrantComputedAt: true,
      createdAt: true,
    },
  });
  if (leads.length === 0) {
    return stats;
  }
  const leadIds = leads.map((lead) => lead.id);

  // —— 上下文聚合（逐表一次查询，内存组装；R4：2–3 账号量级无压力）——
  const [verifications, lastInteractions, lastDoneTasks, pendingTasks, activeCycles, roundRows, policyContext] =
    await Promise.all([
      tx.leadFieldVerification.findMany({
        where: { leadId: { in: leadIds }, fieldKey: "contract_expiry" },
        select: { leadId: true, status: true },
      }),
      tx.interaction.groupBy({
        by: ["leadId"],
        where: { leadId: { in: leadIds } },
        _max: { occurredAt: true },
      }),
      tx.task.groupBy({
        by: ["leadId"],
        where: { leadId: { in: leadIds }, status: "done", completedAt: { not: null } },
        _max: { completedAt: true },
      }),
      tx.task.findMany({
        where: { leadId: { in: leadIds }, status: "pending" },
        select: { leadId: true, sourceType: true },
      }),
      tx.followUpCycle.findMany({
        where: {
          leadId: { in: leadIds },
          status: { in: ["planned", "task_created"] as const },
        },
        select: { leadId: true, policyId: true, cycleKey: true },
      }),
      tx.followUpCycle.groupBy({
        by: ["leadId", "policyId"],
        where: { leadId: { in: leadIds }, status: { not: "superseded" } },
        _count: { _all: true },
      }),
      loadPolicyContext(tx),
    ]);

  const expiryStatusByLead = new Map(verifications.map((row) => [row.leadId, row.status]));
  const lastInteractionByLead = new Map(
    lastInteractions.map((row) => [row.leadId, row._max.occurredAt as Date | null]),
  );
  const lastDoneByLead = new Map(
    lastDoneTasks.map((row) => [row.leadId, row._max.completedAt as Date | null]),
  );
  const manualPending = new Set(
    pendingTasks.filter((row) => row.sourceType === "manual").map((row) => row.leadId),
  );
  const activeCycleKeys = new Map<string, Set<string>>();
  for (const row of activeCycles) {
    const key = `${row.leadId}:${row.policyId}`;
    const bucket = activeCycleKeys.get(key) ?? new Set<string>();
    bucket.add(row.cycleKey);
    activeCycleKeys.set(key, bucket);
  }
  const roundCount = new Map<string, number>();
  for (const row of roundRows) {
    roundCount.set(`${row.leadId}:${row.policyId}`, row._count._all);
  }

  for (const lead of leads) {
    const anchorCandidates = [
      lastInteractionByLead.get(lead.id) ?? null,
      lastDoneByLead.get(lead.id) ?? null,
      lead.quadrantComputedAt ?? null,
      lead.createdAt,
    ].filter((value): value is Date => value instanceof Date);
    const anchor = anchorCandidates.reduce<Date>(
      (latest, current) => (current > latest ? current : latest),
      lead.createdAt,
    );
    const ctx: GenerationLeadContext = {
      now,
      quadrant: (lead.quadrantCode as QuadrantCode | null) ?? null,
      contractExpiry: lead.contractExpiry,
      expiryVerificationStatus: expiryStatusByLead.get(lead.id) ?? "unknown",
      anchor,
      hasPendingManualTask: manualPending.has(lead.id),
      systemPolicy: policyContext.systemPolicy,
      quadrantPolicies: policyContext.quadrantPolicies,
      activeCycleKeys: scopeMapFor(activeCycleKeys, lead.id),
      roundCount: scopeMapFor(roundCount, lead.id),
    };

    const decisions = decideAutoTasks(ctx);
    for (const decision of decisions) {
      // 并发兜底（R5）：部分唯一索引冲突时只放弃本条决策、事务继续。
      // PG 事务内语句报错后整体中毒（25P02），必须用 SAVEPOINT 隔离：
      // 冲突 → ROLLBACK TO SAVEPOINT（连周期行一起回滚，不留孤儿）→ 跳过。
      await tx.$executeRawUnsafe("SAVEPOINT gen_task_decision");
      try {
        const cycle = await tx.followUpCycle.create({
          data: {
            leadId: lead.id,
            policyId: decision.policyId,
            cycleKey: decision.cycleKey,
            plannedDate: new Date(`${decision.plannedDate}T00:00:00.000Z`),
            status: "task_created",
          },
        });
        const task = await tx.task.create({
          data: {
            leadId: lead.id,
            assigneeId: lead.ownerId,
            createdBy: options.actorId ?? lead.ownerId,
            type: "follow_up",
            title: decision.title,
            dueAt: decision.dueAt,
            sourceType: decision.sourceType,
            autoGenerated: true,
            priority: decision.priority,
            policyId: decision.policyId,
            cycleId: cycle.id,
          },
        });
        await tx.followUpCycle.update({
          where: { id: cycle.id },
          data: { taskId: task.id },
        });
        await tx.$executeRawUnsafe("RELEASE SAVEPOINT gen_task_decision");
        stats.createdTasks += 1;
        stats.bySource[decision.sourceType] =
          (stats.bySource[decision.sourceType] ?? 0) + 1;
        stats.createdCycleKeys.push(`${lead.id}:${decision.sourceType}:${decision.cycleKey}`);
      } catch (error) {
        await tx
          .$executeRawUnsafe("ROLLBACK TO SAVEPOINT gen_task_decision")
          .catch(() => undefined);
        await tx
          .$executeRawUnsafe("RELEASE SAVEPOINT gen_task_decision")
          .catch(() => undefined);
        // 本轮已由并发事务生成 → 跳过不报错；其余异常上抛（失败日志在触发方）
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          stats.skippedTasks += 1;
          continue;
        }
        throw error;
      }
    }
  }
  return stats;
}

/**
 * 生成入口（自开事务）：惰性/手动触发共用。异常向上抛出，
 * 由触发方决定失败日志与页面兜底（§4.5）。
 */
export async function runTaskGeneration(options: {
  leadIds?: string[];
  ownerId?: string;
  actorId?: string | null;
  trigger?: "lazy" | "manual";
  now?: Date;
}): Promise<GenerationStats> {
  const now = options.now ?? new Date();
  return prisma.$transaction((tx) =>
    generateForLeadsInTx(tx, {
      leadIds: options.leadIds,
      ownerId: options.ownerId,
      actorId: options.actorId,
      now,
    }),
  );
}

/**
 * 惰性触发（页面/接口加载路径）：失败只记审计不阻塞页面（§4.5 失败日志 +
 * UIUX §4.9 首屏预算），返回 null = 本轮失败可重试。
 */
export async function runTaskGenerationLazy(actor: {
  id: string;
  role: string;
}): Promise<GenerationStats | null> {
  try {
    return await runTaskGeneration({
      ownerId: actor.role === "admin" ? undefined : actor.id,
      actorId: actor.id,
      trigger: "lazy",
    });
  } catch (error) {
    await prisma.auditLog
      .create({
        data: {
          userId: actor.id,
          action: "task_generation_failed",
          objectType: "task_generation",
          detail: {
            trigger: "lazy",
            error: describeError(error),
          } as unknown as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);
    return null;
  }
}

// ---------- 动态重算（V2.2 第五节，实施计划 §4.6） ----------

export interface RecalcResult {
  canceledTaskIds: string[];
  createdCycleKeys: string[];
}

/**
 * 重算单客户跟进计划（五个触发字段变化时调用，实施计划 §4.6）：
 * - 传入 tx（推荐）：在调用方写入事务内执行（与触发字段写入同事务）；
 * - 未传 tx：自开事务执行（直接重算入口）。
 *
 * 行为：
 * 1. 终态客户（won/closed）：取消全部 pending 自动任务（含月度），不重建（防重 #4）；
 * 2. 其他：取消 pending 的 quadrant_periodic/profile_gap（当月 expiry_monthly
 *    仍适用则保留——重建时同月唯一会自然跳过；窗口切换后不再适用的月度任务一并取消）；
 * 3. 按当前画像/到期/象限立即重建一轮（generateForLeadsInTx；注意象限刚变化时
 *    anchor=quadrant_computed_at=现在，新周期任务按新策略自然排期到未来）；
 * 4. 有取消或新建时写 lead_events(plan_changed)：{reason, canceledTaskIds,
 *    createdCycleKeys}（§3.3）；历史 done/canceled 一律不动。
 */
export async function recalcFollowUpPlan(
  leadId: string,
  reason: string,
  actorId: string | null,
  options: { now?: Date; tx?: Prisma.TransactionClient } = {},
): Promise<RecalcResult> {
  const now = options.now ?? new Date();
  if (options.tx) {
    return recalcInTx(options.tx, leadId, reason, actorId, now);
  }
  return prisma.$transaction((tx) => recalcInTx(tx, leadId, reason, actorId, now));
}

async function recalcInTx(
  tx: Db,
  leadId: string,
  reason: string,
  actorId: string | null,
  now: Date,
): Promise<RecalcResult> {
  const lead = await tx.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true,
      deletedAt: true,
      contractExpiry: true,
      stage: { select: { semanticKey: true } },
    },
  });
  if (!lead || lead.deletedAt) {
    return { canceledTaskIds: [], createdCycleKeys: [] };
  }

  const terminal = (TASK_GENERATION_TERMINAL_STAGES as readonly string[]).includes(
    lead.stage.semanticKey ?? "",
  );
  const stats = emptyStats();
  let canceledTaskIds: string[] = [];

  if (terminal) {
    // 已成交/已关闭：停止普通线索任务，pending 自动任务全部取消
    const result = await cancelPendingAutoPlans(tx, leadId, [
      "quadrant_periodic",
      "profile_gap",
      "expiry_monthly",
    ]);
    canceledTaskIds = result.canceledTaskIds;
  } else {
    const verification = await tx.leadFieldVerification.findUnique({
      where: { leadId_fieldKey: { leadId, fieldKey: "contract_expiry" } },
      select: { status: true },
    });
    const window = expiryWindow(lead.contractExpiry, now, {
      status: verification?.status ?? "unknown",
    });
    // 当月月度任务仍适用（within_6m/expired）则保留；窗口切换后不再适用则一并取消
    const sources: Task["sourceType"][] =
      window === "within_6m" || window === "expired"
        ? ["quadrant_periodic", "profile_gap"]
        : ["quadrant_periodic", "profile_gap", "expiry_monthly"];
    const result = await cancelPendingAutoPlans(tx, leadId, sources);
    canceledTaskIds = result.canceledTaskIds;
    const generated = await generateForLeadsInTx(tx, {
      leadIds: [leadId],
      actorId,
      now,
    });
    stats.createdCycleKeys.push(...generated.createdCycleKeys);
  }

  if (canceledTaskIds.length > 0 || stats.createdCycleKeys.length > 0) {
    await tx.leadEvent.create({
      data: {
        leadId,
        actorId,
        eventType: "plan_changed",
        detail: {
          reason,
          canceledTaskIds,
          createdCycleKeys: stats.createdCycleKeys,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }
  return { canceledTaskIds, createdCycleKeys: stats.createdCycleKeys };
}
