import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  registerTestModelConfig,
} from "./helpers";
import {
  createModelConfig,
  listModelConfigs,
  updateModelConfig,
} from "@/server/ai/model-configs";

// T08 模型配置验收（实施计划 §8.3 / §9 T08）：
// - 密钥不回显：创建/列表/更新响应只含 key_last4 与 hasKey，无明文无密文；
// - 换 provider 仅改配置：多配置 + 单激活互斥；
// - 写操作仅管理员（配置权与客户查看权分离）；
// - 关键操作（密钥/配置）记审计且不含密钥材料。

afterAll(cleanupTestUsers);

function expectApiError(error: unknown, status: number, code?: string): void {
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.status).toBe(status);
  if (code) {
    expect(apiError.code).toBe(code);
  }
}

const BASE = {
  baseUrl: "https://api.provider-a.com/v1",
  modelName: "model-a",
  apiKey: "sk-aaaa-1111222233334444",
};

describe("模型配置（密钥不回显 + 单激活 + 权限）", () => {
  it("创建成功：密文落库，视图只含尾号", async () => {
    const admin = await createTestUser("admin");
    const config = await createModelConfig(admin, { ...BASE, isActive: true });
    registerTestModelConfig(config.id);

    expect(config.isActive).toBe(true);
    expect(config.hasKey).toBe(true);
    expect(config.keyLast4).toBe("4444");
    // 视图不含任何密钥形态
    expect(JSON.stringify(config)).not.toContain("sk-aaaa");
    expect(config).not.toHaveProperty("apiKey");
    expect(config).not.toHaveProperty("apiKeyCipher");
    // 库里只存密文
    const row = await prisma.modelConfig.findUnique({ where: { id: config.id } });
    expect(row?.apiKeyCipher).toMatch(/^v1:/);
    expect(row?.apiKeyCipher).not.toContain("sk-aaaa");
  });

  it("列表不回显密钥（明文/密文均不出现）", async () => {
    const admin = await createTestUser("admin");
    const created = await createModelConfig(admin, BASE);
    registerTestModelConfig(created.id);

    const configs = await listModelConfigs(admin);
    const found = configs.find((item) => item.id === created.id);
    expect(found).toBeDefined();
    expect(found?.keyLast4).toBe("4444");
    expect(JSON.stringify(configs)).not.toContain("sk-aaaa");
    expect(JSON.stringify(configs)).not.toContain("apiKeyCipher");
  });

  it("销售无配置权限（403）", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const created = await createModelConfig(admin, BASE);
    registerTestModelConfig(created.id);

    try {
      await listModelConfigs(sales);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 403);
    }
    try {
      await createModelConfig(sales, BASE);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 403);
    }
  });

  it("替换密钥：重新加密、尾号更新、旧密文失效", async () => {
    const admin = await createTestUser("admin");
    const created = await createModelConfig(admin, BASE);
    registerTestModelConfig(created.id);
    const before = await prisma.modelConfig.findUnique({ where: { id: created.id } });

    const updated = await updateModelConfig(admin, created.id, {
      apiKey: "sk-bbbb-9999888877776666",
    });
    expect(updated.keyLast4).toBe("6666");
    expect(JSON.stringify(updated)).not.toContain("sk-bbbb");

    const after = await prisma.modelConfig.findUnique({ where: { id: created.id } });
    expect(after?.apiKeyCipher).not.toBe(before?.apiKeyCipher);
    expect(after?.apiKeyCipher).not.toContain("sk-bbbb");
    expect(after?.apiKeyCipher).not.toContain("sk-aaaa");
  });

  it("激活互斥：激活 B 时 A 自动停用（换 provider 仅改配置）", async () => {
    const admin = await createTestUser("admin");
    const configA = await createModelConfig(admin, {
      ...BASE,
      baseUrl: "https://api.a.com/v1",
    });
    const configB = await createModelConfig(admin, {
      baseUrl: "https://api.b.com/v1",
      modelName: "model-b",
      apiKey: "sk-bbbb-1234",
    });
    registerTestModelConfig(configA.id);
    registerTestModelConfig(configB.id);
    await updateModelConfig(admin, configA.id, { isActive: true });

    await updateModelConfig(admin, configB.id, { isActive: true });
    const after = await prisma.modelConfig.findMany({
      where: { id: { in: [configA.id, configB.id] } },
      select: { id: true, isActive: true },
    });
    expect(after.find((item) => item.id === configA.id)?.isActive).toBe(false);
    expect(after.find((item) => item.id === configB.id)?.isActive).toBe(true);
  });

  it("不存在的配置：404", async () => {
    const admin = await createTestUser("admin");
    try {
      await updateModelConfig(admin, "22222222-2222-2222-2222-222222222222", {
        modelName: "x",
      });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
  });

  it("审计落痕且不含密钥材料", async () => {
    const admin = await createTestUser("admin");
    const created = await createModelConfig(admin, {
      ...BASE,
      apiKey: "sk-audit-0000",
    });
    registerTestModelConfig(created.id);
    await updateModelConfig(admin, created.id, { modelName: "model-a2" });

    const logs = await prisma.auditLog.findMany({
      where: { action: { in: ["ai.model_config_created", "ai.model_config_updated"] } },
      orderBy: { createdAt: "asc" },
    });
    const relevant = logs.filter(
      (log) =>
        log.objectId === created.id &&
        (log.detail as { key_last4?: string } | null)?.key_last4 !== undefined,
    );
    expect(relevant.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("sk-audit");
    // 尾号允许出现（§8.3：仅"已配置 + key_last4"可见）
    expect(serialized).toContain("0000");
  });
});
