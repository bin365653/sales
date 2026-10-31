"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TASK_TYPES, TASK_TYPE_LABELS } from "@/lib/tasks";

// 跟进策略管理（V2.0-T05，UIUX §5.5）：系统强制规则行只读 🔒 + 四象限周期策略
// 行内编辑（周期 1–365 整数/任务类型/提前量/启停）+ [保存全部] 二次确认。
// 红线文案常驻：策略修改只影响之后生成的任务，不修改历史任务；
// 系统月度规则不可由策略覆盖（P6）。

export interface PolicyItem {
  id: string;
  name: string;
  quadrantCode: "a" | "b" | "c" | "d" | null;
  intervalDays: number;
  taskType: string;
  advanceDays: number;
  isActive: boolean;
  isSystem: boolean;
}

const QUADRANT_LABELS: Record<"a" | "b" | "c" | "d", string> = {
  a: "A·第一象限（新一代+有意愿）",
  b: "B·第二象限（新一代+无意愿）",
  c: "C·第三象限（未用+有意愿）",
  d: "D·第四象限（未用+无意愿）",
};

const INPUT_CLASS =
  "h-8 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-400";

interface DraftState {
  intervalDays: number;
  taskType: string;
  advanceDays: number;
  isActive: boolean;
}

export function PoliciesManager({ policies }: { policies: PolicyItem[] }) {
  const router = useRouter();
  const systemPolicy = policies.find((policy) => policy.isSystem) ?? null;
  const quadrantPolicies = useMemo(
    () => policies.filter((policy) => !policy.isSystem),
    [policies],
  );
  const [drafts, setDrafts] = useState<Record<string, DraftState>>(() =>
    Object.fromEntries(
      quadrantPolicies.map((policy) => [
        policy.id,
        {
          intervalDays: policy.intervalDays,
          taskType: policy.taskType,
          advanceDays: policy.advanceDays,
          isActive: policy.isActive,
        },
      ]),
    ),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const dirty = quadrantPolicies.some((policy) => {
    const draft = drafts[policy.id];
    if (!draft) {
      return false;
    }
    return (
      draft.intervalDays !== policy.intervalDays ||
      draft.taskType !== policy.taskType ||
      draft.advanceDays !== policy.advanceDays ||
      draft.isActive !== policy.isActive
    );
  });

  function updateDraft(id: string, patch: Partial<DraftState>): void {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
    setNotice(null);
    setError(null);
  }

  function resetDrafts(): void {
    setDrafts(
      Object.fromEntries(
        quadrantPolicies.map((policy) => [
          policy.id,
          {
            intervalDays: policy.intervalDays,
            taskType: policy.taskType,
            advanceDays: policy.advanceDays,
            isActive: policy.isActive,
          },
        ]),
      ),
    );
    setError(null);
  }

  async function saveAll(): Promise<void> {
    if (busy || !dirty) {
      return;
    }
    const intervalInvalid = quadrantPolicies.some((policy) => {
      const value = drafts[policy.id]?.intervalDays;
      return !Number.isInteger(value) || (value ?? 0) < 1 || (value ?? 0) > 365;
    });
    if (intervalInvalid) {
      setError("跟进周期需为 1–365 的整数");
      return;
    }
    if (
      !window.confirm(
        "将更新四条策略并重算命中客户的后续计划。策略修改只影响之后生成的任务，不修改历史任务。确定保存？",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/followup-policies", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policies: quadrantPolicies.map((policy) => ({
            id: policy.id,
            intervalDays: drafts[policy.id]!.intervalDays,
            taskType: drafts[policy.id]!.taskType,
            advanceDays: drafts[policy.id]!.advanceDays,
            isActive: drafts[policy.id]!.isActive,
          })),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string }; affectedLeads?: number }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return;
      }
      setNotice(
        `已保存；命中 ${payload?.affectedLeads ?? 0} 个客户的后续计划将重新计算（新任务按新周期生成）。`,
      );
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500">
        策略修改只影响之后生成的任务，不修改历史任务；保存后命中客户将重新计算后续计划。
        所有操作记录在操作日志中。
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

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">策略</th>
              <th className="px-3 py-2 font-medium">跟进周期（天）</th>
              <th className="px-3 py-2 font-medium">任务类型</th>
              <th className="px-3 py-2 font-medium">生成提前量（天）</th>
              <th className="px-3 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {systemPolicy && (
              <tr className="border-b border-gray-100 bg-amber-50/50">
                <td className="px-3 py-2.5">
                  <span className="font-medium text-gray-900">
                    🔒 {systemPolicy.name}
                  </span>
                  <p className="mt-0.5 text-xs text-gray-500">
                    软件半年内到期的客户，系统每月自动生成一次跟进任务；
                    该规则优先于四象限策略，不可覆盖（系统强制规则）。
                  </p>
                </td>
                <td className="px-3 py-2.5 text-gray-500">{systemPolicy.intervalDays} 天/次</td>
                <td className="px-3 py-2.5 text-gray-400">—</td>
                <td className="px-3 py-2.5 text-gray-400">—</td>
                <td className="px-3 py-2.5">
                  <span
                    title="系统规则，不可由策略覆盖"
                    className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700"
                  >
                    系统强制
                  </span>
                </td>
              </tr>
            )}
            {quadrantPolicies.map((policy) => {
              const draft = drafts[policy.id]!;
              return (
                <tr key={policy.id} className="border-b border-gray-50 last:border-b-0">
                  <td className="px-3 py-2.5">
                    <span className={policy.isActive ? "text-gray-900" : "text-gray-400"}>
                      {QUADRANT_LABELS[policy.quadrantCode as "a" | "b" | "c" | "d"]}
                    </span>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {policy.name} · 适用于超半年（含买断）到期客户
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      value={draft.intervalDays}
                      disabled={busy}
                      aria-label={`${policy.name} 跟进周期（天）`}
                      onChange={(event) =>
                        updateDraft(policy.id, {
                          intervalDays: Number(event.target.value),
                        })
                      }
                      className={`${INPUT_CLASS} w-20`}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={draft.taskType}
                      disabled={busy}
                      aria-label={`${policy.name} 任务类型`}
                      onChange={(event) =>
                        updateDraft(policy.id, { taskType: event.target.value })
                      }
                      className={INPUT_CLASS}
                    >
                      {TASK_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TASK_TYPE_LABELS[type]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2.5">
                    <input
                      type="number"
                      min={0}
                      max={90}
                      step={1}
                      value={draft.advanceDays}
                      disabled={busy}
                      aria-label={`${policy.name} 生成提前量（天）`}
                      onChange={(event) =>
                        updateDraft(policy.id, {
                          advanceDays: Number(event.target.value),
                        })
                      }
                      className={`${INPUT_CLASS} w-20`}
                    />
                  </td>
                  <td className="px-3 py-2.5">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600">
                      <input
                        type="checkbox"
                        checked={draft.isActive}
                        disabled={busy}
                        aria-label={`${policy.name} 启用`}
                        onChange={(event) =>
                          updateDraft(policy.id, { isActive: event.target.checked })
                        }
                      />
                      {draft.isActive ? "启用" : "停用"}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void saveAll()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存全部"}
        </button>
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={resetDrafts}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          取消
        </button>
        <span className="text-xs text-gray-400">
          周期输入 1–365 整数；提前量=任务生成相对周期锚点提前的天数。
        </span>
      </div>
    </div>
  );
}
