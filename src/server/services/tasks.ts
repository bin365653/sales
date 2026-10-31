import {
  Interaction,
  Lead,
  LeadStage,
  Prisma,
  Task,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { parseShanghaiDate } from "@/lib/schemas/lead";
import {
  TaskCompleteInput,
  TaskCreateInput,
  TaskListQuery,
  TaskUpdateInput,
} from "@/lib/schemas/task";
import {
  isTaskOverdue,
  startOfShanghaiDay,
  taskOverdueDays,
  TaskStatusValue,
} from "@/lib/tasks";
import { applyInteractionWrite } from "@/server/services/interaction-write";
import { assertLeadReadable, assertLeadWritable, leadReadScope } from "@/server/permissions";

// 任务服务（T07，PRD §5.7 / UIUX P6 / 实施计划 §6 任务端点）。
// 关键不变量：
// - 每项任务必须关联客户；assignee_id = 创建时线索负责人快照（§4.1，不设改派），
//   created_by 记录创建者；可见性一律经线索归属判定（§4.4，读写都过 permissions 层，
//   越权一律 404）；
// - 任务只可取消、不可删除（C11）；完成只经 complete-with-interaction（P6 弹窗），
//   状态不可手工置为 done——完成必须同时留下沟通记录（completed_at + interaction_id）；
// - 完成事务（验收项）：任务标记 done（记 completed_at）+ 沟通记录 +
//   线索副作用（last_contact_at / K4 阶段联动，复用 interaction-write 核心）+
//   可选下一任务，任一步失败整体回滚（§7 原则 5）；
// - 视图口径（今日/逾期，上海日界 C13）：逾期 = 待处理且截止日早于今天；
//   今日视图含逾期置顶（dueAt 升序自然实现），与工作台卡片（T12）同一实现。

type Db = Prisma.TransactionClient | typeof prisma;

// ---------- 优先级映射（V2.0-T05，§4.4） ----------
// 手工任务在创建时按类型写入优先级：客户约定类=1、预约演示/拜访=2；
// 自动任务由生成引擎写入 3（到期月度）/4（画像补充）/5（象限周期）。
// 列表排序按 priority 升序 + 逾期/阶段综合（§4.4：约定任务恒排前）。

export function manualTaskPriority(type: Task["type"]): number {
  return type === "online_demo" || type === "offline_visit" ? 2 : 1;
}

// ---------- 创建 ----------

export interface InsertTaskParams {
  leadId: string;
  assigneeId: string;
  createdBy: string;
  type: Task["type"];
  title: string;
  dueAt: Date;
  remark: string | null;
}

/** 任务创建核心（新建 / 沟通保存"同时创建任务" / 完成弹窗"下一任务"共用） */
export async function insertTaskInTx(
  tx: Db,
  params: InsertTaskParams,
): Promise<Task> {
  return tx.task.create({
    data: {
      leadId: params.leadId,
      assigneeId: params.assigneeId,
      createdBy: params.createdBy,
      type: params.type,
      title: params.title,
      dueAt: params.dueAt,
      remark: params.remark,
      priority: manualTaskPriority(params.type),
    },
  });
}

export async function createTask(
  actor: AuthUser,
  input: TaskCreateInput,
): Promise<Task> {
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, deletedAt: null },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  assertLeadWritable(actor, lead.ownerId);

  return insertTaskInTx(prisma, {
    leadId: lead.id,
    assigneeId: lead.ownerId,
    createdBy: actor.id,
    type: input.type,
    title: input.title,
    dueAt: parseShanghaiDate(input.dueAt),
    remark: input.remark ?? null,
  });
}

// ---------- 编辑 / 取消（PATCH /api/tasks/:id） ----------

export async function updateTask(
  actor: AuthUser,
  id: string,
  input: TaskUpdateInput,
): Promise<Task> {
  const task = await loadTaskWithLeadOrThrow(id);
  assertLeadWritable(actor, task.lead.ownerId);

  if (task.status !== "pending") {
    throw new ApiError(
      400,
      "task_not_editable",
      "已完成或已取消的任务不能再修改",
    );
  }

  // 取消：简单状态迁移（C11 只可取消不可删）；条件更新防并发重复处理
  if (input.status === "canceled") {
    const canceled = await prisma.task.updateMany({
      where: { id: task.id, status: "pending" },
      data: { status: "canceled" },
    });
    if (canceled.count !== 1) {
      throw new ApiError(409, "task_conflict", "任务已被其他操作处理，请刷新后重试");
    }
    return prisma.task.findUniqueOrThrow({ where: { id: task.id } });
  }

  const updated = await prisma.task.updateMany({
    where: { id: task.id, status: "pending" },
    data: {
      ...(input.type !== undefined
        ? { type: input.type, priority: manualTaskPriority(input.type) }
        : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.dueAt !== undefined ? { dueAt: parseShanghaiDate(input.dueAt) } : {}),
      ...(input.remark !== undefined ? { remark: input.remark ?? null } : {}),
    },
  });
  if (updated.count !== 1) {
    throw new ApiError(409, "task_conflict", "任务已被其他操作处理，请刷新后重试");
  }
  return prisma.task.findUniqueOrThrow({ where: { id: task.id } });
}

// ---------- 完成任务弹窗（POST /api/tasks/:id/complete-with-interaction） ----------

export interface CompleteTaskResult {
  task: Task;
  interaction: Interaction;
  /** 沟通结果触发的阶段推进（K4）；null = 未推进 */
  stageAdvanced: { fromStageId: string; toStageId: string } | null;
  /** 勾选"创建下一步任务"时创建的任务；null = 暂不创建 */
  nextTask: Task | null;
}

export async function completeTaskWithInteraction(
  actor: AuthUser,
  id: string,
  input: TaskCompleteInput,
): Promise<CompleteTaskResult> {
  const task = await loadTaskWithLeadOrThrow(id);
  if (task.lead.deletedAt !== null) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  assertLeadWritable(actor, task.lead.ownerId);
  if (task.status !== "pending") {
    throw new ApiError(400, "task_not_editable", "任务已完成或已取消，不能重复完成");
  }

  const lead = task.lead as Lead & { stage: LeadStage };
  const completedAt = new Date();

  const { interaction, advance, nextTask } = await prisma.$transaction(
    async (tx) => {
      // 1) 任务标记完成（仅 pending 命中：并发下第二次完成 0 行 → 冲突）
      const marked = await tx.task.updateMany({
        where: { id: task.id, status: "pending" },
        data: { status: "done", completedAt },
      });
      if (marked.count !== 1) {
        throw new ApiError(
          409,
          "task_conflict",
          "任务已被其他操作处理，请刷新后重试",
        );
      }

      // 2) 沟通记录 + 线索副作用（last_contact_at / 本次确认 / K4），与沟通保存同一核心
      const { interaction, advance } = await applyInteractionWrite(
        tx,
        lead,
        actor.id,
        input.interaction,
      );

      // 3) 回填沟通记录引用（UIUX P6：已完成任务显示完成时间与沟通记录链接）
      await tx.task.update({
        where: { id: task.id },
        data: { interactionId: interaction.id },
      });

      // 4) 下一任务（可选，同事务；归属线索负责人快照）
      const nextTask = input.nextTask
        ? await insertTaskInTx(tx, {
            leadId: lead.id,
            assigneeId: lead.ownerId,
            createdBy: actor.id,
            type: input.nextTask.type,
            title: input.nextTask.title,
            dueAt: parseShanghaiDate(input.nextTask.dueAt),
            remark: input.nextTask.remark ?? null,
          })
        : null;

      return { interaction, advance, nextTask };
    },
  );

  return {
    task: await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
    interaction,
    stageAdvanced: advance
      ? { fromStageId: advance.fromStage.id, toStageId: advance.toStage.id }
      : null,
    nextTask,
  };
}

// ---------- 读取 ----------

async function loadTaskWithLeadOrThrow(
  id: string,
): Promise<Task & { lead: Lead & { stage: LeadStage } }> {
  const task = await prisma.task.findUnique({
    where: { id },
    include: { lead: { include: { stage: true } } },
  });
  if (!task) {
    throw new ApiError(404, "not_found", "任务不存在");
  }
  return task as Task & { lead: Lead & { stage: LeadStage } };
}

/** 客户详情页任务列表（P5 任务区块，与任务中心同一套可见性） */
export async function listLeadTasks(
  actor: AuthUser,
  leadId: string,
): Promise<Task[]> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  assertLeadReadable(actor, lead.ownerId);
  const rows = await prisma.task.findMany({
    where: { leadId },
    include: {
      // 自动任务来源徽章/原因行需要策略区间（V2.0-T07）
      policy: { select: { quadrantCode: true, intervalDays: true } },
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });
  // 待处理在前（按截止时间升序），已完成/已取消按完成时间倒序殿后
  const pending = rows.filter((row) => row.status === "pending");
  const finished = rows
    .filter((row) => row.status !== "pending")
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  return [...pending, ...finished];
}

// ---------- 今日/逾期计数（工作台卡片 T12 与任务中心同一实现） ----------

/**
 * 今日/逾期任务计数（上海日界，C13）：今日 = 截止日为今天的待处理；
 * 逾期 = 待处理且截止日早于今天。工作台「今日任务/逾期任务」卡片（T12）
 * 与任务中心 counts 字段共用本实现——口径必然一致。
 */
export async function getTaskCounts(
  actor: AuthUser,
  now: Date = new Date(),
): Promise<{ today: number; overdue: number }> {
  const todayStart = startOfShanghaiDay(0, now);
  const tomorrowStart = startOfShanghaiDay(1, now);
  const scope = leadReadScope(actor);
  const leadFilter = scope.ownerId
    ? { lead: { ownerId: scope.ownerId } }
    : {};
  const [today, overdue] = await Promise.all([
    prisma.task.count({
      where: {
        ...leadFilter,
        status: "pending",
        dueAt: { gte: todayStart, lt: tomorrowStart },
      },
    }),
    prisma.task.count({
      where: { ...leadFilter, status: "pending", dueAt: { lt: todayStart } },
    }),
  ]);
  return { today, overdue };
}

// ---------- 任务中心列表（GET /api/tasks 与 /tasks 页面共用同一实现） ----------

export interface TaskListResult {
  items: (Task & {
    lead: {
      id: string;
      name: string;
      stageId: string;
      stage: LeadStage;
      contractExpiry: Date | null;
      /** contract_expiry 核实行状态（原因行文案的窗口口径） */
      expiryStatus: string;
    };
    policy: { quadrantCode: string | null; intervalDays: number } | null;
    interaction: { id: string; occurredAt: Date } | null;
  })[];
  total: number;
  page: number;
  pageSize: number;
  /** 待处理任务数：今日（截止日=今天，工作台"今日任务"口径）与逾期 */
  counts: { today: number; overdue: number };
}

export async function listTasks(
  actor: AuthUser,
  query: TaskListQuery,
  options: { now?: Date } = {},
): Promise<TaskListResult> {
  const now = options.now ?? new Date();
  const todayStart = startOfShanghaiDay(0, now);
  const tomorrowStart = startOfShanghaiDay(1, now);

  // 可见性经线索归属判定（§4.4）：销售=本人客户的任务，管理员=全量
  const scope = leadReadScope(actor);
  const leadFilter = scope.ownerId
    ? { lead: { ownerId: scope.ownerId } }
    : {};

  let where: Prisma.TaskWhereInput;
  switch (query.view) {
    case "overdue":
      // 逾期 = 待处理且截止日早于今天 00:00（上海日界，跨日才算逾期）
      where = { ...leadFilter, status: "pending", dueAt: { lt: todayStart } };
      break;
    case "today":
      // 今日视图含逾期置顶：截止日早于明日 00:00 的全部待处理任务
      where = { ...leadFilter, status: "pending", dueAt: { lt: tomorrowStart } };
      break;
    default:
      where = {
        ...leadFilter,
        ...(query.status !== "all" ? { status: query.status as TaskStatusValue } : {}),
      };
  }
  // V2.0-T07：来源筛选（到期月度/四象限周期/画像补充/手工约定）
  if (query.sourceType !== "all") {
    where = { ...where, sourceType: query.sourceType };
  }

  const [items, total] = await Promise.all([
    prisma.task.findMany({
      where,
      include: {
        lead: {
          select: {
            id: true,
            name: true,
            stageId: true,
            stage: true,
            contractExpiry: true,
            fieldVerifications: {
              where: { fieldKey: "contract_expiry" },
              select: { status: true },
              take: 1,
            },
          },
        },
        policy: { select: { quadrantCode: true, intervalDays: true } },
        interaction: { select: { id: true, occurredAt: true } },
      },
      // V2.0-T07 排序（§4.4，服务端排序前端不重排）：优先级 1→5
      // （约定→预约→月度→画像→周期），同优先级按截止时间（逾期久的在前），
      // 再按客户阶段；priority 恒非空（存量已回填、新建写入）
      orderBy: [
        { priority: "asc" },
        { dueAt: "asc" },
        { lead: { stage: { sortOrder: "asc" } } },
        { id: "asc" },
      ],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.task.count({ where }),
  ]);
  const counts = await getTaskCounts(actor, now);

  return {
    items: items.map((task) => ({
      ...task,
      lead: {
        id: task.lead.id,
        name: task.lead.name,
        stageId: task.lead.stageId,
        stage: task.lead.stage,
        contractExpiry: task.lead.contractExpiry,
        expiryStatus: task.lead.fieldVerifications[0]?.status ?? "unknown",
      },
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    counts,
  };
}

// ---------- 逾期标记（展示辅助：列表行统一在此计算，前端不自算） ----------

export function taskOverdueInfo(
  task: Pick<Task, "dueAt" | "status">,
  now: Date = new Date(),
): { overdue: boolean; days: number | null } {
  if (!isTaskOverdue(task.dueAt, task.status as TaskStatusValue, now)) {
    return { overdue: false, days: null };
  }
  return { overdue: true, days: taskOverdueDays(task.dueAt, now) };
}
