import { afterAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  registerTestModelConfig,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import { createModelConfig, updateModelConfig } from "@/server/ai/model-configs";
import {
  createAiRun,
  executeRun,
  getAiRun,
  listLeadAiRuns,
  retryAiRun,
} from "@/server/ai/runner";
import { createMyDataExport, getExportFile } from "@/server/services/exports";

// T08 执行链路验收（实施计划 §9 T08 / §7.1、§7.2 / PRD §6.6–§6.10）：
// - 错误分类正确：auth / rate_limit / provider / timeout 落 error_type，
//   网络类（timeout/provider）重试 max_retries 次，auth/rate_limit 不重试；
// - 结构非法自动重试 1 次（纠错指令），仍失败落 invalid_output 供人工重试；
// - 换 provider 仅改配置：切换激活配置后，新 run 记录新 model_config_id；
// - 每日频控：当日发起次数达到上限返回 429（发起即计数）；
// - 快照白名单：不含联系人电话；input_data_version = 线索 data_version；
// - 越权：非本人线索一律 404；重试 = 新 run（retry_of_id 留痕）。
// 模型交互经注入 fetchImpl 模拟，不依赖真实服务商。

afterAll(cleanupTestUsers);

const VALID_ANALYSIS = {
  fit: { level: "mid", reason: "行业匹配" },
  facts: [{ topic: "在用系统", detail: "Excel 台账", status: "confirmed" }],
  pains: [{ pain: "资料分散", evidence: "客户自述" }],
  angles: ["以资料整合切入"],
  next_action: "预约演示",
  verify_questions: ["客户数量级"],
};

function okResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function statusResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "mock" } }), { status });
}

function abortError(): never {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  throw error;
}

type MockSpec = (callIndex: number) => Response | never;

/** 计次 mock fetch：按调用序号返回预设响应 */
function mockFetch(spec: MockSpec): { calls: { count: number }; fetch: typeof fetch } {
  const calls = { count: 0 };
  const impl = (async () => {
    const index = calls.count;
    calls.count += 1;
    return spec(index);
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

function expectApiError(error: unknown, status: number, code?: string): void {
  expect(error).toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect(apiError.status).toBe(status);
  if (code) {
    expect(apiError.code).toBe(code);
  }
}

const SECRET_KEY = "sk-integration-secret-9876543210";

/** 每个用例独立用户 + 激活配置（互不影响频控计数） */
async function setupCase(): Promise<{
  sales: Awaited<ReturnType<typeof createTestUser>>;
  lead: Awaited<ReturnType<typeof createLead>>;
}> {
  const admin = await createTestUser("admin");
  const sales = await createTestUser("sales");
  const config = await createModelConfig(admin, {
    baseUrl: "https://api.mock-provider.local/v1",
    modelName: "mock-model",
    apiKey: SECRET_KEY,
    timeoutMs: 5000,
    maxRetries: 1,
    isActive: true,
  });
  registerTestModelConfig(config.id);
  const lead = await createLead(sales, {
    name: "AI 验证客户",
    contactName: "王经理",
    contactPhone: "13900001111",
    // V2.0-T02：current_system 字典已启用，取值须 ∈ 预置字典
    currentSystem: "手工台账（Excel/纸质）",
  });
  return { sales, lead };
}

describe("发起 run（快照与前置校验）", () => {
  it("创建 pending run：快照不含电话、data_version 正确、绑定配置与提示词版本", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );

    expect(run.status).toBe("pending");
    expect(run.inputDataVersion).toBe(lead.dataVersion);
    expect(run.modelConfigId).toBeTruthy();
    expect(run.promptVersionId).toBeTruthy();
    const serialized = JSON.stringify(run.inputSnapshot);
    expect(serialized).not.toContain("13900001111");
    expect(serialized).not.toContain("contact_phone");
    expect(serialized).toContain("手工台账（Excel/纸质）");
  });

  it("无启用配置时发起失败（409 ai_not_configured）", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const config = await createModelConfig(admin, {
      baseUrl: "https://api.mock-provider.local/v1",
      modelName: "m",
      apiKey: SECRET_KEY,
      isActive: true,
    });
    registerTestModelConfig(config.id);
    await updateModelConfig(admin, config.id, { isActive: false });
    const lead = await createLead(sales, { name: "无配置客户" });

    try {
      await createAiRun(sales, { leadId: lead.id, runType: "analysis" }, { execute: false });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "ai_not_configured");
    }
  });

  it("越权：销售 B 对 A 的线索发起/查询/历史 一律 404", async () => {
    const { sales, lead } = await setupCase();
    const stranger = await createTestUser("sales");
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );

    try {
      await createAiRun(stranger, { leadId: lead.id, runType: "analysis" }, { execute: false });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
    try {
      await getAiRun(stranger, run.id);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
    try {
      await listLeadAiRuns(stranger, lead.id);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
  });
});

describe("执行链路（错误分类 / 重试 / invalid_output）", () => {
  it("成功：输出经校验落库，run 置 success 且记录耗时", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch(() => okResponse(JSON.stringify(VALID_ANALYSIS)));

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(1);
    expect(finished.status).toBe("success");
    expect(finished.errorType).toBeNull();
    expect(finished.durationMs).toBeGreaterThanOrEqual(0);
    const output = finished.output as { fit: { level: string }; facts: unknown[] };
    expect(output.fit.level).toBe("mid");
    expect(output.facts).toHaveLength(1);
  });

  it("401 → failed/auth，不重试（调用 1 次），错误信息不含密钥", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch(() => statusResponse(401));

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(1);
    expect(finished.status).toBe("failed");
    expect(finished.errorType).toBe("auth");
    expect(finished.errorMessage).not.toContain(SECRET_KEY);
  });

  it("429 → failed/rate_limit，不重试", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch(() => statusResponse(429));

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(1);
    expect(finished.status).toBe("failed");
    expect(finished.errorType).toBe("rate_limit");
  });

  it("超时 → status=timeout（网络类，重试 1 次后仍超时）", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch(() => abortError());

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(2);
    expect(finished.status).toBe("timeout");
    expect(finished.errorType).toBe("timeout");
  });

  it("网络错误重试恢复：首失败次成功 → success", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch((index) => {
      if (index === 0) {
        throw new TypeError("fetch failed");
      }
      return okResponse(JSON.stringify(VALID_ANALYSIS));
    });

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(2);
    expect(finished.status).toBe("success");
  });

  it("结构非法：自动带纠错指令重试 1 次，仍非法 → invalid_output", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { calls, fetch } = mockFetch(() => okResponse("这不是 JSON"));
    const bodies: string[] = [];
    const spy = (async (url: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return (fetch as (u: string, i: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const finished = await executeRun(run.id, { fetchImpl: spy });
    expect(calls.count).toBe(2); // 自动重试恰 1 次
    expect(finished.status).toBe("invalid_output");
    expect(finished.errorType).toBe("invalid_output");
    expect(finished.output).toBeNull();
    // 第二次请求携带纠错指令
    expect(bodies[1]).toContain("不合规");
    // 快照与错误信息不含密钥
    expect(finished.errorMessage).not.toContain(SECRET_KEY);
    expect(JSON.stringify(finished.inputSnapshot)).not.toContain(SECRET_KEY);
  });

  it("首答非法、重试合法 → success（自动纠错恢复路径）", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "call_prep" },
      { execute: false },
    );
    const validCallPrep = {
      goal: "确认需求",
      opening: "您好",
      diag_questions: ["q1", "q2", "q3"],
      objections: [{ objection: "a", response: "b" }, { objection: "c", response: "d" }],
      confirm_next: "约演示",
      avoid: [],
    };
    const { calls, fetch } = mockFetch((index) =>
      index === 0
        ? okResponse("前半段 { broken")
        : okResponse(JSON.stringify(validCallPrep)),
    );

    const finished = await executeRun(run.id, { fetchImpl: fetch });
    expect(calls.count).toBe(2);
    expect(finished.status).toBe("success");
    const output = finished.output as { diag_questions: string[] };
    expect(output.diag_questions).toHaveLength(3);
  });

  it("已终态的 run 不能重复执行（409）", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { fetch } = mockFetch(() => okResponse(JSON.stringify(VALID_ANALYSIS)));
    await executeRun(run.id, { fetchImpl: fetch });

    try {
      await executeRun(run.id, { fetchImpl: fetch });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "run_not_pending");
    }
  });
});

describe("重试 / 历史 / 换配置 / 频控", () => {
  it("重试失败 run = 新 run（retry_of_id 留痕，历史 2 条）", async () => {
    const { sales, lead } = await setupCase();
    const failed = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    const { fetch } = mockFetch(() => statusResponse(500));
    await executeRun(failed.id, { fetchImpl: fetch });

    const retried = await retryAiRun(
      sales,
      failed.id,
      { execute: false },
    );
    expect(retried.id).not.toBe(failed.id);
    expect(retried.retryOfId).toBe(failed.id);
    expect(retried.status).toBe("pending");

    const history = await listLeadAiRuns(sales, lead.id);
    expect(history).toHaveLength(2);

    // 成功 run 不可重试
    const okRun = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    await executeRun(okRun.id, {
      fetchImpl: mockFetch(() => okResponse(JSON.stringify(VALID_ANALYSIS))).fetch,
    });
    try {
      await retryAiRun(sales, okRun.id, { execute: false });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 409, "run_not_retryable");
    }
  });

  it("换 provider 仅改配置：切换激活配置后，新 run 绑定新配置", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const configA = await createModelConfig(admin, {
      baseUrl: "https://api.a.local/v1",
      modelName: "model-a",
      apiKey: SECRET_KEY,
      isActive: true,
    });
    registerTestModelConfig(configA.id);
    const configB = await createModelConfig(admin, {
      baseUrl: "https://api.b.local/v1",
      modelName: "model-b",
      apiKey: SECRET_KEY,
    });
    registerTestModelConfig(configB.id);
    const lead = await createLead(sales, { name: "切换配置客户" });

    const run1 = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    expect(run1.modelConfigId).toBe(configA.id);

    await updateModelConfig(admin, configB.id, { isActive: true });
    const run2 = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    expect(run2.modelConfigId).toBe(configB.id);
  });

  it("每日频控：达到上限后发起返回 429（发起即计数）", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const config = await createModelConfig(admin, {
      baseUrl: "https://api.mock-provider.local/v1",
      modelName: "mock-model",
      apiKey: SECRET_KEY,
      isActive: true,
    });
    registerTestModelConfig(config.id);
    const lead = await createLead(sales, { name: "频控客户" });

    const previous = process.env.AI_DAILY_LIMIT;
    process.env.AI_DAILY_LIMIT = "2";
    try {
      await createAiRun(sales, { leadId: lead.id, runType: "analysis" }, { execute: false });
      await createAiRun(sales, { leadId: lead.id, runType: "call_prep" }, { execute: false });
      try {
        await createAiRun(sales, { leadId: lead.id, runType: "analysis" }, { execute: false });
        throw new Error("should fail");
      } catch (error) {
        expectApiError(error, 429, "ai_daily_limit");
      }
      // 其他用户不受影响
      const other = await createTestUser("sales");
      const otherLead = await createLead(other, { name: "频控隔离客户" });
      const run = await createAiRun(
        other,
        { leadId: otherLead.id, runType: "analysis" },
        { execute: false },
      );
      expect(run.status).toBe("pending");
    } finally {
      if (previous === undefined) {
        delete process.env.AI_DAILY_LIMIT;
      } else {
        process.env.AI_DAILY_LIMIT = previous;
      }
    }
  });

  it("个人全量导出并入 AI记录.csv（状态元数据，无快照/密钥）", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    await executeRun(run.id, {
      fetchImpl: mockFetch(() => okResponse(JSON.stringify(VALID_ANALYSIS))).fetch,
    });

    const created = await createMyDataExport(sales);
    const file = await getExportFile(sales, created.id);
    const zip = await JSZip.loadAsync(Buffer.from(file.bytes));
    const csvFile = zip.file("AI记录.csv");
    expect(csvFile).not.toBeNull();
    const text = (await csvFile!.async("string")).replace(/^\uFEFF/, "");
    expect(text).toContain("AI 客户分析");
    expect(text).toContain("已生成");
    expect(text).toContain("mock-model");
    // 只含状态元数据：密钥与输入快照/输出全文不进导出
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("inputSnapshot");
  });

  it("软删除线索不可发起/查询（404）", async () => {
    const { sales, lead } = await setupCase();
    const run = await createAiRun(
      sales,
      { leadId: lead.id, runType: "analysis" },
      { execute: false },
    );
    await prisma.lead.update({
      where: { id: lead.id },
      data: { deletedAt: new Date() },
    });
    try {
      await createAiRun(sales, { leadId: lead.id, runType: "analysis" }, { execute: false });
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
    try {
      await getAiRun(sales, run.id);
      throw new Error("should fail");
    } catch (error) {
      expectApiError(error, 404);
    }
  });
});
