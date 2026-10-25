import { z } from "zod";

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
