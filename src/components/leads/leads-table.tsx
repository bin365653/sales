"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PRIORITY_BADGE_CLASS, PRIORITY_LABELS, type LeadPriority } from "@/lib/format";
import type { ExperimentGroupValue } from "@/lib/experiments";
import type { LeadQuadrantCode } from "@/lib/quadrant";
import { GroupBadge } from "@/components/leads/group-badge";
import { QuadrantBadge } from "@/components/leads/quadrant-badge";

// 线索池表格 + 批量修改（P3，T04）。
// 批量修改走 PATCH /api/leads/batch：白名单字段（优先级/阶段/来源/下次联系），
// 其余字段在 Schema 层被拒绝（不静默忽略）；勾选仅限当前页。
// V2.0-T03：新增象限徽章列与到期年月列（ExpiryChip 语义文案）。

const SELECT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export interface LeadRow {
  id: string;
  name: string;
  city: string | null;
  industry: string | null;
  stageName: string;
  priority: string;
  contactName: string | null;
  contactPhone: string | null;
  lastContactAt: string | null;
  updatedAt: string;
  /** V2.0-T03：象限（null=画像待完善） */
  quadrantCode: LeadQuadrantCode | null;
  /** V2.0-T03：到期年月 ExpiryChip 文案（null=未知） */
  expiryDisplay: string | null;
}

export interface LeadsTableProps {
  rows: LeadRow[];
  stages: { id: string; name: string }[];
  /** 实验分组（T14）：进行中实验覆盖的 lead → 组别；命中时名称旁带 GroupBadge */
  experimentGroups?: Map<string, ExperimentGroupValue>;
}

function priorityBadge(priority: string): string {
  return PRIORITY_BADGE_CLASS[priority as LeadPriority] ?? "bg-gray-100 text-gray-500";
}

export function LeadsTable({ rows, stages, experimentGroups }: LeadsTableProps) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchPriority, setBatchPriority] = useState("");
  const [batchStageId, setBatchStageId] = useState("");
  const [batchSource, setBatchSource] = useState("");
  const [batchNextContactAt, setBatchNextContactAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggleAll(): void {
    setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));
  }

  function toggleOne(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function resetBatchControls(): void {
    setBatchPriority("");
    setBatchStageId("");
    setBatchSource("");
    setBatchNextContactAt("");
  }

  function clearSelection(): void {
    setSelected(new Set());
    resetBatchControls();
    setMessage(null);
    setError(null);
  }

  async function applyBatch(): Promise<void> {
    const changes: Record<string, unknown> = {};
    if (batchPriority !== "") {
      changes.priority = batchPriority;
    }
    if (batchStageId !== "") {
      changes.stageId = batchStageId;
    }
    if (batchSource.trim() !== "") {
      changes.source = batchSource.trim();
    }
    if (batchNextContactAt !== "") {
      changes.nextContactAt = batchNextContactAt;
    }
    if (Object.keys(changes).length === 0) {
      setError("请至少设置一项要修改的内容");
      return;
    }
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/leads/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [...selected], changes }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { total?: number; updated?: number; skipped?: number; error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "批量修改失败，请稍后再试");
        return;
      }
      setMessage(
        `批量修改完成：更新 ${payload?.updated ?? 0} 条` +
          (payload?.skipped ? `，跳过 ${payload.skipped} 条（无变化）` : ""),
      );
      clearSelection();
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {selected.size > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-blue-800">
              已选 {selected.size} 项，批量修改：
            </span>
            <select
              aria-label="批量设置优先级"
              value={batchPriority}
              onChange={(event) => setBatchPriority(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">优先级（不改）</option>
              <option value="high">优先级：高</option>
              <option value="mid">优先级：中</option>
              <option value="low">优先级：低</option>
            </select>
            <select
              aria-label="批量流转阶段"
              value={batchStageId}
              onChange={(event) => setBatchStageId(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="">阶段（不改）</option>
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  阶段：{stage.name}
                </option>
              ))}
            </select>
            <input
              aria-label="批量设置客户来源"
              type="text"
              placeholder="客户来源（不改）"
              value={batchSource}
              onChange={(event) => setBatchSource(event.target.value)}
              className={`${SELECT_CLASS} w-40`}
            />
            <input
              aria-label="批量设置下次联系时间"
              type="datetime-local"
              title="下次联系时间（不改）"
              value={batchNextContactAt}
              onChange={(event) => setBatchNextContactAt(event.target.value)}
              className={SELECT_CLASS}
            />
            <button
              type="button"
              onClick={applyBatch}
              disabled={busy}
              className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "提交中…" : "应用修改"}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={busy}
              className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm text-gray-600 transition hover:bg-gray-50"
            >
              取消选择
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          {message && <p className="mt-2 text-sm text-emerald-700">{message}</p>}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
              <th className="w-10 px-3 py-2.5">
                <input
                  type="checkbox"
                  aria-label="全选本页"
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </th>
              <th className="px-3 py-2.5 font-medium">客户名称</th>
              <th className="px-3 py-2.5 font-medium">象限</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">到期年月</th>
              <th className="px-3 py-2.5 font-medium">城市</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">行业</th>
              <th className="px-3 py-2.5 font-medium">阶段</th>
              <th className="px-3 py-2.5 font-medium">优先级</th>
              <th className="hidden px-3 py-2.5 font-medium lg:table-cell">联系人</th>
              <th className="hidden px-3 py-2.5 font-medium lg:table-cell">最近联系</th>
              <th className="hidden px-3 py-2.5 font-medium md:table-cell">更新时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-gray-100 last:border-b-0 hover:bg-gray-50/60 ${
                  selected.has(row.id) ? "bg-blue-50/40" : ""
                }`}
              >
                <td className="px-3 py-2.5">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.name}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggleOne(row.id)}
                  />
                </td>
                <td className="px-3 py-2.5">
                  <Link
                    href={`/leads/${row.id}`}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {row.name}
                  </Link>
                  {/* 实验分组徽章（T14，UIUX §5）：实验进行中且该线索被覆盖时显示 */}
                  {experimentGroups?.get(row.id) && (
                    <span className="ml-1.5 inline-block align-middle">
                      <GroupBadge group={experimentGroups.get(row.id)!} />
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5">
                  <QuadrantBadge code={row.quadrantCode} />
                </td>
                <td className="hidden px-3 py-2.5 text-gray-600 md:table-cell">
                  {row.expiryDisplay ?? "—"}
                </td>
                <td className="px-3 py-2.5 text-gray-600">{row.city ?? "—"}</td>
                <td className="hidden px-3 py-2.5 text-gray-600 md:table-cell">
                  {row.industry ?? "—"}
                </td>
                <td className="px-3 py-2.5">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
                    {row.stageName}
                  </span>
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      priorityBadge(row.priority)
                    }`}
                  >
                    {PRIORITY_LABELS[row.priority as LeadPriority] ?? row.priority}
                  </span>
                </td>
                <td className="hidden px-3 py-2.5 text-gray-600 lg:table-cell">
                  {row.contactName ?? "—"}
                </td>
                <td className="hidden px-3 py-2.5 text-gray-600 lg:table-cell">
                  {row.lastContactAt ?? "—"}
                </td>
                <td className="hidden px-3 py-2.5 text-xs text-gray-400 md:table-cell">
                  {row.updatedAt}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-10 text-center text-gray-400">
                  没有符合条件的客户
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {selected.size === 0 && message && (
        <p className="text-sm text-emerald-700">{message}</p>
      )}
    </div>
  );
}
