import { AiRun, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { AiRunCreateInput } from "@/lib/schemas/ai";
import { assertLeadReadable, assertLeadWritable } from "@/server/permissions";
import { buildAiInput, extractRawNotes, RAW_INTERACTION_NOTES_KEY } from "./context";
import { decryptApiKey } from "./crypto";
import { assertAiAllowedForLead } from "./guard";
import { getActiveEndpoint } from "./model-configs";
import { resolveActivePromptVersion } from "./prompt-registry";
import { callModel, ProviderError } from "./provider";
import { correctionInstruction, validateOutput } from "./validator";
import { countRunsToday, dailyAiLimit } from "./rate-limit";

// Run Logger + 执行编排（T08，实施计划 §7.1 Run Logger/§7.2 执行模型 / PRD §5.5、§6.8）：
// - 发起：权限（线索写范围）→ 常规组 guard（T14 接入，T09 恒通过）→ 每日频控 →
//   模型配置/提示词就绪 → 输入快照（白名单）→
//   落 ai_runs(pending) 后异步执行，接口立即返回（不阻塞详情页，PRD §8）；
// - 执行：调模型（网络类错误重试）→ 结构校验 → 失败带纠错指令自动重试 1 次 →
//   仍失败落 invalid_output（供重试入口）；任何终态都写回同一行（全量留痕）；
// - AI 输出只写 ai_runs.output，绝不触发任何业务表写操作（K3）；
// - 密钥解密只存在于单次调用的内存中，不落任何存储/日志（§8.3）。

const ERROR_MESSAGE_MAX = 500;

function truncateError(message: string): string {
  return message.length > ERROR_MESSAGE_MAX
    ? `${message.slice(0, ERROR_MESSAGE_MAX)}…`
    : message;
}

export interface CreateRunOptions {
  /** 测试注入：false 时不自动触发执行（由测试显式 await executeRun） */
  execute?: boolean;
  /** 测试注入 fetch 实现（透传给 Provider Adapter） */
  fetchImpl?: typeof fetch;
}

export interface ExecuteRunOptions {
  fetchImpl?: typeof fetch;
}

async function loadLeadForRun(leadId: string) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: { stage: true },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  return lead;
}

async function assertQuota(userId: string): Promise<void> {
  const used = await countRunsToday(userId);
  if (used >= dailyAiLimit()) {
    throw new ApiError(
      429,
      "ai_daily_limit",
      `今日 AI 调用已达上限（${dailyAiLimit()} 次），明日自动恢复；上限可在设置中调整`,
    );
  }
}

async function requireRunWithAccess(actor: AuthUser, runId: string) {
  const run = await prisma.aiRun.findUnique({
    where: { id: runId },
    include: {
      lead: { select: { ownerId: true, deletedAt: true } },
      // 面板展示用：模型名/服务商与提示词版本号（绝不带出密钥相关列，§8.3）
      modelConfig: { select: { provider: true, modelName: true } },
      promptVersion: { select: { version: true } },
    },
  });
  if (!run || run.lead.deletedAt) {
    throw new ApiError(404, "not_found", "AI 调用记录不存在");
  }
  assertLeadReadable(actor, run.lead.ownerId);
  return run;
}

/** 输入快照：按线索当前数据重建（重试场景同样取最新快照 + data_version）；
 * notes（T10，仅 interaction_summary）并入快照留痕，重试按原 notes 取回 */
async function snapshotForLead(
  leadId: string,
  notes?: string,
): Promise<{
  snapshot: Prisma.InputJsonValue;
  inputDataVersion: number;
}> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    include: { stage: true },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  const interactions = await prisma.interaction.findMany({
    where: { leadId: lead.id },
    orderBy: { occurredAt: "desc" },
    take: 5,
  });
  const snapshot = buildAiInput(lead, interactions);
  if (notes !== undefined) {
    snapshot[RAW_INTERACTION_NOTES_KEY] = {
      note: "销售口述/粘贴的原始沟通内容（未整理，仅供本次摘要任务使用）",
      content: notes,
    };
  }
  return {
    snapshot: snapshot as Prisma.InputJsonValue,
    inputDataVersion: lead.dataVersion,
  };
}

function userMessage(snapshot: unknown, correction?: string): string {
  const base =
    "【输入资料】\n" +
    JSON.stringify(snapshot, null, 2) +
    "\n\n请按系统提示词要求的 JSON 结构输出。";
  return correction ? `${base}\n\n${correctionInstruction(correction)}` : base;
}

function backgroundExecute(runId: string, options: CreateRunOptions): void {
  void executeRun(runId, { fetchImpl: options.fetchImpl }).catch((error) => {
    // 兜底：执行器内部已落终态，此处仅防未处理拒绝；不输出任何请求内容
    console.error(
      "[ai] run 执行异常：",
      runId,
      error instanceof Error ? error.message : error,
    );
  });
}

// ---------- 发起 run ----------

export async function createAiRun(
  actor: AuthUser,
  input: AiRunCreateInput,
  options: CreateRunOptions = {},
): Promise<AiRun> {
  const lead = await loadLeadForRun(input.leadId);
  assertLeadWritable(actor, lead.ownerId);
  // 常规组拦截（T14 实现）：在频控之前，拒绝不消耗每日额度、不落 run；
  // 拦截写审计日志（ai.control_group_blocked）
  await assertAiAllowedForLead(lead.id, actor);
  await assertQuota(actor.id);

  // 配置/提示词就绪才允许创建 run（fail fast，避免产生必然失败的 pending 行）；
  // 此处解密同时提前暴露主密钥配置错误（而非等到执行阶段）
  const endpoint = await getActiveEndpoint();
  const prompt = await resolveActivePromptVersion(input.runType);

  const { snapshot, inputDataVersion } = await snapshotForLead(lead.id, input.notes);

  const run = await prisma.aiRun.create({
    data: {
      leadId: lead.id,
      userId: actor.id,
      runType: input.runType,
      modelConfigId: endpoint.id,
      promptVersionId: prompt.versionId,
      inputSnapshot: snapshot,
      inputDataVersion,
      status: "pending",
    },
  });

  if (options.execute !== false) {
    backgroundExecute(run.id, options);
  }
  return run;
}

// ---------- 执行（Run Logger：终态写回同一行） ----------

type TerminalStatus = "success" | "failed" | "timeout" | "invalid_output";

type AiErrorTypeValue = "timeout" | "auth" | "rate_limit" | "provider" | "invalid_output";

export async function executeRun(
  runId: string,
  options: ExecuteRunOptions = {},
): Promise<AiRun> {
  const run = await prisma.aiRun.findUnique({
    where: { id: runId },
    include: { promptVersion: true, modelConfig: true },
  });
  if (!run) {
    throw new ApiError(404, "not_found", "AI 调用记录不存在");
  }
  if (run.status !== "pending") {
    throw new ApiError(409, "run_not_pending", "该 AI 调用已结束，不能重复执行");
  }

  const startedAt = Date.now();
  const finish = async (data: {
    status: TerminalStatus;
    errorType?: AiErrorTypeValue;
    errorMessage?: string;
    output?: Prisma.InputJsonValue;
  }): Promise<AiRun> =>
    prisma.aiRun.update({
      where: { id: run.id },
      data: {
        status: data.status,
        errorType: data.errorType ?? null,
        errorMessage: data.errorMessage ? truncateError(data.errorMessage) : null,
        output: data.output ?? Prisma.JsonNull,
        durationMs: Date.now() - startedAt,
      },
    });

  const endpoint = {
    baseUrl: run.modelConfig.baseUrl,
    modelName: run.modelConfig.modelName,
    apiKey: decryptApiKey(run.modelConfig.apiKeyCipher),
    timeoutMs: run.modelConfig.timeoutMs,
    maxRetries: run.modelConfig.maxRetries,
  };

  let content: string;
  try {
    content = (
      await callModel(endpoint, [
        { role: "system", content: run.promptVersion.content },
        { role: "user", content: userMessage(run.inputSnapshot) },
      ], options.fetchImpl)
    ).content;
  } catch (error) {
    if (error instanceof ProviderError) {
      return finish({
        status: error.type === "timeout" ? "timeout" : "failed",
        errorType: error.type,
        errorMessage: error.message,
      });
    }
    throw error;
  }

  let verdict = validateOutput(run.runType, content);
  if (!verdict.ok) {
    // 结构非法自动重试 1 次（纠错指令，R2）；仍失败落 invalid_output 供人工重试
    try {
      content = (
        await callModel(
          { ...endpoint, maxRetries: 0 },
          [
            { role: "system", content: run.promptVersion.content },
            { role: "user", content: userMessage(run.inputSnapshot, verdict.reason) },
          ],
          options.fetchImpl,
        )
      ).content;
    } catch (error) {
      if (error instanceof ProviderError) {
        return finish({
          status: error.type === "timeout" ? "timeout" : "failed",
          errorType: error.type,
          errorMessage: error.message,
        });
      }
      throw error;
    }
    verdict = validateOutput(run.runType, content);
  }

  if (!verdict.ok) {
    return finish({
      status: "invalid_output",
      errorType: "invalid_output",
      errorMessage: verdict.reason,
    });
  }
  return finish({
    status: "success",
    output: verdict.data as Prisma.InputJsonValue,
  });
}

// ---------- 重试 / 查询 ----------

const RETRYABLE_STATUSES = ["failed", "timeout", "invalid_output"] as const;

/** 重试 = 新 run（历史保留）：快照按当前数据重建，retry_of_id 串起因果链 */
export async function retryAiRun(
  actor: AuthUser,
  runId: string,
  options: CreateRunOptions = {},
): Promise<AiRun> {
  const previous = await requireRunWithAccess(actor, runId);
  if (!(RETRYABLE_STATUSES as readonly string[]).includes(previous.status)) {
    throw new ApiError(409, "run_not_retryable", "仅失败/超时/格式异常的 AI 调用可重试");
  }
  assertLeadWritable(actor, previous.lead.ownerId);
  // 重试同样过常规组 guard（T14 实现）：分组后固定（C04），失败重试也不例外
  await assertAiAllowedForLead(previous.leadId, actor);
  await assertQuota(actor.id);

  const endpoint = await getActiveEndpoint();
  const prompt = await resolveActivePromptVersion(previous.runType);
  // 摘要草稿重试（T10）：原始沟通内容取自上一 run 的快照留痕，
  // 其余数据（画像/最近沟通/data_version）按当前线索重建
  const notes =
    previous.runType === "interaction_summary"
      ? extractRawNotes(previous.inputSnapshot)
      : undefined;
  const { snapshot, inputDataVersion } = await snapshotForLead(previous.leadId, notes);

  const run = await prisma.aiRun.create({
    data: {
      leadId: previous.leadId,
      userId: actor.id,
      runType: previous.runType,
      modelConfigId: endpoint.id,
      promptVersionId: prompt.versionId,
      inputSnapshot: snapshot,
      inputDataVersion,
      status: "pending",
      retryOfId: previous.id,
    },
  });

  if (options.execute !== false) {
    backgroundExecute(run.id, options);
  }
  return run;
}

/** 轮询单条（GET /api/ai/runs/:id） */
export async function getAiRun(actor: AuthUser, runId: string): Promise<AiRun> {
  return requireRunWithAccess(actor, runId);
}

/** 历史列表（GET /api/leads/:id/ai-runs，倒序；含模型名/提示词版本号供面板展示） */
export async function listLeadAiRuns(
  actor: AuthUser,
  leadId: string,
): Promise<AiRun[]> {
  const lead = await loadLeadForRun(leadId);
  assertLeadReadable(actor, lead.ownerId);
  return prisma.aiRun.findMany({
    where: { leadId: lead.id },
    orderBy: { createdAt: "desc" },
    include: {
      modelConfig: { select: { provider: true, modelName: true } },
      promptVersion: { select: { version: true } },
    },
  });
}
