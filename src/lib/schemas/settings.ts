import { z } from "zod";
import { TASK_TYPES } from "@/lib/tasks";

// 设置中心入参 Schema（T03 部分：阶段全配置 + 自定义字段定义）。
// 管理员专属写操作；查询对所有登录用户开放（表单需要启用中的阶段/字段）。

// ---------- 阶段配置（K2/C02：开放全配置，语义锚点不可动） ----------

/** 小写字母开头，字母/数字/下划线，2–64 位 */
export const stageCodeSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{1,63}$/,
    "阶段编码须为小写字母开头的小写字母/数字/下划线，2–64 位",
  );

const stageNameSchema = z
  .string()
  .trim()
  .min(1, "请输入阶段名称")
  .max(64, "阶段名称不能超过 64 字");

/**
 * semanticKey 有意不出现在任何入参 Schema 中：
 * 语义锚点只随 seed 预置阶段创建，API 永远无法写入或修改（K2），
 * 指标口径因此不受改名/改码影响（T03 验收项，单测固化）。
 */
export const stageCreateSchema = z.object({
  code: stageCodeSchema,
  name: stageNameSchema,
  sortOrder: z.coerce.number().int().min(1, "排序值须为正整数").max(9999).optional(),
  isActive: z.boolean().optional(),
});

export const stageUpdateSchema = z
  .object({
    code: stageCodeSchema.optional(),
    name: stageNameSchema.optional(),
    sortOrder: z.coerce.number().int().min(1, "排序值须为正整数").max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    { message: "请至少提供一项要修改的内容" },
  );

// ---------- 自定义字段定义（C12：完整自定义字段方案） ----------

export const FIELD_TYPES = ["text", "number", "date", "single_select"] as const;

export const fieldKeySchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "字段标识须为小写字母开头的小写字母/数字/下划线，1–64 位",
  );

const fieldLabelSchema = z
  .string()
  .trim()
  .min(1, "请输入字段名称")
  .max(64, "字段名称不能超过 64 字");

const fieldOptionSchema = z
  .object({
    value: z
      .string()
      .trim()
      .min(1, "选项值不能为空")
      .max(64, "选项值不能超过 64 字"),
    label: z
      .string()
      .trim()
      .min(1, "选项名称不能为空")
      .max(64, "选项名称不能超过 64 字"),
  });

export const fieldValidationSchema = z
  .object({
    required: z.boolean().optional(),
    minLength: z.coerce.number().int().min(0).max(1000).optional(),
    maxLength: z.coerce.number().int().min(1).max(1000).optional(),
    min: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
    pattern: z.string().max(256, "正则表达式过长").optional(),
  })
  .refine(
    (v) =>
      v.minLength === undefined ||
      v.maxLength === undefined ||
      v.minLength <= v.maxLength,
    { message: "minLength 不能大于 maxLength", path: ["minLength"] },
  )
  .refine(
    (v) => v.min === undefined || v.max === undefined || v.min <= v.max,
    { message: "min 不能大于 max", path: ["min"] },
  );

export const fieldDefCreateSchema = z
  .object({
    key: fieldKeySchema,
    label: fieldLabelSchema,
    type: z.enum(FIELD_TYPES, { message: "字段类型不合法" }),
    options: z.array(fieldOptionSchema).min(1, "单选字段至少提供一个选项").max(50, "选项最多 50 个").optional(),
    validation: fieldValidationSchema.optional(),
    sortOrder: z.coerce.number().int().min(1).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.type !== "single_select" || (v.options?.length ?? 0) > 0, {
    message: "单选字段必须提供选项",
    path: ["options"],
  })
  .superRefine((v, ctx) => {
    if (v.options) {
      const values = v.options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "选项值不能重复",
        });
      }
    }
    if (v.validation?.pattern !== undefined && v.validation.pattern !== "") {
      try {
        new RegExp(v.validation.pattern, "u");
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["validation.pattern"],
          message: "正则表达式语法不合法",
        });
      }
    }
  });

/** key 与 type 不可修改：key 是 custom_values 的存储键、type 变更会使存量值失效 */
export const fieldDefUpdateSchema = z
  .object({
    label: fieldLabelSchema.optional(),
    options: z.array(fieldOptionSchema).min(1).max(50).optional(),
    validation: fieldValidationSchema.optional(),
    sortOrder: z.coerce.number().int().min(1).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    { message: "请至少提供一项要修改的内容" },
  )
  .superRefine((v, ctx) => {
    if (v.options) {
      const values = v.options.map((option) => option.value);
      if (new Set(values).size !== values.length) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "选项值不能重复",
        });
      }
    }
    if (v.validation?.pattern !== undefined && v.validation.pattern !== "") {
      try {
        new RegExp(v.validation.pattern, "u");
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["validation.pattern"],
          message: "正则表达式语法不合法",
        });
      }
    }
  });

export type StageCreateInput = z.infer<typeof stageCreateSchema>;
export type StageUpdateInput = z.infer<typeof stageUpdateSchema>;
export type FieldDefCreateInput = z.infer<typeof fieldDefCreateSchema>;
export type FieldDefUpdateInput = z.infer<typeof fieldDefUpdateSchema>;

// ---------- 数据字典（V2.0-T02，实施计划 §3.1 / 决策 D1） ----------
// 字典值即标准存储值（value 写入 leads 列），无独立 label；
// meta 仅 current_system 使用（isNextGen 新一代标记，驱动表单建议条）。

export const dictEntryCreateSchema = z.object({
  value: z
    .string()
    .trim()
    .min(1, "请输入字典值")
    .max(128, "字典值不能超过 128 字"),
  meta: z.record(z.string(), z.unknown()).optional(),
  sortOrder: z.coerce.number().int().min(1, "排序值须为正整数").max(9999).optional(),
});

/** 改值 = 换标准存储值（存量行不迁移，显示为不在字典中）；停用/启用走 isActive */
export const dictEntryUpdateSchema = z
  .object({
    value: z
      .string()
      .trim()
      .min(1, "请输入字典值")
      .max(128, "字典值不能超过 128 字")
      .optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    sortOrder: z.coerce.number().int().min(1).max(9999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "请至少提供一项要修改的内容",
  });

export type DictEntryCreateInput = z.infer<typeof dictEntryCreateSchema>;
export type DictEntryUpdateInput = z.infer<typeof dictEntryUpdateSchema>;

// ---------- 账号管理（T15，UIUX P9：管理员建号/重置密码/停用启用；无删除） ----------

const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9_-]{2,64}$/,
    "用户名须为 2–64 位字母/数字/下划线/中划线",
  );

const displayNameSchema = z
  .string()
  .trim()
  .min(1, "请输入姓名")
  .max(64, "姓名不能超过 64 字");

export const USER_ROLES = ["sales", "admin"] as const;
export const USER_STATUSES = ["active", "disabled"] as const;

export const userCreateSchema = z.object({
  username: usernameSchema,
  name: displayNameSchema,
  role: z.enum(USER_ROLES, { message: "角色不合法" }),
});

/** 账号管理仅提供停用/启用（改密走「账号与密码」或管理员重置，无其他编辑项） */
export const userStatusUpdateSchema = z.object({
  status: z.enum(USER_STATUSES, { message: "状态不合法" }),
});

export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserStatusUpdateInput = z.infer<typeof userStatusUpdateSchema>;

// ---------- 操作日志查询（T15，UIUX P9：时间范围/动作/操作人筛选 + 分页） ----------

const auditDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD");

export const auditLogQuerySchema = z
  .object({
    action: z.string().trim().max(64).optional(),
    // 宽松 UUID 形态（zod v4 的 .uuid() 校验版本位，会误伤测试 id）
    userId: z
      .string()
      .trim()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "操作人参数不合法",
      )
      .optional(),
    from: auditDateSchema.optional(),
    to: auditDateSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).optional(),
  })
  .refine(
    (value) =>
      value.from === undefined ||
      value.to === undefined ||
      value.from <= value.to,
    { message: "开始日期不能晚于结束日期", path: ["from"] },
  );

export type AuditLogQueryInput = z.infer<typeof auditLogQuerySchema>;

// ---------- 提示词版本（T15，验收项：版本不可变可追溯；只增不改） ----------

export const promptVersionCreateSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, "请输入提示词内容")
    .max(32000, "提示词内容不能超过 32000 字"),
  // 结构提示（可选）：必须为 JSON 对象；随版本固化，供编辑器与校验器参考
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

export type PromptVersionCreateInput = z.infer<typeof promptVersionCreateSchema>;

// ---------- 跟进策略（V2.0-T05，实施计划 §3.2 / 决策 D2 / 口径 P6） ----------
// 5 行固定（4 象限 + 1 系统月度），仅允许改 周期/任务类型/提前量/启停——
// 名称/象限/系统行归属为配置身份，不开放修改；系统行（isSystem）整行只读
// （P6：半年内月度规则不可被策略覆盖，UIUX §5.5 🔒）。
// UIUX §5.5：「周期输入 1–365 整数，行内即时校验」（错误文案 §7.3）。

export const FOLLOWUP_INTERVAL_MIN = 1;
export const FOLLOWUP_INTERVAL_MAX = 365;

export const followupPolicyUpdateItemSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "策略 ID 不合法",
    ),
  intervalDays: z.coerce
    .number()
    .int("跟进周期需为整数")
    .min(FOLLOWUP_INTERVAL_MIN, `跟进周期需为 ${FOLLOWUP_INTERVAL_MIN}–${FOLLOWUP_INTERVAL_MAX} 的整数`)
    .max(FOLLOWUP_INTERVAL_MAX, `跟进周期需为 ${FOLLOWUP_INTERVAL_MIN}–${FOLLOWUP_INTERVAL_MAX} 的整数`),
  taskType: z.enum(TASK_TYPES, { message: "任务类型不合法" }),
  advanceDays: z.coerce
    .number()
    .int("任务生成提前量需为整数")
    .min(0, "提前量不能为负")
    .max(90, "提前量最多 90 天"),
  isActive: z.boolean(),
});

/** [保存全部]：一次提交四条象限策略的完整行 */
export const followupPoliciesUpdateSchema = z.object({
  policies: z.array(followupPolicyUpdateItemSchema).min(1).max(4),
});

export type FollowupPolicyUpdateItem = z.infer<typeof followupPolicyUpdateItemSchema>;
export type FollowupPoliciesUpdateInput = z.infer<typeof followupPoliciesUpdateSchema>;
