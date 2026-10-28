"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { RUN_TYPE_LABELS, type RunTypeValue } from "@/lib/schemas/ai";

// 提示词模板（T15，UIUX P9）：模板列表 → 版本时间线（全部只读）→ [新建版本]
// 编辑器（带输出结构提示与 JSON 校验）→ 强确认（UIUX §4.8："启用后所有新的
// AI 调用将使用该版本"）。版本只增不改、保存即生效（版本号最高者启用）；
// 历史版本仅可查看，回滚 = 用旧内容再建新版本。

export interface PromptVersionDisplay {
  id: string;
  version: number;
  content: string;
  outputSchema: unknown;
  creatorName: string | null;
  createdAtLabel: string;
}

export interface PromptTemplateDisplay {
  id: string;
  name: string;
  runType: string;
  versions: PromptVersionDisplay[];
}

const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function PromptVersionsManager({
  templates,
}: {
  templates: PromptTemplateDisplay[];
}) {
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    await router.refresh();
  }, [router]);

  async function createVersion(
    template: PromptTemplateDisplay,
    content: string,
    outputSchemaText: string,
  ): Promise<boolean> {
    let outputSchema: Record<string, unknown> | undefined;
    const trimmedSchema = outputSchemaText.trim();
    if (trimmedSchema !== "") {
      try {
        const parsed: unknown = JSON.parse(trimmedSchema);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          setError("输出结构提示须为 JSON 对象（如 {\"facts\": \"string\"}）");
          return false;
        }
        outputSchema = parsed as Record<string, unknown>;
      } catch {
        setError("输出结构提示不是合法 JSON，请检查后重试");
        return false;
      }
    }
    // 强确认（UIUX §4.8）：保存即生效
    if (
      !window.confirm(
        "保存后该版本立即生效：所有新的 AI 调用将使用该版本（历史版本保留可查、不可修改）。确定创建？",
      )
    ) {
      return false;
    }
    const response = await fetch(
      `/api/settings/prompts/${template.id}/versions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          ...(outputSchema !== undefined ? { outputSchema } : {}),
        }),
      },
    );
    const payload = (await response.json().catch(() => null)) as
      | { version?: { version?: number }; error?: { message?: string } }
      | null;
    if (!response.ok) {
      setError(payload?.error?.message ?? "创建版本失败，请稍后再试");
      return false;
    }
    setNotice(
      `已创建 v${payload?.version?.version ?? "?"} 版本并生效；历史版本保留可追溯。`,
    );
    return true;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500">
        每类 AI 任务一个模板；版本不可变、只增不改，每次调用记录所用版本（历史可复现）。
        「启用版本」即版本号最高者——新建版本保存后立即生效。
      </p>
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

      <ul className="flex flex-col gap-3">
        {templates.map((template) => {
          const activeVersion = template.versions[0];
          return (
            <li key={template.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="flex flex-wrap items-center gap-2 text-left"
                  onClick={() => {
                    setExpandedId(expandedId === template.id ? null : template.id);
                    setError(null);
                  }}
                >
                  <span className="font-medium text-gray-900">{template.name}</span>
                  <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700">
                    {RUN_TYPE_LABELS[template.runType as RunTypeValue] ?? template.runType}
                  </span>
                  {activeVersion && (
                    <span className="text-xs text-gray-400">
                      启用版本 v{activeVersion.version} · {activeVersion.createdAtLabel}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingTemplateId(
                      editingTemplateId === template.id ? null : template.id,
                    );
                    setError(null);
                  }}
                  className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
                >
                  {editingTemplateId === template.id ? "收起编辑器" : "＋ 新建版本"}
                </button>
              </div>

              {editingTemplateId === template.id && (
                <VersionEditor
                  template={template}
                  onCancel={() => setEditingTemplateId(null)}
                  onSubmit={async (content, schemaText) => {
                    const created = await createVersion(template, content, schemaText);
                    if (created) {
                      setEditingTemplateId(null);
                      await refresh();
                    }
                  }}
                />
              )}

              {expandedId === template.id && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  <p className="mb-2 text-xs text-gray-500">
                    版本时间线（只读，新 → 旧）：
                  </p>
                  <ol className="flex flex-col gap-2">
                    {template.versions.map((version) => (
                      <li key={version.id} className="rounded-md border border-gray-100 p-3">
                        <details>
                          <summary className="cursor-pointer text-sm text-gray-700">
                            v{version.version}
                            {activeVersion?.id === version.id && (
                              <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700">
                                启用中
                              </span>
                            )}
                            <span className="ml-2 text-xs text-gray-400">
                              {version.createdAtLabel}
                              {version.creatorName ? ` · ${version.creatorName}` : ""}
                            </span>
                          </summary>
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-700">
                            {version.content}
                          </pre>
                          {version.outputSchema !== null &&
                            version.outputSchema !== undefined && (
                              <>
                                <p className="mt-2 text-xs text-gray-500">输出结构提示：</p>
                                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-700">
                                  {JSON.stringify(version.outputSchema, null, 2)}
                                </pre>
                              </>
                            )}
                        </details>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function VersionEditor({
  template,
  onSubmit,
  onCancel,
}: {
  template: PromptTemplateDisplay;
  onSubmit: (content: string, outputSchemaText: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [content, setContent] = useState("");
  const [schemaText, setSchemaText] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const currentSchema = template.versions[0]?.outputSchema;

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    if (content.trim() === "") {
      setLocalError("请输入提示词内容");
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onSubmit(content, schemaText);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
      <h3 className="mb-2 text-sm font-semibold text-gray-900">
        新建版本（保存后立即生效）
      </h3>
      {currentSchema !== null && currentSchema !== undefined && (
        <div className="mb-2">
          <p className="text-xs text-gray-500">当前版本输出结构提示（编辑器校验参考）：</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs text-gray-600">
            {JSON.stringify(currentSchema, null, 2)}
          </pre>
        </div>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-gray-600">提示词内容 *</span>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={8}
          maxLength={32000}
          className={INPUT_CLASS}
          placeholder="完整系统提示词。注意保留反幻觉红线：仅使用输入资料；事实与推断分离；信息不足输出 unknown。"
        />
      </label>
      <label className="mt-2 flex flex-col gap-1 text-sm">
        <span className="text-gray-600">输出结构提示（可选，JSON 对象）</span>
        <textarea
          value={schemaText}
          onChange={(event) => setSchemaText(event.target.value)}
          rows={4}
          className={`${INPUT_CLASS} font-mono`}
          placeholder={'留空沿用无需结构提示；或如 {"facts": "string[]", "hypotheses": "string[]"}'}
        />
      </label>
      {localError && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {localError}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || content.trim() === ""}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "创建版本"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
        >
          取消
        </button>
      </div>
    </div>
  );
}
