import { beforeEach, describe, expect, it } from "vitest";
import {
  callModel,
  ProviderError,
  setSleepImpl,
} from "@/server/ai/provider";

// T08 Provider Adapter（验收项：错误分类正确；网络类错误重试）。
// fetch 注入 mock：不依赖任何真实服务商。

const ENDPOINT = {
  baseUrl: "https://api.example.com/v1",
  modelName: "test-model",
  apiKey: "sk-secret-test-key",
  timeoutMs: 30000,
  maxRetries: 1,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okResponse(content: string): Response {
  return jsonResponse(200, {
    choices: [{ message: { role: "assistant", content } }],
  });
}

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, fetch: impl };
}

beforeEach(() => {
  // 重试间隔置零：单测不等待真实 500ms
  setSleepImpl(async () => {});
});

describe("OpenAI 兼容 Provider Adapter", () => {
  it("正常返回 choices[0].message.content，请求体含 model/messages/鉴权头", async () => {
    const { calls, fetch } = mockFetch(async () => okResponse("你好"));
    const result = await callModel(ENDPOINT, [
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ], fetch);
    expect(result.content).toBe("你好");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const first = calls[0];
    expect(first).toBeDefined();
    expect(first?.url).toBe("https://api.example.com/v1/chat/completions");
    expect((first?.init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-secret-test-key",
    );
    const body = JSON.parse(first?.init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages).toHaveLength(2);
  });

  it("HTTP 401 → auth，不重试", async () => {
    const { calls, fetch } = mockFetch(async () => jsonResponse(401, { error: "bad key" }));
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).type).toBe("auth");
    expect(calls).toHaveLength(1);
    // 错误信息不含密钥
    expect((error as Error).message).not.toContain("sk-secret-test-key");
  });

  it("HTTP 429 → rate_limit，不重试", async () => {
    const { calls, fetch } = mockFetch(async () => jsonResponse(429, { error: "quota" }));
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect((error as ProviderError).type).toBe("rate_limit");
    expect(calls).toHaveLength(1);
  });

  it("HTTP 500 → provider，可重试：首次失败第二次成功", async () => {
    let n = 0;
    const { calls, fetch } = mockFetch(async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse(500, { error: "boom" });
      }
      return okResponse("ok");
    });
    const result = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch);
    expect(result.content).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("网络错误 → provider：重试 1 次仍失败则抛出", async () => {
    const { calls, fetch } = mockFetch(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect((error as ProviderError).type).toBe("provider");
    expect(calls).toHaveLength(2); // 1 + maxRetries
  });

  it("AbortError → timeout：重试后仍超时则落 timeout", async () => {
    const { calls, fetch } = mockFetch(async () => {
      const abort = new Error("This operation was aborted");
      abort.name = "AbortError";
      throw abort;
    });
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect((error as ProviderError).type).toBe("timeout");
    expect(calls).toHaveLength(2);
  });

  it("maxRetries=0 时不重试", async () => {
    const { calls, fetch } = mockFetch(async () => jsonResponse(500, {}));
    await callModel(
      { ...ENDPOINT, maxRetries: 0 },
      [{ role: "user", content: "x" }],
      fetch,
    ).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("2xx 但响应体缺 choices → provider 错误", async () => {
    const { fetch } = mockFetch(async () => jsonResponse(200, { object: "chat.completion" }));
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect((error as ProviderError).type).toBe("provider");
  });

  it("auth/rate_limit 的错误信息不包含密钥明文", async () => {
    const { fetch } = mockFetch(async () => jsonResponse(403, { error: "forbidden" }));
    const error = await callModel(ENDPOINT, [{ role: "user", content: "x" }], fetch).catch(
      (e) => e,
    );
    expect((error as Error).message).not.toContain("sk-secret-test-key");
  });
});
