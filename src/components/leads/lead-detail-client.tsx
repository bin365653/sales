"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  FACT_STATUS_BADGE_CLASS,
  FACT_STATUS_LABELS,
  PRIORITY_BADGE_CLASS,
  PRIORITY_LABELS,
  type FactStatus,
  type LeadPriority,
} from "@/lib/format";
import { LeadForm } from "@/components/leads/lead-form";
import {
  InteractionsPanel,
  type InteractionView,
} from "@/components/leads/interactions-panel";
import { TasksPanel } from "@/components/tasks/tasks-panel";
import { AiPanelSection, type AiQuotaView } from "@/components/leads/ai-panel";
import type { AiRunView } from "@/lib/ai-run-view";
import type { RunTypeValue } from "@/lib/schemas/ai";
import type { TaskView } from "@/components/tasks/task-view";
import type { FieldDefRow } from "@/lib/lead-form-fields";

// 客户详情交互壳（P5，T04）：查看（画像+时间线）/ 编辑切换、阶段流转、软删除。
// 展示数据已由服务端页面整形完毕，这里只做交互与提交。

export interface LeadHeaderView {
  id: string;
  name: string;
  dataVersion: number;
  stageId: string;
  stageName: string;
  priority: string;
  nextContactAt: string | null;
  lastContactAt: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DisplayGroup {
  title: string;
  fields: {
    label: string;
    text: string;
    factStatus?: string;
  }[];
}

export interface CustomDisplay {
  label: string;
  text: string;
  archived: boolean;
}

export interface TimelineItem {
  id: string;
  eventType: string;
  title: string;
  detailText: string | null;
  actorName: string | null;
  occurredAt: string;
}

export interface LeadDetailClientProps {
  lead: LeadHeaderView;
  groups: DisplayGroup[];
  customDisplay: CustomDisplay[];
  timeline: TimelineItem[];
  fieldDefs: FieldDefRow[];
  stages: { id: string; name: string }[];
  /** 启用中的阶段（含语义锚点与排序），供沟通表单展示 K4 推进提示 */
  stageOptions: {
    id: string;
    name: string;
    sortOrder: number;
    semanticKey: string | null;
  }[];
  currentStageSortOrder: number;
  interactions: InteractionView[];
  tasks: TaskView[];
  formValues: Record<string, string | number | boolean | null>;
  /** AI 面板初始数据（T09）：runs/用量/启用提示词版本，轮询后由面板自行刷新 */
  aiRuns: AiRunView[];
  aiUsage: AiQuotaView;
  activePromptVersions: Partial<Record<RunTypeValue, number | null>>;
}

const SELECT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

function factBadgeClass(status: string): string {
  return (
    FACT_STATUS_BADGE_CLASS[status as FactStatus] ?? "bg-gray-100 text-gray-500"
  );
}

export function LeadDetailClient({
  lead,
  groups,
  customDisplay,
  timeline,
  fieldDefs,
  stages,
  stageOptions,
  currentStageSortOrder,
  interactions,
  tasks,
  formValues,
  aiRuns,
  aiUsage,
  activePromptVersions,
}: LeadDetailClientProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [targetStageId, setTargetStageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function transitionStage(): Promise<void> {
    if (targetStageId === "" || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}/stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: targetStageId, dataVersion: lead.dataVersion }),
      });
      if (response.ok) {
        setTargetStageId("");
        setNotice("阶段已更新");
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      setError(
        payload?.error?.code === "version_conflict"
          ? "数据已被其他操作修改，请刷新页面后重试"
          : (payload?.error?.message ?? "阶段流转失败，请稍后再试"),
      );
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  async function deleteLead(): Promise<void> {
    if (busy) {
      return;
    }
    const confirmed = window.confirm(
      `确定删除客户「${lead.name}」吗？删除后不再出现在列表中，历史记录保留。`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/leads/${lead.id}`, { method: "DELETE" });
      if (response.ok) {
        router.push("/leads");
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setError(payload?.error?.message ?? "删除失败，请稍后再试");
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex items-center justify-between">
        <Link href="/leads" className="text-sm text-gray-500 hover:text-gray-700">
          ← 返回线索池
        </Link>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setEditing((prev) => !prev)}
            disabled={busy}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
          >
            {editing ? "停止编辑" : "编辑资料"}
          </button>
          <button
            type="button"
            onClick={deleteLead}
            disabled={busy}
            className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 transition hover:bg-red-50 disabled:opacity-60"
          >
            删除客户
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && !editing && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      <header className="rounded-lg border border-gray-200 bg-white p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{lead.name}</h1>
          <span className="rounded bg-blue-50 px-2 py-0.5 text-sm text-blue-700">
            {lead.stageName}
          </span>
          <span
            className={`rounded px-2 py-0.5 text-sm ${
              PRIORITY_BADGE_CLASS[lead.priority as LeadPriority] ??
              "bg-gray-100 text-gray-500"
            }`}
          >
            优先级：
            {PRIORITY_LABELS[lead.priority as LeadPriority] ?? lead.priority}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-gray-400">下次联系</dt>
            <dd className="text-gray-700">{lead.nextContactAt ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">最近联系</dt>
            <dd className="text-gray-700">{lead.lastContactAt ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">创建时间</dt>
            <dd className="text-gray-700">{lead.createdAt}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">最近更新</dt>
            <dd className="text-gray-700">{lead.updatedAt}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-4">
          <span className="text-sm text-gray-500">阶段流转：</span>
          <select
            aria-label="选择目标阶段"
            value={targetStageId}
            onChange={(event) => setTargetStageId(event.target.value)}
            className={SELECT_CLASS}
          >
            <option value="">选择目标阶段…</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={transitionStage}
            disabled={targetStageId === "" || busy}
            className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "提交中…" : "流转"}
          </button>
          <span className="text-xs text-gray-400">数据版本 v{lead.dataVersion}</span>
        </div>
      </header>

      {editing ? (
        <div className="rounded-lg border border-gray-200 bg-white p-4 md:p-6">
          <LeadForm
            mode="edit"
            leadId={lead.id}
            dataVersion={lead.dataVersion}
            defs={fieldDefs}
            stages={stages}
            initial={formValues}
            onSaved={() => {
              setEditing(false);
              setNotice("资料已保存");
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {groups.map((group) => (
              <section
                key={group.title}
                className="rounded-lg border border-gray-200 bg-white p-4"
              >
                <h2 className="mb-3 text-sm font-semibold text-gray-900">
                  {group.title}
                </h2>
                <dl className="flex flex-col gap-2">
                  {group.fields.map((field) => (
                    <div
                      key={field.label}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <dt className="shrink-0 text-gray-500">{field.label}</dt>
                      <dd className="flex items-center gap-1.5 text-right text-gray-800">
                        {field.text}
                        {field.factStatus && (
                          <span
                            title={`核实状态：${FACT_STATUS_LABELS[field.factStatus as FactStatus] ?? field.factStatus}`}
                            className={`rounded px-1.5 py-0.5 text-xs ${
                              factBadgeClass(field.factStatus)
                            }`}
                          >
                            {FACT_STATUS_LABELS[field.factStatus as FactStatus] ??
                              field.factStatus}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
            {customDisplay.length > 0 && (
              <section className="rounded-lg border border-gray-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">
                  自定义字段
                </h2>
                <dl className="flex flex-col gap-2">
                  {customDisplay.map((field) => (
                    <div
                      key={field.label}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <dt className="shrink-0 text-gray-500">
                        {field.label}
                        {field.archived && (
                          <span className="ml-1 text-xs text-gray-400">（已停用）</span>
                        )}
                      </dt>
                      <dd className="text-right text-gray-800">{field.text}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
            {lead.remark && (
              <section className="rounded-lg border border-gray-200 bg-white p-4">
                <h2 className="mb-3 text-sm font-semibold text-gray-900">备注</h2>
                <p className="whitespace-pre-wrap text-sm text-gray-800">
                  {lead.remark}
                </p>
              </section>
            )}
          </div>

          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-4 text-sm font-semibold text-gray-900">
              阶段时间线（{timeline.length} 条）
            </h2>
            <ol className="flex flex-col">
              {timeline.map((item, index) => (
                <li key={item.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        item.eventType === "stage_changed"
                          ? "bg-blue-500"
                          : "bg-gray-300"
                      }`}
                    />
                    {index < timeline.length - 1 && (
                      <span className="w-px flex-1 bg-gray-200" />
                    )}
                  </div>
                  <div className="pb-5">
                    <p className="text-sm text-gray-800">
                      {item.title}
                      {item.detailText && (
                        <span className="ml-2 text-gray-500">{item.detailText}</span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {item.occurredAt}
                      {item.actorName ? ` · ${item.actorName}` : ""}
                    </p>
                  </div>
                </li>
              ))}
              {timeline.length === 0 && (
                <li className="text-sm text-gray-400">暂无记录</li>
              )}
            </ol>
          </section>

          {/* 沟通记录（T06 交付） */}
          <InteractionsPanel
            leadId={lead.id}
            leadName={lead.name}
            currentStageName={lead.stageName}
            currentStageSortOrder={currentStageSortOrder}
            stages={stageOptions}
            interactions={interactions}
          />
          {/* 任务区块（T07 交付）：待处理在前，完成弹窗=沟通结果+下一任务单事务 */}
          <TasksPanel
            leadId={lead.id}
            leadName={lead.name}
            stages={stageOptions}
            tasks={tasks}
          />
          {/* AI 面板（T09 交付）：异步/轮询/失败重试/复制/历史；错误边界内，
              AI 异常只影响面板自身（验收项） */}
          <AiPanelSection
            leadId={lead.id}
            leadName={lead.name}
            initialRuns={aiRuns}
            initialUsage={aiUsage}
            activePromptVersions={activePromptVersions}
          />
        </>
      )}
    </div>
  );
}
