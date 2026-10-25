import { z } from "zod";

// Output Validator（T08，实施计划 §7.1 / §6.6、§6.10 / R2）：
// 模型输出必须经后端校验（PRD §6.10），结构对齐 PRD §5.4（分析 8 项）/ §5.5（准备卡 6 项）。
// 宽容解析：模型常以 ```json 围栏包裹输出，提取首个 { 到最后一个 } 再解析。
// 解析/校验失败 → runner 以纠错指令自动重试 1 次 → 仍失败落库 invalid_output。

// ---------- analysis（PRD §5.4 八项；UIUX §4.7 按分区渲染） ----------
// 匹配度徽章（高/中/低/信息不足）；facts 以 status 区分"已知事实"(confirmed)与
// "待核实信息"(unverified)；pains 每项含推断依据（事实/推断视觉区分由前端渲染）。

export const analysisSchema = z.object({
  fit: z.object({
    level: z.enum(["high", "mid", "low", "insufficient"], {
      message: "匹配度 level 须为 high/mid/low/insufficient",
    }),
    reason: z.string().max(2000),
  }),
  facts: z
    .array(
      z.object({
        topic: z.string().min(1).max(128),
        detail: z.string().max(2000),
        status: z.enum(["confirmed", "unverified"]),
      }),
    )
    .max(20),
  pains: z
    .array(
      z.object({
        pain: z.string().min(1).max(500),
        evidence: z.string().max(2000),
      }),
    )
    .max(3, "经营痛点最多 3 项"),
  angles: z.array(z.string().min(1).max(500)).max(5),
  next_action: z.string().min(1).max(1000),
  verify_questions: z.array(z.string().min(1).max(500)).max(10),
});

export type AnalysisOutput = z.infer<typeof analysisSchema>;

// ---------- call_prep（PRD §5.5 六项；末项红色警示块渲染） ----------

export const callPrepSchema = z.object({
  goal: z.string().min(1).max(1000),
  opening: z.string().min(1).max(2000),
  diag_questions: z
    .array(z.string().min(1).max(500))
    .length(3, "需求诊断问题必须 3 条"),
  objections: z
    .array(
      z.object({
        objection: z.string().min(1).max(500),
        response: z.string().min(1).max(1000),
      }),
    )
    .length(2, "异议应对必须 2 条"),
  confirm_next: z.string().min(1).max(1000),
  avoid: z.array(z.string().min(1).max(500)).max(5),
});

export type CallPrepOutput = z.infer<typeof callPrepSchema>;

// ---------- interaction_summary（T10 摘要草稿回填：反馈 + 下一步） ----------
// next_action 上限对齐目标列 leads 侧沟通表单的落库约束（interactions.next_action
// VARCHAR(255)），超限视为 invalid_output 走纠错重试，避免回填后保存被表单校验拒绝。

export const interactionSummarySchema = z.object({
  summary: z.string().min(1).max(2000),
  next_action: z.string().min(1).max(255),
});

export type InteractionSummaryOutput = z.infer<typeof interactionSummarySchema>;

export type ValidatedOutput = AnalysisOutput | CallPrepOutput | InteractionSummaryOutput;

export type OutputParseResult =
  | { ok: true; data: ValidatedOutput }
  | { ok: false; reason: string };

/** 从模型原始输出提取 JSON 对象文本（去除围栏/前后噪声） */
export function extractJsonObject(raw: string): string | null {
  const withoutFence = raw.replace(/```(?:json)?/gi, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return withoutFence.slice(start, end + 1);
}

function schemaFor(runType: string): z.ZodType<ValidatedOutput> | null {
  switch (runType) {
    case "analysis":
      return analysisSchema;
    case "call_prep":
      return callPrepSchema;
    case "interaction_summary":
      return interactionSummarySchema;
    default:
      return null;
  }
}

/** 校验模型输出：失败返回 reason（用于纠错重试指令与 error_message） */
export function validateOutput(runType: string, raw: string): OutputParseResult {
  const schema = schemaFor(runType);
  if (!schema) {
    return { ok: false, reason: `未知的 AI 任务类型：${runType}` };
  }
  const jsonText = extractJsonObject(raw);
  if (jsonText === null) {
    return { ok: false, reason: "输出中未找到 JSON 对象" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: "输出不是合法 JSON" };
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const issue = result.error.issues[0];
  const path = issue?.path?.join(".") ?? "";
  return {
    ok: false,
    reason: `输出结构不合规：${path ? `${path}: ` : ""}${issue?.message ?? "未知错误"}`,
  };
}

/** 纠错重试的追加指令（仍失败则落 invalid_output，供人工重试入口） */
export function correctionInstruction(reason: string): string {
  return [
    `你上一次的输出不合规：${reason}`,
    "请重新输出，且必须只输出一个符合上述字段要求的 JSON 对象，",
    "不要包含任何解释、Markdown 围栏或 JSON 之外的文本。",
  ].join("");
}
