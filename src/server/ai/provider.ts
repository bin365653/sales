// Provider Adapter（T08，实施计划 §7.1 / §6.7、§6.8 / C05）：
// OpenAI 兼容 /chat/completions，单实现适配多服务商——换 provider 仅改模型配置。
// 错误五分类（timeout/auth/rate_limit/provider/invalid_output）：
//   - timeout：请求超过模型配置的 timeout_ms（AbortSignal）；
//   - auth：HTTP 401/403；
//   - rate_limit：HTTP 429；
//   - provider：其余 HTTP 错误与网络层错误（连接失败/DNS 等）；
//   - invalid_output：响应 2xx 但模型输出无法解析——由 Output Validator 判定，不在本层。
// 网络类错误（timeout/provider）按配置 max_retries 重试（默认 1 次）；auth/rate_limit 不重试。
// 密钥只进 Authorization 头：错误信息只含状态码与响应摘要，绝不含密钥。

export type AiErrorType =
  | "timeout"
  | "auth"
  | "rate_limit"
  | "provider"
  | "invalid_output";

export class ProviderError extends Error {
  constructor(
    readonly type: AiErrorType,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ModelEndpoint {
  baseUrl: string;
  modelName: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface ModelCallResult {
  content: string;
  /** 全部尝试（含重试）累计耗时 */
  durationMs: number;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const RETRY_DELAY_MS = 500;

/** 默认休眠（单测注入时钟可覆盖；导出仅为测试可见性） */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let sleep: (ms: number) => Promise<void> = defaultSleep;

/** 测试注入：加速重试间隔 */
export function setSleepImpl(impl: (ms: number) => Promise<void>): void {
  sleep = impl;
}

function endpointUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** 响应体摘要（用于错误排查）：截断且不落 Authorization 之外的任何头 */
async function responseSnippet(response: Response): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  const compact = body.replace(/\s+/g, " ").slice(0, 200);
  return `HTTP ${response.status}: ${compact || "(空响应体)"}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof Error && error.name === "TimeoutError")
  );
}

async function callOnce(
  endpoint: ModelEndpoint,
  messages: Array<{ role: string; content: string }>,
  fetchImpl: FetchLike,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(endpointUrl(endpoint.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: endpoint.modelName,
        messages,
        // 温度/采样参数不发送：兼容层差异大，提示词已强约束结构化输出
      }),
      signal: AbortSignal.timeout(endpoint.timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new ProviderError(
        "timeout",
        `模型请求超过 ${endpoint.timeoutMs}ms 未响应`,
      );
    }
    throw new ProviderError(
      "provider",
      `网络错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ProviderError(
        "auth",
        `模型服务鉴权失败（${await responseSnippet(response)}）`,
      );
    }
    if (response.status === 429) {
      throw new ProviderError("rate_limit", `模型服务限流（${await responseSnippet(response)}）`);
    }
    throw new ProviderError("provider", `模型服务错误（${await responseSnippet(response)}）`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError("provider", "模型服务响应不是合法 JSON");
  }
  const content = extractContent(payload);
  if (content === null) {
    throw new ProviderError("provider", "模型服务响应缺少 choices[0].message.content");
  }
  return content;
}

function extractContent(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  const message = (choices[0] as { message?: unknown })?.message;
  const content = (message as { content?: unknown })?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/**
 * 调用模型（含网络类错误重试）。
 * fetchImpl 可注入：测试用 mock 验证错误分类/重试；生产用全局 fetch。
 */
export async function callModel(
  endpoint: ModelEndpoint,
  messages: Array<{ role: "system" | "user"; content: string }>,
  fetchImpl: FetchLike = fetch,
): Promise<ModelCallResult> {
  const startedAt = Date.now();
  const maxAttempts = 1 + Math.max(0, endpoint.maxRetries);
  let lastError: ProviderError = new ProviderError("provider", "模型调用未执行");

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const content = await callOnce(endpoint, messages, fetchImpl);
      return { content, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      lastError = error;
      if (error.type !== "timeout" && error.type !== "provider") {
        // auth / rate_limit 不重试
        throw error;
      }
      if (attempt < maxAttempts) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}
