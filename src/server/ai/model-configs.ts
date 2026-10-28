import { ModelConfig } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import {
  ModelConfigCreateInput,
  ModelConfigUpdateInput,
  ModelConnectionTestInput,
} from "@/lib/schemas/ai";
import { assertAdmin } from "@/server/permissions";
import { writeAudit } from "@/server/auth/audit";
import { decryptApiKey, encryptApiKey, apiKeyLast4 } from "./crypto";
import { callModel, ProviderError } from "./provider";

// 模型配置服务（T08，实施计划 §4.2 model_configs / §8.3 / C05）：
// - 密钥仅在创建/更新时提交一次：AES-256-GCM 加密落库，任何接口只返回
//   key_last4 与 hasKey，绝不回显明文/密文（验收项：密钥不回显不入日志）；
// - 多条配置 + 单条激活：切换 isActive 即"换 provider 仅改配置"（C05）；
// - 写操作仅管理员（§8.2：配置权与客户查看权分离）；关键操作记审计（不含密钥）。

/** 对外返回形状：不含 apiKeyCipher 列，杜绝密文外泄 */
export type ModelConfigView = Omit<ModelConfig, "apiKeyCipher"> & { hasKey: true };

function toView(config: ModelConfig): ModelConfigView {
  return {
    id: config.id,
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    keyLast4: config.keyLast4,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    isActive: config.isActive,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    hasKey: true,
  };
}

export async function listModelConfigs(actor: AuthUser): Promise<ModelConfigView[]> {
  assertAdmin(actor);
  const configs = await prisma.modelConfig.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
  });
  return configs.map(toView);
}

export async function createModelConfig(
  actor: AuthUser,
  input: ModelConfigCreateInput,
): Promise<ModelConfigView> {
  assertAdmin(actor);
  const cipher = encryptApiKey(input.apiKey);
  const created = await prisma.$transaction(async (tx) => {
    if (input.isActive) {
      await tx.modelConfig.updateMany({ data: { isActive: false } });
    }
    return tx.modelConfig.create({
      data: {
        provider: input.provider ?? "openai_compatible",
        baseUrl: input.baseUrl,
        modelName: input.modelName,
        apiKeyCipher: cipher,
        keyLast4: apiKeyLast4(input.apiKey),
        // z.coerce 的入参形态是 unknown：显式判空再转 number
        timeoutMs: input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs),
        maxRetries: input.maxRetries === undefined ? 1 : Number(input.maxRetries),
        isActive: input.isActive ?? false,
      },
    });
  });
  await writeAudit({
    userId: actor.id,
    action: "ai.model_config_created",
    objectType: "model_config",
    objectId: created.id,
    detail: {
      provider: created.provider,
      base_url: created.baseUrl,
      model_name: created.modelName,
      key_last4: created.keyLast4,
      is_active: created.isActive,
    },
  });
  return toView(created);
}

export async function updateModelConfig(
  actor: AuthUser,
  id: string,
  input: ModelConfigUpdateInput,
): Promise<ModelConfigView> {
  assertAdmin(actor);
  const existing = await prisma.modelConfig.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError(404, "not_found", "模型配置不存在");
  }
  // 密钥替换：重新加密（其余字段照常更新）；不提供"删除密钥"——要停用就停用整条配置
  const newKey = input.apiKey;

  const updated = await prisma.$transaction(async (tx) => {
    if (input.isActive) {
      await tx.modelConfig.updateMany({
        where: { id: { not: id } },
        data: { isActive: false },
      });
    }
    return tx.modelConfig.update({
      where: { id },
      data: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
        ...(newKey !== undefined
          ? { apiKeyCipher: encryptApiKey(newKey), keyLast4: apiKeyLast4(newKey) }
          : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: Number(input.timeoutMs) } : {}),
        ...(input.maxRetries !== undefined ? { maxRetries: Number(input.maxRetries) } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  });

  await writeAudit({
    userId: actor.id,
    action: "ai.model_config_updated",
    objectType: "model_config",
    objectId: id,
    detail: {
      provider: updated.provider,
      base_url: updated.baseUrl,
      model_name: updated.modelName,
      timeout_ms: updated.timeoutMs,
      max_retries: updated.maxRetries,
      is_active: updated.isActive,
      key_replaced: input.apiKey !== undefined,
      ...(updated.keyLast4 !== existing.keyLast4
        ? { key_last4: `${existing.keyLast4}→${updated.keyLast4}` }
        : {}),
    },
  });
  return toView(updated);
}

export interface DecryptedEndpointConfig {
  id: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

/** 取当前启用配置并解密密钥（仅供执行器调用模型；明文不落任何存储/日志） */
export async function getActiveEndpoint(): Promise<DecryptedEndpointConfig> {
  const config = await prisma.modelConfig.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!config) {
    throw new ApiError(
      409,
      "ai_not_configured",
      "尚未配置 AI 模型服务，请联系管理员在设置中完成配置",
    );
  }
  return {
    id: config.id,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKey: decryptApiKey(config.apiKeyCipher),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  };
}

// ---------- 测试连接（T15，UIUX P9 AI 服务页：[测试连接] 回显成功/失败原因） ----------

export interface ConnectionTestResult {
  ok: boolean;
  durationMs: number;
  errorType?: string;
  /** 用户可读的失败原因（五分类文案映射；不含密钥/Authorization） */
  message?: string;
}

/** 测试请求上限 15s、不重试：配置页需要快速反馈 */
const TEST_TIMEOUT_MS = 15000;

/**
 * 发起最小请求验证连通性（OpenAI 兼容 chat/completions）：
 * - configId 形态：测试已保存配置（密钥服务端解密，绝不出现在响应）；
 * - 表单形态：测试未落库的新值（baseUrl/modelName/apiKey）。
 * 测试不写审计（非配置变更），不改任何数据。
 */
export async function testModelConnection(
  actor: AuthUser,
  input: ModelConnectionTestInput,
): Promise<ConnectionTestResult> {
  assertAdmin(actor);
  let target: { baseUrl: string; modelName: string; apiKey: string };
  if (input.configId !== undefined) {
    const config = await prisma.modelConfig.findUnique({
      where: { id: input.configId },
    });
    if (!config) {
      throw new ApiError(404, "not_found", "模型配置不存在");
    }
    target = {
      baseUrl: config.baseUrl,
      modelName: config.modelName,
      apiKey: decryptApiKey(config.apiKeyCipher),
    };
  } else {
    if (
      input.baseUrl === undefined ||
      input.modelName === undefined ||
      input.apiKey === undefined
    ) {
      throw new ApiError(
        400,
        "validation_error",
        "请提供要测试的配置，或完整填写 Base URL / 模型名 / API 密钥",
      );
    }
    target = {
      baseUrl: input.baseUrl,
      modelName: input.modelName,
      apiKey: input.apiKey,
    };
  }

  const startedAt = Date.now();
  try {
    await callModel(
      {
        baseUrl: target.baseUrl,
        modelName: target.modelName,
        apiKey: target.apiKey,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRetries: 0,
      },
      [{ role: "user", content: "连接测试，请回复 OK" }],
    );
    return { ok: true, durationMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        ok: false,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: AI_ERROR_MESSAGES_FOR_TEST[error.type] ?? error.message,
      };
    }
    throw error;
  }
}

/** 测试连接的失败原因映射（复用 §7.3 文案；比 run 执行少 invalid_output——本层不会产生） */
const AI_ERROR_MESSAGES_FOR_TEST: Record<string, string> = {
  timeout: "连接超时：模型服务未在 15 秒内响应",
  auth: "鉴权失败：请检查 API 密钥",
  rate_limit: "模型服务限流：密钥有效但请求被限流",
  provider: "无法连接模型服务：请检查 Base URL 与服务商状态",
};
