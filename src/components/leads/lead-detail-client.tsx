"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  FACT_STATUS_BADGE_CLASS,
  FACT_STATUS_HINTS,
  FACT_STATUS_LABELS,
  PRIORITY_BADGE_CLASS,
  PRIORITY_LABELS,
  type FactStatus,
  type LeadPriority,
} from "@/lib/format";
import { LeadForm } from "@/components/leads/lead-form";
import { QuadrantBadge } from "@/components/leads/quadrant-badge";
import {
  InteractionsPanel,
  type InteractionView,
} from "@/components/leads/interactions-panel";
import { TasksPanel } from "@/components/tasks/tasks-panel";
import { AiPanelSection, type AiQuotaView } from "@/components/leads/ai-panel";
import {
  ControlGroupNoticeCard,
  GroupBadge,
} from "@/components/leads/group-badge";
import type { ExperimentGroupValue } from "@/lib/experiments";
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

export interface VerifyMeta {
  /** 来源文案：人工录入 / 导入 / 沟通确认 / 系统初始化 */
  source: string;
  person: string | null;
  time: string | null;
}

export interface DisplayGroup {
  title: string;
  fields: {
    label: string;
    text: string;
    /** V2.0 四态核实状态（verification-first） */
    factStatus?: string;
    /** 核实五元组（来源/核实人/核实时间），hover ⓘ 展示 */
    verifyMeta?: VerifyMeta;
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

/** 画像核实历史条目（updated 事件的字段级变更明细，V2.0-T03） */
export interface VerifyHistoryItem {
  id: string;
  occurredAt: string;
  actorName: string | null;
  source: string | null;
  fields: {
    label: string;
    from: string;
    to: string;
    statusText: string | null;
  }[];
}

/** 画像缺失项（核心字段未核实；V2.0-T03 快捷更新入口） */
export interface MissingFieldItem {
  defKey: string;
  label: string;
  statusText: string;
  /** 确定性核实话术模板（V2.4 起 AI 增强） */
  script: string;
}

/** 分类信息卡数据（V2.0-T04，UIUX §4.4）：象限 + 依据 + 最近变化 + 经营建议 */
export interface ClassificationView {
  /** null = 画像待完善 */
  quadrant: "a" | "b" | "c" | "d" | null;
  computedAtLabel: string | null;
  basis: {
    xLabel: string;
    xValueText: string;
    xStatusText: string;
    yLabel: string;
    yValueText: string;
    yStatusText: string;
  };
  advice: string | null;
  missing: string[];
  lastChange: {
    fromLabel: string;
    toLabel: string;
    dateLabel: string;
    actorName: string | null;
    sourceText: string | null;
  } | null;
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
  /** V2.0-T02：字典启用字段（defKey）→ 启用值（编辑表单 DictSelect 渲染） */
  dictOptions?: Record<string, { value: string; isNextGen: boolean }[]>;
  /** V2.0-T03：核心画像已核实数（confirmed/stated）/ 7 */
  coreVerifiedCount?: number;
  /** V2.0-T03：画像核实历史（字段级变更，最新在前） */
  verifyHistory?: VerifyHistoryItem[];
  /** V2.0-T03：核心画像缺失项 + 快捷更新入口 */
  missingCoreFields?: MissingFieldItem[];
  /** V2.0-T04：分类信息卡（象限/依据/最近变化/经营建议） */
  classification?: ClassificationView;
  /** AI 面板初始数据（T09）：runs/用量/启用提示词版本，轮询后由面板自行刷新 */
  aiRuns: AiRunView[];
  aiUsage: AiQuotaView;
  activePromptVersions: Partial<Record<RunTypeValue, number | null>>;
  /** 实验分组（T14）：进行中实验覆盖该线索时的组别；常规组隐藏全部 AI 入口 */
  experimentGroup?: ExperimentGroupValue | null;
}

const SELECT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

function factBadgeClass(status: string): string {
  return (
    FACT_STATUS_BADGE_CLASS[status as FactStatus] ?? "bg-gray-100 text-gray-500"
  );
}

/** 四态徽章 hover：状态含义 + 五元组（来源/核实人/核实时间） */
function factBadgeTitle(field: {
  factStatus?: string;
  verifyMeta?: VerifyMeta;
}): string {
  const statusLine = `核实状态：${FACT_STATUS_LABELS[field.factStatus as FactStatus] ?? field.factStatus}`;
  const hint =
    FACT_STATUS_HINTS[field.factStatus as FactStatus] ?? "";
  const meta = field.verifyMeta;
  const metaLine = meta
    ? `来源：${meta.source}${meta.person ? ` · 核实人：${meta.person}` : ""}${meta.time ? ` · ${meta.time}` : ""}`
    : null;
  return metaLine ? `${statusLine}（${hint}）\n${metaLine}` : `${statusLine}（${hint}）`;
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
  dictOptions,
  coreVerifiedCount,
  verifyHistory = [],
  missingCoreFields = [],
  classification,
  aiRuns,
  aiUsage,
  activePromptVersions,
  experimentGroup = null,
}: LeadDetailClientProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  // 常规组（T14）：AI Tab 整体替换为说明卡，无任何 AI 入口（UIUX §4.7）；
  // 互斥状态仍保留（沟通表单摘要入口同被隐藏）
  const isControlGroup = experimentGroup === "control";
  const [targetStageId, setTargetStageId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // AI 发起互斥（T10，UIUX §4.7）：详情页 AI 面板与沟通表单「AI 生成摘要」
  // 任一处存在 pending run 时，其余 AI 入口禁用（防并发重复调用）
  const [aiRunInFlight, setAiRunInFlight] = useState(false);

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
          {/* 实验分组徽章（T14）：进行中实验覆盖该线索时显示（UIUX §4.6） */}
          {experimentGroup && <GroupBadge group={experimentGroup} />}
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
            dictOptions={dictOptions}
            onSaved={() => {
              setEditing(false);
              setNotice("资料已保存");
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          {/* V2.0-T04：分类信息卡（象限是这个页面最重要的新信息，置顶展示） */}
          {classification && (
            <section className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="mb-3 text-sm font-semibold text-gray-900">分类信息</h2>
              <div className="flex flex-wrap items-center gap-2">
                <QuadrantBadge code={classification.quadrant} />
                {classification.computedAtLabel && (
                  <span className="text-xs text-gray-400">
                    更新于 {classification.computedAtLabel}
                  </span>
                )}
              </div>
              {classification.quadrant ? (
                <p className="mt-2 text-sm leading-relaxed text-gray-700">
                  依据：未{classification.basis.xValueText === "是" ? "" : ""}使用新一代
                  ——{" "}
                  <span className="text-gray-500">
                    {classification.basis.xLabel} = {classification.basis.xValueText}
                    （{classification.basis.xStatusText}）· {classification.basis.yLabel} ={" "}
                    {classification.basis.yValueText}（{classification.basis.yStatusText}）
                  </span>
                </p>
              ) : (
                <p className="mt-2 text-sm leading-relaxed text-amber-700">
                  缺少确认：{classification.missing.join("；")}。完成两个分类维度的核实后，
                  客户将进入四象限。
                </p>
              )}
              {classification.lastChange && (
                <p className="mt-2 text-sm text-gray-600">
                  最近变化：{classification.lastChange.fromLabel} →{" "}
                  {classification.lastChange.toLabel}（{classification.lastChange.dateLabel}
                  {classification.lastChange.actorName
                    ? `，${classification.lastChange.actorName}`
                    : ""}
                  {classification.lastChange.sourceText
                    ? `，${classification.lastChange.sourceText}`
                    : ""}
                  ）
                </p>
              )}
              {classification.advice && (
                <p className="mt-2 rounded-md bg-blue-50/60 px-3 py-2 text-sm leading-relaxed text-blue-800">
                  当前经营建议：{classification.advice}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-gray-400">
                ⓘ
                分类由系统根据两个已确认维度自动计算：是否使用新一代手机开单系统、是否愿意沟通了解勤策；分类不可手动填写。
              </p>
              {classification.quadrant === null && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="mt-3 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-700"
                >
                  去核实分类维度
                </button>
              )}
            </section>
          )}

          {/* V2.0-T03：核心画像进度（轻量提示，不强制必填——引导而非拦截） */}
          {typeof coreVerifiedCount === "number" && (
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-gray-900">
                  核心画像 {coreVerifiedCount}/7 已核实
                </span>
                {missingCoreFields.length > 0 && (
                  <span className="text-xs text-gray-500">
                    待核实：{missingCoreFields.map((item) => item.label).join("、")}
                  </span>
                )}
              </div>
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={7}
                aria-valuenow={coreVerifiedCount}
                aria-label="核心画像已核实进度"
              >
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${(coreVerifiedCount / 7) * 100}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-gray-400">
                已核实 = 已确认 或 客户自述待复核；未知与待核实不会被当作「否」。
              </p>
            </div>
          )}

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
                            title={factBadgeTitle(field)}
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

          {/* V2.0-T03：画像缺失项（核心未核实字段）+ 快捷更新入口 */}
          {missingCoreFields.length > 0 && (
            <section className="rounded-lg border border-amber-200 bg-amber-50/40 p-4">
              <h2 className="mb-1 text-sm font-semibold text-amber-700">
                画像缺失项（{missingCoreFields.length}）
              </h2>
              <p className="mb-3 text-xs leading-relaxed text-amber-600">
                以下核心字段尚未核实；未知与待核实不会被当作「否」。核实话术供电话沟通参考。
              </p>
              <ul className="flex flex-col gap-2">
                {missingCoreFields.map((item) => (
                  <li
                    key={item.defKey}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2 text-sm"
                  >
                    <span>
                      <span className="font-medium text-gray-800">{item.label}</span>
                      <span className="ml-2 text-xs text-gray-400">
                        当前：{item.statusText}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="hidden max-w-xs truncate text-xs text-gray-400 sm:inline">
                        {item.script}
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(item.script);
                          } catch {
                            // 剪贴板不可用（非安全上下文）时静默忽略
                          }
                        }}
                        className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-50"
                      >
                        复制话术
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-blue-700"
                      >
                        去核实
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* V2.0-T03：画像核实历史（字段值与核实状态变更，只读留痕） */}
          <section className="rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-gray-900">
              画像核实历史（{verifyHistory.length} 条）
            </h2>
            <p className="mb-3 text-xs leading-relaxed text-gray-400">
              字段值与核实状态的每次变更都保留历史，不会被覆盖；联系方式只显示「已变更」。
            </p>
            <ol className="flex flex-col gap-3">
              {verifyHistory.map((item) => (
                <li key={item.id} className="rounded-md bg-gray-50 px-3 py-2">
                  <p className="text-xs text-gray-400">
                    {item.occurredAt}
                    {item.actorName ? ` · ${item.actorName}` : ""}
                    {item.source ? ` · 来源：${item.source}` : ""}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1">
                    {item.fields.map((field) => (
                      <li key={field.label} className="text-sm text-gray-800">
                        <span className="font-medium">{field.label}</span>
                        ：
                        <span className="text-gray-500">{field.from}</span>
                        <span className="mx-1">→</span>
                        <span>{field.to}</span>
                        {field.statusText && (
                          <span className="ml-2 text-xs text-gray-400">
                            （{field.statusText}）
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {verifyHistory.length === 0 && (
                <li className="text-sm text-gray-400">该客户暂无画像变更记录</li>
              )}
            </ol>
          </section>

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
                          : item.eventType === "quadrant_changed"
                            ? "bg-amber-500"
                            : item.eventType === "plan_changed"
                              ? "bg-teal-500"
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

          {/* 沟通记录（T06 交付；T10 起表单含「AI 生成摘要」草稿回填） */}
          <InteractionsPanel
            leadId={lead.id}
            leadName={lead.name}
            currentStageName={lead.stageName}
            currentStageSortOrder={currentStageSortOrder}
            stages={stageOptions}
            interactions={interactions}
            dictOptions={dictOptions?.current_system}
            aiPending={aiRunInFlight}
            onAiPendingChange={setAiRunInFlight}
            aiDisabled={isControlGroup}
          />
          {/* 任务区块（T07 交付）：待处理在前，完成弹窗=沟通结果+下一任务单事务 */}
          <TasksPanel
            leadId={lead.id}
            leadName={lead.name}
            stages={stageOptions}
            tasks={tasks}
          />
          {/* AI 面板（T09/T10）：常规组（T14）整体替换为说明卡——无任何 AI 入口
              （UIUX §4.7），服务端 403 同文案兜底；非常规组保持原面板 */}
          {isControlGroup ? (
            <ControlGroupNoticeCard />
          ) : (
            <AiPanelSection
              leadId={lead.id}
              leadName={lead.name}
              initialRuns={aiRuns}
              initialUsage={aiUsage}
              activePromptVersions={activePromptVersions}
              externalPending={aiRunInFlight}
              onPendingChange={setAiRunInFlight}
            />
          )}
        </>
      )}
    </div>
  );
}
