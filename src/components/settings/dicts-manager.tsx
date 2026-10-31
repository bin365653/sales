"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 数据字典管理（V2.0-T02，UIUX §5.3）：按字段分组维护字典值、新一代标记、
// 排序、启停。删除仅提供「停用」（无物理删除，历史数据不受影响）；
// 全部操作写审计日志。「新一代」标记仅 current_system 字段提供（决策 D1），
// 用于系统建议，最终以人工确认为准。

export interface DictManagerEntry {
  id: string;
  value: string;
  isNextGen: boolean;
  sortOrder: number;
  isActive: boolean;
}

export interface DictManagerField {
  fieldKey: string;
  label: string;
  dictEnabled: boolean;
  entries: DictManagerEntry[];
}

const INPUT_CLASS =
  "h-8 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function DictsManager({ fields }: { fields: DictManagerField[] }) {
  const router = useRouter();
  const [activeKey, setActiveKey] = useState(fields[0]?.fieldKey ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 行内编辑暂存：entryId → {value, sortOrder, isNextGen}
  const [drafts, setDrafts] = useState<
    Record<string, { value: string; sortOrder: string; isNextGen: boolean }>
  >({});

  const active = fields.find((field) => field.fieldKey === activeKey) ?? fields[0];

  function draftOf(entry: DictManagerEntry) {
    return (
      drafts[entry.id] ?? {
        value: entry.value,
        sortOrder: String(entry.sortOrder),
        isNextGen: entry.isNextGen,
      }
    );
  }

  function setDraft(
    entry: DictManagerEntry,
    patch: Partial<ReturnType<typeof draftOf>>,
  ) {
    setDrafts((prev) => ({
      ...prev,
      [entry.id]: { ...draftOf(entry), ...patch },
    }));
  }

  async function request(
    url: string,
    method: string,
    body?: Record<string, unknown>,
    successNotice?: string,
  ): Promise<boolean> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return false;
      }
      if (successNotice) {
        setNotice(successNotice);
      }
      router.refresh();
      return true;
    } catch {
      setError("网络异常，请稍后再试");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createEntry(fieldKey: string, form: FormData): Promise<void> {
    const value = String(form.get("value") ?? "").trim();
    if (!value) {
      setError("请输入字典值");
      return;
    }
    const body: Record<string, unknown> = { value };
    if (fieldKey === "current_system" && form.get("isNextGen") === "on") {
      body.meta = { isNextGen: true };
    }
    const ok = await request(
      `/api/settings/dicts/${fieldKey}`,
      "POST",
      body,
      `已新增字典值「${value}」`,
    );
    if (ok) {
      setCreating(false);
    }
  }

  if (!active) {
    return <p className="text-sm text-gray-500">暂无支持数据字典的字段。</p>;
  }

  const activeEntries = active.entries.filter((entry) => entry.isActive);
  const inactiveEntries = active.entries.filter((entry) => !entry.isActive);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500">
        字典值用于对应字段的下拉选择；停用值不再出现在新选择中，历史数据不受影响。
        {active.fieldKey === "current_system" && (
          <>
            「新一代」标记用于系统建议（选择该软件时提示可预填「是否新一代手机开单」），
            <span className="font-medium">最终以人工确认为准</span>。
          </>
        )}
        全部改动记录在操作日志。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="dict-field-switch" className="text-sm text-gray-600">
          字段：
        </label>
        <select
          id="dict-field-switch"
          value={active.fieldKey}
          onChange={(event) => {
            setActiveKey(event.target.value);
            setCreating(false);
            setError(null);
            setNotice(null);
          }}
          className={`${INPUT_CLASS} w-56`}
        >
          {fields.map((field) => (
            <option key={field.fieldKey} value={field.fieldKey}>
              {field.label}
              {field.dictEnabled ? "（字典已启用）" : "（无启用值）"}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          className="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {creating ? "收起新增表单" : "＋ 新增字典值"}
        </button>
      </div>

      {creating && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createEntry(active.fieldKey, new FormData(event.currentTarget));
          }}
          className="flex flex-wrap items-end gap-3 rounded-md border border-blue-100 bg-blue-50/60 p-3"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="dict-new-value" className="text-xs font-medium text-gray-600">
              字典值（即客户资料中的标准写法）
            </label>
            <input
              id="dict-new-value"
              name="value"
              maxLength={128}
              className={`${INPUT_CLASS} w-64`}
              autoFocus
            />
          </div>
          {active.fieldKey === "current_system" && (
            <label className="flex items-center gap-2 pb-1.5 text-sm text-gray-700">
              <input type="checkbox" name="isNextGen" className="h-4 w-4" />
              新一代手机开单系统
            </label>
          )}
          <button
            type="submit"
            disabled={busy}
            className="h-8 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
          >
            保存
          </button>
        </form>
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

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">字典值</th>
              {active.fieldKey === "current_system" && (
                <th className="px-3 py-2 font-medium">新一代标记</th>
              )}
              <th className="px-3 py-2 font-medium">排序</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {activeEntries.map((entry) => {
              const draft = draftOf(entry);
              const dirty =
                draft.value !== entry.value ||
                draft.sortOrder !== String(entry.sortOrder) ||
                draft.isNextGen !== entry.isNextGen;
              return (
                <tr key={entry.id} className="border-b border-gray-100 last:border-0">
                  <td className="px-3 py-2">
                    <input
                      aria-label={`字典值-${entry.value}`}
                      value={draft.value}
                      maxLength={128}
                      onChange={(event) =>
                        setDraft(entry, { value: event.target.value })
                      }
                      className={INPUT_CLASS}
                    />
                  </td>
                  {active.fieldKey === "current_system" && (
                    <td className="px-3 py-2">
                      <label className="flex items-center gap-1.5 text-xs text-gray-600">
                        <input
                          type="checkbox"
                          checked={draft.isNextGen}
                          onChange={(event) =>
                            setDraft(entry, { isNextGen: event.target.checked })
                          }
                          className="h-4 w-4"
                        />
                        新一代手机开单
                      </label>
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <input
                      aria-label={`排序-${entry.value}`}
                      value={draft.sortOrder}
                      inputMode="numeric"
                      onChange={(event) =>
                        setDraft(entry, { sortOrder: event.target.value })
                      }
                      className={`${INPUT_CLASS} w-16`}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                      启用
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy || !dirty}
                        onClick={() =>
                          void request(
                            `/api/settings/dicts/${active.fieldKey}/${entry.id}`,
                            "PATCH",
                            {
                              value: draft.value,
                              sortOrder: Number(draft.sortOrder),
                              ...(active.fieldKey === "current_system"
                                ? { meta: { isNextGen: draft.isNextGen } }
                                : {}),
                            },
                            "字典值已保存",
                          )
                        }
                        className="rounded-md border border-blue-200 px-2.5 py-1 text-xs text-blue-700 transition hover:bg-blue-50 disabled:opacity-40"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `停用后「${entry.value}」不再出现在新选择中，历史数据不受影响。确定停用？`,
                            )
                          ) {
                            return;
                          }
                          void request(
                            `/api/settings/dicts/${active.fieldKey}/${entry.id}`,
                            "DELETE",
                            undefined,
                            "已停用",
                          );
                        }}
                        className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition hover:bg-gray-50 disabled:opacity-40"
                      >
                        停用
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {activeEntries.length === 0 && (
              <tr>
                <td
                  colSpan={active.fieldKey === "current_system" ? 5 : 4}
                  className="px-3 py-6 text-center text-sm text-gray-400"
                >
                  该字段暂无字典值，新增后表单将提供下拉选择
                </td>
              </tr>
            )}
            {inactiveEntries.map((entry) => (
              <tr key={entry.id} className="border-b border-gray-100 bg-gray-50/60 last:border-0">
                <td className="px-3 py-2 text-gray-400 line-through">{entry.value}</td>
                {active.fieldKey === "current_system" && (
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {entry.isNextGen ? "新一代手机开单" : "—"}
                  </td>
                )}
                <td className="px-3 py-2 text-gray-400">{entry.sortOrder}</td>
                <td className="px-3 py-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                    已停用
                  </span>
                </td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void request(
                        `/api/settings/dicts/${active.fieldKey}/${entry.id}`,
                        "PATCH",
                        { isActive: true },
                        "已启用",
                      )
                    }
                    className="rounded-md border border-emerald-200 px-2.5 py-1 text-xs text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40"
                  >
                    启用
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
