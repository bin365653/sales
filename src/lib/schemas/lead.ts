import { z } from "zod";
import { BUILTIN_LEAD_FIELD_KEYS } from "@/lib/lead-fields";

// 线索相关入参 Schema（T03）：API 入参与前端表单共用同一份定义（实施计划 §2.1），
// 字段校验前后端一致由"共用本文件"保证。
//
// 设计要点：
// - 除 name 外全部字段可空（PRD §5.3：允许为空，不得强迫填写虚假数据 → 空值可保存）；
// - 空字符串一律归一化为 null（表单空输入 = 清空，而非保存 ""）；
// - undefined（编辑时未提交）与 null（显式清空）语义区分，PATCH 局部更新依赖该区分；
// - 客户阶段不在本 Schema 内：阶段流转只走 PATCH /api/leads/:id/stage 单一入口。

export const FACT_STATUSES = ["unknown", "unverified", "confirmed"] as const;
export const LEAD_PRIORITIES = ["high", "mid", "low"] as const;

const factStatusSchema = z.enum(FACT_STATUSES, {
  message: "核实状态须为 unknown / unverified / confirmed",
});

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID 格式不合法",
  );

/** 空字符串 → null；其余原样传递（由内层校验） */
const emptyToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

/** 可空文本：trim 后限长，空串归一化为 null */
const optionalText = (max: number, label: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(max, `${label}不能超过 ${max} 字`)
      .nullable()
      .optional(),
  );

const optionalMultilineText = (label: string) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(2000, `${label}不能超过 2000 字`).nullable().optional(),
  );

/** 可空整数（业务员人数）：接受数字或整数字符串，空串 → null */
const optionalPositiveInt = (label: string) =>
  z.preprocess(
    (value) => {
      if (value === "" || value === null || value === undefined) {
        return null;
      }
      return typeof value === "string" ? Number(value) : value;
    },
    z
      .number()
      .int(`${label}须为整数`)
      .min(1, `${label}须为不小于 1 的整数`)
      .max(1_000_000, `${label}过大`)
      .nullable()
      .optional(),
  );

/** 可空布尔：接受 "true"/"false"/""（表单值），归一化为 boolean/null */
const optionalBoolean = () =>
  z.preprocess(
    (value) => {
      if (value === "") {
        return null;
      }
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
      return value;
    },
    z.boolean().nullable().optional(),
  );

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

const phoneSchema = z
  .string()
  .trim()
  .max(32, "联系方式不能超过 32 个字符")
  .regex(/^[+\d][\d\-\s()]*$/, "联系方式仅支持数字及 + - ( ) 空格");

/**
 * 本地日期时间（无时区后缀）统一按 Asia/Shanghai（+08:00）解释（决策 C13）：
 * - "2026-10-25" → 2026-10-25 00:00:00 +08:00（下次联系按整天计划）；
 * - "2026-10-25T14:30" / "2026-10-25 14:30" → 同日 14:30 +08:00；
 * - 带时区/Z 后缀的完整 ISO 串原样解析。
 */
export function parseShanghaiDate(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00+08:00`);
  }
  const naive = value.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (naive) {
    const [, day, hm, sec] = naive;
    return new Date(`${day}T${hm}:${sec ?? "00"}+08:00`);
  }
  return new Date(value);
}

const optionalDateString = (label: string) =>
  z.preprocess(
    emptyToNull,
    dateStringSchema.refine((v) => v === undefined || isValidDay(v), {
      message: `${label}不是有效的日历日期`,
    }).nullable().optional(),
  );

function isValidDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const optionalLocalDatetime = z.preprocess(
  emptyToNull,
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/,
      "时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm",
    )
    .nullable()
    .optional(),
);

// ---------- 线索新建 ----------

export const leadCreateSchema = z.object({
  name: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z
      .string()
      .min(1, "请输入客户名称")
      .max(128, "客户名称不能超过 128 字"),
  ),
  city: optionalText(64, "城市"),
  industry: optionalText(64, "行业细分"),
  mainCategory: optionalText(128, "主营品类"),
  contactName: optionalText(64, "联系人"),
  contactTitle: optionalText(64, "联系人职务"),
  contactPhone: z.preprocess(emptyToNull, phoneSchema.nullable().optional()),
  source: optionalText(64, "客户来源"),
  salesTeamSize: optionalPositiveInt("业务员人数"),
  revenueRange: optionalText(64, "营收区间"),
  salesMode: optionalText(64, "销售模式"),
  currentSystem: optionalText(128, "当前使用系统"),
  systemModules: optionalText(255, "使用模块"),
  contractExpiry: optionalDateString("合同/到期时间"),
  knownPains: optionalMultilineText("已知不满"),
  consideringSwitch: optionalBoolean(),
  hasClearDemand: optionalBoolean(),
  purchaseTime: optionalText(64, "采购时间"),
  budget: optionalText(64, "预算情况"),
  decisionMaker: optionalText(128, "决策人"),
  decisionProcess: optionalText(255, "决策流程"),
  mainConcerns: optionalMultilineText("主要顾虑"),
  currentSystemStatus: factStatusSchema.optional(),
  contractExpiryStatus: factStatusSchema.optional(),
  purchaseTimeStatus: factStatusSchema.optional(),
  decisionMakerStatus: factStatusSchema.optional(),
  priority: z.enum(LEAD_PRIORITIES, { message: "优先级须为 high / mid / low" }).optional(),
  /** 缺省时落到语义锚点 new_lead 对应的启用阶段（见线索服务） */
  stageId: uuidSchema.optional(),
  nextContactAt: optionalLocalDatetime,
  remark: optionalMultilineText("备注"),
  /** 自定义字段值：键为字段稳定 key；类型/必填/选项校验由 lead-field-validation 引擎按库中定义执行 */
  customValues: z
    .record(z.string(), z.union([z.string(), z.number(), z.null()]))
    .optional(),
});

// ---------- 线索编辑（局部更新；dataVersion 乐观并发控制） ----------

export const leadUpdateSchema = leadCreateSchema
  .omit({ stageId: true })
  .extend({
    name: z.preprocess(
      (value) => {
        if (value === undefined) {
          return value;
        }
        return typeof value === "string" ? value.trim() : value;
      },
      z.string().min(1, "客户名称不能为空").max(128, "客户名称不能超过 128 字").optional(),
    ),
    dataVersion: z
      .number({ message: "请提供数据版本号 dataVersion" })
      .int()
      .min(1, "dataVersion 不合法"),
  });

// ---------- 阶段流转（PATCH /api/leads/:id/stage） ----------

export const leadStageTransitionSchema = z.object({
  stageId: uuidSchema,
  dataVersion: z.number({ message: "请提供数据版本号 dataVersion" }).int().min(1),
});

// ---------- 线索列表查询（GET /api/leads） ----------
// 组合筛选与分页由 T04 线索池消费；T03 先交付 API 能力。

const optionalFilter = (label: string) =>
  z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().min(1, `${label}筛选条件不合法`).max(128).optional(),
  );

export const leadListQuerySchema = z.object({
  page: z.coerce.number().int().min(1, "页码不合法").max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1, "每页条数不合法").max(100).default(20),
  keyword: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().trim().max(64, "关键词过长").optional(),
  ),
  city: optionalFilter("城市"),
  industry: optionalFilter("行业"),
  source: optionalFilter("客户来源"),
  salesMode: optionalFilter("销售模式"),
  currentSystem: optionalFilter("在用系统"),
  stageId: uuidSchema.optional(),
  priority: z.enum(LEAD_PRIORITIES).optional(),
  /** 仅管理员生效：按负责人筛选（销售强制限定本人，K1） */
  ownerId: uuidSchema.optional(),
});

// ---------- 批量修改（PATCH /api/leads/batch，T04） ----------
// 白名单刻意收窄为"管理性字段"：优先级、阶段、来源、下次联系时间。
// 客户名称等画像事实字段不支持批量改——多条客户的事实不可能一次成立，
// 逐条编辑才是正确语义（实施计划 §6「限定可批量字段」验收项）。
// strictObject：白名单外字段直接报错，不静默忽略。

export const BATCH_UPDATABLE_FIELDS = [
  "priority",
  "stageId",
  "source",
  "nextContactAt",
] as const;

export type BatchUpdatableField = (typeof BATCH_UPDATABLE_FIELDS)[number];

const batchChangesSchema = z
  .strictObject(
    {
      priority: z
        .enum(LEAD_PRIORITIES, { message: "优先级须为 high / mid / low" })
        .optional(),
      stageId: uuidSchema.optional(),
      source: optionalText(64, "客户来源"),
      nextContactAt: optionalLocalDatetime,
    },
    {
      error: "批量修改仅支持：优先级、客户阶段、客户来源、下次联系时间",
    },
  )
  .refine(
    (value) =>
      BATCH_UPDATABLE_FIELDS.some((field) => value[field] !== undefined),
    { message: "请至少提供一项要修改的字段" },
  );

export const leadBatchUpdateSchema = z.object({
  ids: z
    .array(uuidSchema)
    .min(1, "请选择要修改的客户")
    .max(100, "单次最多修改 100 条客户")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "客户列表存在重复",
    }),
  changes: batchChangesSchema,
});

export type LeadBatchUpdateInput = z.infer<typeof leadBatchUpdateSchema>;

export type LeadCreateInput = z.infer<typeof leadCreateSchema>;
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;
export type LeadStageTransitionInput = z.infer<typeof leadStageTransitionSchema>;
export type LeadListQuery = z.infer<typeof leadListQuerySchema>;

/** 编辑请求里出现的内置字段键（snake_case def key），用于停用检查 */
export function providedBuiltinKeys(input: object): string[] {
  const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return Object.keys(input)
    .map(camelToSnake)
    .filter((key) => BUILTIN_LEAD_FIELD_KEYS.has(key));
}

