import { z } from "zod";

// AI 入参 Schema（T08，实施计划 §6 AI / 设置端点、§7.1 模块划分）。
// run_type 三类贯穿 ai_runs / prompt_templates / 校验器（§4.2、§7.1）。

export const RUN_TYPES = ["analysis", "call_prep", "interaction_summary"] as const;

export type RunTypeValue = (typeof RUN_TYPES)[number];

/** 宽松 UUID 形态（zod v4 的 .uuid() 校验版本位，数据库自增/测试 id 会误伤） */
const UUID_SHAPE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RUN_TYPE_LABELS: Record<RunTypeValue, string> = {
  analysis: "AI 客户分析",
  call_prep: "AI 电话准备卡",
  interaction_summary: "AI 生成摘要",
};

export const RUN_TYPE_BADGE_CLASS: Record<RunTypeValue, string> = {
  analysis: "bg-violet-50 text-violet-700",
  call_prep: "bg-violet-50 text-violet-700",
  interaction_summary: "bg-violet-50 text-violet-700",
};

/** POST /api/ai/runs 与 retry 共用 */
// notes（T10）：仅 interaction_summary 接受——销售口述/粘贴的原始沟通内容，
// 随快照落 ai_runs.input_snapshot 留痕（可复现）；其余类型必须不带（防止误用）。
const rawNotesSchema = z
  .string()
  .trim()
  .min(1, "请先提供原始沟通内容（粘贴或输入到「客户实际反馈」后重试）")
  .max(5000, "原始沟通内容不能超过 5000 字");

export const aiRunCreateSchema = z
  .object({
    leadId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "客户标识不合法",
      ),
    runType: z.enum(RUN_TYPES, { message: "AI 任务类型不合法" }),
    notes: rawNotesSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.runType === "interaction_summary") {
      if (value.notes === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["notes"],
          message: "AI 生成摘要需提供原始沟通内容",
        });
      }
      return;
    }
    if (value.notes !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["notes"],
        message: "该 AI 任务类型不接受原始沟通内容",
      });
    }
  });

export type AiRunCreateInput = z.infer<typeof aiRunCreateSchema>;

// ---------- 模型配置（/api/settings/model-configs，仅管理员） ----------
// provider V1.0 只内置 OpenAI 兼容适配器，值仅作展示标签；换服务商改配置即切换（C05）。

const providerSchema = z.string().trim().min(1, "请输入服务商").max(64, "服务商名称过长");

const baseUrlSchema = z
  .string()
  .trim()
  .min(1, "请输入 Base URL")
  .max(255, "Base URL 过长")
  .regex(/^https?:\/\/\S+$/i, "Base URL 须为 http(s) URL（如 https://api.example.com/v1）");

const modelNameSchema = z.string().trim().min(1, "请输入模型名称").max(128, "模型名称过长");

const apiKeySchema = z
  .string()
  .trim()
  .min(8, "API 密钥至少 8 位")
  .max(256, "API 密钥过长");

const timeoutMsSchema = z.coerce
  .number()
  .int("超时须为整数毫秒")
  .min(1000, "超时不能小于 1 秒")
  .max(120000, "超时不能超过 120 秒");

const maxRetriesSchema = z.coerce
  .number()
  .int()
  .min(0, "重试次数不能为负")
  .max(3, "重试次数最多 3 次");

export const modelConfigCreateSchema = z.object({
  provider: providerSchema.default("openai_compatible"),
  baseUrl: baseUrlSchema,
  modelName: modelNameSchema,
  apiKey: apiKeySchema,
  timeoutMs: timeoutMsSchema.optional(),
  maxRetries: maxRetriesSchema.optional(),
  isActive: z.boolean().optional(),
});

/** 更新：apiKey 缺省表示不替换密钥（绝不回显，仅"已配置 + 尾号"） */
export const modelConfigUpdateSchema = z
  .object({
    provider: providerSchema.optional(),
    baseUrl: baseUrlSchema.optional(),
    modelName: modelNameSchema.optional(),
    apiKey: apiKeySchema.optional(),
    timeoutMs: timeoutMsSchema.optional(),
    maxRetries: maxRetriesSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((v) => v !== undefined),
    { message: "请至少提供一项要修改的内容" },
  );

/** 服务层入参用 input 形态（provider 带默认值，路由 parse 后与直调皆可） */
export type ModelConfigCreateInput = z.input<typeof modelConfigCreateSchema>;
export type ModelConfigUpdateInput = z.input<typeof modelConfigUpdateSchema>;

// ---------- 测试连接（T15，UIUX P9 AI 服务页：发起最小请求回显成败） ----------
// 两种形态二选一：configId（测试已保存配置，密钥服务端解密）；
// 或 baseUrl+modelName+apiKey（测试表单新值，密钥未落库）。

export const modelConnectionTestSchema = z
  .object({
    configId: z
      .string()
      .regex(UUID_SHAPE_RE, "配置标识不合法")
      .optional(),
    baseUrl: baseUrlSchema.optional(),
    modelName: modelNameSchema.optional(),
    apiKey: apiKeySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.configId !== undefined) {
      if (
        value.baseUrl !== undefined ||
        value.modelName !== undefined ||
        value.apiKey !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["configId"],
          message: "测试已保存配置时不能混传表单值",
        });
      }
      return;
    }
    if (value.baseUrl === undefined || value.modelName === undefined || value.apiKey === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["configId"],
        message: "请提供要测试的配置，或完整填写 Base URL / 模型名 / API 密钥",
      });
    }
  });

export type ModelConnectionTestInput = z.input<typeof modelConnectionTestSchema>;

// ---------- 运行状态展示（UIUX §4.7 RunStatusBadge / §7.3 错误文案映射） ----------

export const RUN_STATUSES = ["pending", "success", "failed", "timeout", "invalid_output"] as const;

export type RunStatusValue = (typeof RUN_STATUSES)[number];

export const RUN_STATUS_LABELS: Record<RunStatusValue, string> = {
  pending: "生成中",
  success: "已生成",
  failed: "失败",
  timeout: "超时",
  invalid_output: "格式异常",
};

export const RUN_STATUS_BADGE_CLASS: Record<RunStatusValue, string> = {
  pending: "bg-blue-50 text-blue-700",
  success: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  timeout: "bg-red-50 text-red-700",
  invalid_output: "bg-amber-50 text-amber-700",
};

/** error_type → 用户文案（UIUX §7.3；重试入口按状态判定） */
export const AI_ERROR_MESSAGES: Record<string, string> = {
  timeout: "AI 服务响应超时，请重试",
  auth: "AI 服务鉴权失败，请联系管理员检查模型配置",
  rate_limit: "AI 服务限流，请稍后重试",
  provider: "AI 服务暂时不可用，请稍后重试",
  invalid_output: "AI 输出格式异常，已记录，可重试",
};
