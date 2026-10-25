import { z } from "zod";
import { TASK_STATUSES, TASK_TYPES } from "@/lib/tasks";
import { interactionCreateSchema } from "@/lib/schemas/interaction";

// 任务入参 Schema（T07）：API 入参与前端表单共用（实施计划 §2.1）。
// 字段全集 = PRD §5.7（关联客户 + 类型/标题/截止时间/状态/备注）。
//
// 设计要点：
// - 截止时间为本地日期时间，按 Asia/Shanghai 解释（C13，与 next_contact_at 同口径）；
//   允许只填日期（按当日 00:00），不限制过去/未来（补录历史任务合法，逾期视图负责呈现）；
// - 状态不由新建指定（恒为 pending），取消走 PATCH status=canceled 且禁止与其他
//   字段混提（完成任务只经 complete-with-interaction 端点，不开放 status=done）；
// - complete-with-interaction 复用 interactionCreateSchema 全量校验：
//   完成弹窗的沟通结果与沟通保存一字不差（effective 依赖 connected 等交叉规则继承）；
// - 沟通保存"同时创建任务"（UIUX P5）与完成弹窗"创建下一步任务"（P6）
//   共用 nextTaskSchema，标题/截止时间必填（标题由表单自动生成，仍可改）。

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID 格式不合法",
  );

const emptyToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** 截止时间：YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本地时间按上海解释） */
const dueAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/,
    "截止时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm",
  );

const titleSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string()
    .min(1, "请输入任务标题")
    .max(128, "任务标题不能超过 128 字"),
);

const remarkSchema = z.preprocess(
  emptyToNull,
  z.string().trim().max(2000, "备注不能超过 2000 字").nullable().optional(),
);

/** 下一任务 / 同时创建任务的载荷（P5 沟通表单与 P6 完成弹窗共用） */
export const nextTaskSchema = z.object({
  type: z.enum(TASK_TYPES, { message: "任务类型不合法" }),
  title: titleSchema,
  dueAt: dueAtSchema,
  remark: remarkSchema,
});

export type NextTaskInput = z.infer<typeof nextTaskSchema>;

// ---------- 新建任务（POST /api/tasks） ----------

export const taskCreateSchema = z.object({
  leadId: uuidSchema,
  type: z.enum(TASK_TYPES, { message: "任务类型不合法" }),
  title: titleSchema,
  dueAt: dueAtSchema,
  remark: remarkSchema,
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

// ---------- 编辑 / 取消（PATCH /api/tasks/:id） ----------

export const taskUpdateSchema = z
  .object({
    status: z
      .literal("canceled", {
        message: "任务状态仅支持取消（完成请走完成弹窗）",
      })
      .optional(),
    type: z.enum(TASK_TYPES, { message: "任务类型不合法" }).optional(),
    title: titleSchema.optional(),
    dueAt: dueAtSchema.optional(),
    remark: remarkSchema,
  })
  .refine(
    (value) =>
      value.status === undefined ||
      (value.type === undefined &&
        value.title === undefined &&
        value.dueAt === undefined &&
        value.remark === undefined),
    { message: "取消任务不能同时修改其他字段", path: ["status"] },
  )
  .refine(
    (value) =>
      value.status !== undefined ||
      value.type !== undefined ||
      value.title !== undefined ||
      value.dueAt !== undefined ||
      value.remark !== undefined,
    { message: "请提供要修改的字段" },
  );

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

// ---------- 完成任务（POST /api/tasks/:id/complete-with-interaction） ----------

export const taskCompleteSchema = z.object({
  interaction: interactionCreateSchema,
  nextTask: nextTaskSchema.nullable().optional(),
});

export type TaskCompleteInput = z.infer<typeof taskCompleteSchema>;

// ---------- 沟通保存扩展（POST /api/leads/:id/interactions 的"同时创建任务"） ----------

export const interactionCreateWithTaskSchema = interactionCreateSchema.extend({
  createTask: nextTaskSchema.nullable().optional(),
});

export type InteractionCreateWithTaskInput = z.infer<
  typeof interactionCreateWithTaskSchema
>;

// ---------- 任务中心列表查询（GET /api/tasks 与 /tasks 页面共用） ----------

export const TASK_LIST_VIEWS = ["today", "overdue", "all"] as const;
export type TaskListView = (typeof TASK_LIST_VIEWS)[number];

export const VIEW_LABELS: Record<TaskListView, string> = {
  today: "今日",
  overdue: "逾期",
  all: "全部",
};

export const taskListQuerySchema = z.object({
  view: z.enum(TASK_LIST_VIEWS).default("today"),
  /** 仅"全部"视图生效；今日/逾期恒为待处理 */
  status: z.enum([...TASK_STATUSES, "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type TaskListQuery = z.infer<typeof taskListQuerySchema>;
