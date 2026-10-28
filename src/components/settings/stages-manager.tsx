"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 阶段管理（T15，UIUX P9 / K2/C02）：列表 + 排序（上移/下移，保存顺序）+
// 名称/编码行内编辑 + 启停（停用走确认，无删除）。
// 预置阶段显示「语义锚点」标记（指标口径锚点，不可移除）；
// 自定义阶段标「自定义」；顶部常驻说明：阶段变更记录事件快照，改名/改码不影响历史统计。

export interface StageItem {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  semanticKey: string | null;
}

const INPUT_CLASS =
  "h-8 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function StagesManager({ stages }: { stages: StageItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function patchStage(
    id: string,
    body: Record<string, unknown>,
    successNotice?: string,
  ): Promise<boolean> {
    setError(null);
    const response = await fetch(`/api/settings/stages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  }

  async function toggleActive(stage: StageItem): Promise<void> {
    if (stage.isActive) {
      if (
        !window.confirm(
          `停用后「${stage.name}」不可作为新流转目标，已处于该阶段的客户与历史记录不受影响。确定停用？`,
        )
      ) {
        return;
      }
    }
    setBusyId(stage.id);
    await patchStage(stage.id, { isActive: !stage.isActive });
    setBusyId(null);
  }

  /** 上移/下移：与相邻项交换 sortOrder，两次 PATCH 保存顺序 */
  async function move(index: number, direction: -1 | 1): Promise<void> {
    const targetIndex = index + direction;
    const current = stages[index];
    const target = stages[targetIndex];
    if (!current || !target) {
      return;
    }
    setBusyId(current.id);
    setError(null);
    const first = await patchStage(current.id, { sortOrder: target.sortOrder });
    if (first) {
      await patchStage(target.id, { sortOrder: current.sortOrder });
    }
    setBusyId(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">
          阶段变更会记录事件快照，改名/改码不影响历史统计；停用阶段不可作为新流转目标，
          已有客户与历史记录不受影响（阶段不可删除，只能停用）。
        </p>
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          {creating ? "收起新增表单" : "＋ 新增阶段"}
        </button>
      </div>

      {creating && (
        <CreateStageForm
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            setNotice("阶段已新增（自定义阶段，无语义锚点，不进指标口径）");
            await router.refresh();
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

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-3 py-2 font-medium">顺序</th>
              <th className="px-3 py-2 font-medium">名称</th>
              <th className="px-3 py-2 font-medium">编码</th>
              <th className="px-3 py-2 font-medium">来源</th>
              <th className="px-3 py-2 font-medium">状态</th>
              <th className="px-3 py-2 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage, index) => (
              <tr key={stage.id} className="border-b border-gray-50 last:border-b-0">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-label="上移"
                      disabled={index === 0 || busyId === stage.id}
                      onClick={() => void move(index, -1)}
                      className="rounded border border-gray-200 px-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label="下移"
                      disabled={index === stages.length - 1 || busyId === stage.id}
                      onClick={() => void move(index, 1)}
                      className="rounded border border-gray-200 px-1.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      ↓
                    </button>
                  </div>
                </td>
                <td className="px-3 py-2">
                  {editingId === stage.id ? (
                    <StageEditForm
                      stage={stage}
                      onDone={async () => {
                        setEditingId(null);
                        setNotice("阶段已更新");
                        await router.refresh();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <span className={stage.isActive ? "text-gray-900" : "text-gray-400"}>
                      {stage.name}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500">{stage.code}</td>
                <td className="px-3 py-2">
                  {stage.semanticKey ? (
                    <span
                      title="语义锚点：指标口径锚定此标识，不可移除（K2）"
                      className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600"
                    >
                      ⚓ 语义锚点
                    </span>
                  ) : (
                    <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                      自定义
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {stage.isActive ? (
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                      启用中
                    </span>
                  ) : (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                      已停用
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    {editingId !== stage.id && (
                      <button
                        type="button"
                        onClick={() => setEditingId(stage.id)}
                        className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50"
                      >
                        编辑
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === stage.id}
                      onClick={() => void toggleActive(stage)}
                      className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
                    >
                      {stage.isActive ? "停用" : "启用"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StageEditForm({
  stage,
  onDone,
  onCancel,
}: {
  stage: StageItem;
  onDone: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(stage.name);
  const [code, setCode] = useState(stage.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/settings/stages/${stage.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, code }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return;
      }
      await onDone();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={64}
        required
        aria-label="阶段名称"
        className={INPUT_CLASS}
      />
      <input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        maxLength={64}
        required
        aria-label="阶段编码"
        className={`${INPUT_CLASS} font-mono`}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => void submit()}
        className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-60"
      >
        保存
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
      >
        取消
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}

function CreateStageForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/stages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), code: code.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "新增失败，请稍后再试");
        return;
      }
      await onCreated();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-blue-100 bg-blue-50/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-semibold text-gray-900">新增自定义阶段</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">阶段名称 *</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={64}
            required
            className={INPUT_CLASS}
            placeholder="如：已签约待实施"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">阶段编码 *（小写字母开头的字母/数字/下划线）</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={64}
            required
            className={`${INPUT_CLASS} font-mono`}
            placeholder="如 signed_pending"
          />
        </label>
      </div>
      <p className="mt-2 text-xs text-gray-400">
        自定义阶段不持有语义锚点：参与漏斗展示与阶段分布，不进入指标口径。
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy || !name.trim() || !code.trim()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
        >
          取消
        </button>
      </div>
    </form>
  );
}
