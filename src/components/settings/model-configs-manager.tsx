"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

// AI 服务（T15，UIUX P9）：模型配置管理。
// 密钥只写不读（T08 契约）：已配置仅显示"已配置（尾号 xxxx）"，替换须输入新密钥，
// 绝不回显明文；多条配置单条激活（C05）；[测试连接] 发起最小请求回显成功/失败原因
// （新建表单测表单值、已保存配置测服务端解密后的配置）。

export interface ModelConfigItem {
  id: string;
  provider: string;
  baseUrl: string;
  modelName: string;
  keyLast4: string;
  timeoutMs: number;
  maxRetries: number;
  isActive: boolean;
}

const INPUT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

type TestOutcome = { ok: true; durationMs: number } | { ok: false; message: string };

interface TestResponse {
  ok?: boolean;
  durationMs?: number;
  message?: string;
  error?: { message?: string };
}

async function parseTestResponse(response: Response): Promise<TestOutcome> {
  const payload = (await response.json().catch(() => null)) as TestResponse | null;
  if (!response.ok) {
    return { ok: false, message: payload?.error?.message ?? "测试请求失败" };
  }
  if (payload?.ok) {
    return { ok: true, durationMs: payload.durationMs ?? 0 };
  }
  return { ok: false, message: payload?.message ?? "连接失败" };
}

export function ModelConfigsManager({ configs }: { configs: ModelConfigItem[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(configs.length === 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/settings/model-configs");
    if (!response.ok) {
      return;
    }
    router.refresh();
  }, [router]);

  async function activate(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    const response = await fetch(`/api/settings/model-configs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (!response.ok) {
      setError(payload?.error?.message ?? "启用失败，请稍后再试");
      return;
    }
    setNotice("已启用该配置；后续 AI 调用将使用它。");
    await refresh();
  }

  async function testSavedConfig(id: string): Promise<void> {
    setError(null);
    setNotice(null);
    const response = await fetch("/api/settings/model-configs/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configId: id }),
    });
    const outcome = await parseTestResponse(response);
    if (outcome.ok) {
      setNotice(`连接成功（耗时 ${outcome.durationMs}ms）`);
    } else {
      setError(`连接失败：${outcome.message}`);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          多条配置可并存，同一时刻仅一条启用（换服务商只改配置，不改代码）；
          API 密钥只在保存时提交一次，之后仅显示尾号。
        </p>
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {creating ? "收起新建表单" : "＋ 新建配置"}
        </button>
      </div>

      {creating && (
        <CreateConfigForm
          onDone={async (message) => {
            setCreating(false);
            setNotice(message);
            await refresh();
          }}
        />
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {configs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
          尚未配置模型服务。新建一条配置并启用后，AI 功能方可使用。
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {configs.map((config) => (
            <li
              key={config.id}
              className={`rounded-lg border bg-white p-4 ${
                config.isActive ? "border-blue-300 ring-1 ring-blue-100" : "border-gray-200"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-gray-900">{config.modelName}</span>
                    {config.isActive ? (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700">
                        当前启用
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                        未启用
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {config.provider} · {config.baseUrl} · 密钥已配置（尾号 {config.keyLast4}）·
                    超时 {Math.round(config.timeoutMs / 1000)}s · 重试 {config.maxRetries} 次
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void testSavedConfig(config.id)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
                  >
                    测试连接
                  </button>
                  {!config.isActive && (
                    <button
                      type="button"
                      onClick={() => void activate(config.id)}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
                    >
                      设为启用
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditingId(editingId === config.id ? null : config.id)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
                  >
                    {editingId === config.id ? "收起编辑" : "编辑"}
                  </button>
                </div>
              </div>
              {editingId === config.id && (
                <EditConfigForm
                  config={config}
                  onDone={async (message) => {
                    setEditingId(null);
                    setNotice(message);
                    await refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FormFields(props: {
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  modelName: string;
  onModelNameChange: (value: string) => void;
  timeoutMs: number;
  onTimeoutMsChange: (value: number) => void;
  maxRetries: number;
  onMaxRetriesChange: (value: number) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-sm sm:col-span-2">
        <span className="text-gray-600">Base URL *</span>
        <input
          value={props.baseUrl}
          onChange={(event) => props.onBaseUrlChange(event.target.value)}
          required
          placeholder="https://api.example.com/v1"
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-600">模型名称 *</span>
        <input
          value={props.modelName}
          onChange={(event) => props.onModelNameChange(event.target.value)}
          required
          placeholder="如 glm-4.7"
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-600">超时（毫秒，1000–120000）</span>
        <input
          type="number"
          min={1000}
          max={120000}
          step={1000}
          value={props.timeoutMs}
          onChange={(event) => props.onTimeoutMsChange(Number(event.target.value))}
          className={INPUT_CLASS}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-600">重试次数（0–3）</span>
        <input
          type="number"
          min={0}
          max={3}
          value={props.maxRetries}
          onChange={(event) => props.onMaxRetriesChange(Number(event.target.value))}
          className={INPUT_CLASS}
        />
      </label>
    </>
  );
}

function CreateConfigForm({
  onDone,
}: {
  onDone: (message: string) => void | Promise<void>;
}) {
  const [provider, setProvider] = useState("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [maxRetries, setMaxRetries] = useState(1);
  const [isActive, setIsActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);

  function buildBody(): Record<string, unknown> {
    return {
      provider: provider.trim() || "openai_compatible",
      baseUrl: baseUrl.trim(),
      modelName: modelName.trim(),
      apiKey: apiKey.trim(),
      timeoutMs,
      maxRetries,
      isActive,
    };
  }

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/model-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return;
      }
      await onDone(
        isActive ? "配置已保存并启用；密钥已加密保存，不再显示。" : "配置已保存；密钥已加密保存，不再显示。",
      );
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function testForm(): Promise<void> {
    setTestResult(null);
    setError(null);
    try {
      const response = await fetch("/api/settings/model-configs/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          modelName: modelName.trim(),
          apiKey: apiKey.trim(),
        }),
      });
      setTestResult(await parseTestResponse(response));
    } catch {
      setTestResult({ ok: false, message: "网络异常，请稍后再试" });
    }
  }

  return (
    <form
      className="mt-3 rounded-lg border border-blue-100 bg-blue-50/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-semibold text-gray-900">新建模型配置</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">服务商</span>
          <input
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className={INPUT_CLASS}
            placeholder="openai_compatible"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">API 密钥 *（仅此一次提交，保存后不可查看）</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            required
            autoComplete="new-password"
            className={INPUT_CLASS}
          />
        </label>
        <FormFields
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          modelName={modelName}
          onModelNameChange={setModelName}
          timeoutMs={timeoutMs}
          onTimeoutMsChange={setTimeoutMs}
          maxRetries={maxRetries}
          onMaxRetriesChange={setMaxRetries}
        />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          <span className="text-gray-600">保存后立即启用（同一时刻仅一条配置启用）</span>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {testResult && (
        <p
          className={`mt-2 rounded-md px-3 py-2 text-sm ${
            testResult.ok
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-600"
          }`}
        >
          {testResult.ok
            ? `连接成功（耗时 ${testResult.durationMs}ms）`
            : `连接失败：${testResult.message}`}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy || !baseUrl.trim() || !modelName.trim() || !apiKey.trim()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存配置"}
        </button>
        <button
          type="button"
          onClick={() => void testForm()}
          disabled={!baseUrl.trim() || !modelName.trim() || !apiKey.trim()}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          测试连接
        </button>
      </div>
    </form>
  );
}

function EditConfigForm({
  config,
  onDone,
}: {
  config: ModelConfigItem;
  onDone: (message: string) => void | Promise<void>;
}) {
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [modelName, setModelName] = useState(config.modelName);
  const [apiKey, setApiKey] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(config.timeoutMs);
  const [maxRetries, setMaxRetries] = useState(config.maxRetries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        baseUrl: baseUrl.trim(),
        modelName: modelName.trim(),
        timeoutMs,
        maxRetries,
      };
      if (apiKey.trim()) {
        body.apiKey = apiKey.trim();
      }
      const response = await fetch(`/api/settings/model-configs/${config.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return;
      }
      await onDone(
        apiKey.trim()
          ? "配置已更新；密钥已替换并重新加密保存。"
          : "配置已更新；密钥保持不变。",
      );
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="mt-3 rounded-lg border border-gray-200 bg-gray-50/60 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-semibold text-gray-900">编辑配置</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormFields
          baseUrl={baseUrl}
          onBaseUrlChange={setBaseUrl}
          modelName={modelName}
          onModelNameChange={setModelName}
          timeoutMs={timeoutMs}
          onTimeoutMsChange={setTimeoutMs}
          maxRetries={maxRetries}
          onMaxRetriesChange={setMaxRetries}
        />
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-gray-600">
            替换 API 密钥（留空 = 保持现有密钥「尾号 {config.keyLast4}」不变）
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="new-password"
            placeholder="不更换请留空"
            className={INPUT_CLASS}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy || !baseUrl.trim() || !modelName.trim()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存修改"}
        </button>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        修改密钥前建议先保存配置，再用列表中的「测试连接」验证已保存配置的连通性。
      </p>
    </form>
  );
}
