"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  INTERACTION_FIELD_LABELS,
} from "@/lib/schemas/interaction";
import type { InteractionChannel, InteractionDirection } from "@/lib/schemas/interaction";
import { toShanghaiDateTimeString } from "@/lib/format";
import {
  InteractionForm,
  InteractionStageOption,
} from "@/components/leads/interaction-form";

// 沟通记录区块（P5 沟通 Tab 的 T06 落地）：
// 时间线列表（渠道/方向、接通/有效徽章、反馈摘要、合格/预约标记、
// "已修正"标记可展开修改审计 M11）+ [记录沟通] / [修正] 打开共用表单。
// 展示数据由详情页服务端整形（InteractionView），保存后 router.refresh 重新获取。

export interface InteractionAuditEntry {
  at: string;
  by: string;
  byName: string | null;
  changed: Record<string, { from: unknown; to: unknown }>;
}

export interface InteractionView {
  id: string;
  occurredAtDisplay: string;
  occurredAtInput: string;
  channel: string;
  direction: string;
  connected: boolean;
  effective: boolean;
  feedback: string | null;
  confirmedPains: string | null;
  currentSystemConfirmed: string | null;
  purchaseTimeConfirmed: string | null;
  decisionMakerNote: string | null;
  objections: string | null;
  nextAction: string | null;
  nextContactAtDisplay: string | null;
  nextContactAtInput: string | null;
  isQualified: boolean;
  demoBooked: boolean;
  /** AI 摘要草稿来源 run（T10）：非空 = 该记录确认自 AI 草稿（与人工输入可区分） */
  aiRunId: string | null;
  userName: string | null;
  editAudit: InteractionAuditEntry[];
}

export interface InteractionsPanelProps {
  leadId: string;
  leadName: string;
  currentStageName: string;
  currentStageSortOrder: number;
  stages: InteractionStageOption[];
  interactions: InteractionView[];
  /** 详情页 AI 面板存在 pending run 时禁用表单摘要发起（§4.7 互斥，T10） */
  aiPending?: boolean;
  /** 表单摘要 run 生命周期通知（与 AI 面板互斥） */
  onAiPendingChange?: (pending: boolean) => void;
  /** 实验常规组（T14）：隐藏表单「AI 生成摘要」入口（服务端 403 兜底） */
  aiDisabled?: boolean;
}

function auditValueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "（空）";
  }
  if (typeof value === "boolean") {
    return value ? "是" : "否";
  }
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) {
      return toShanghaiDateTimeString(new Date(value));
    }
    if (value in CHANNEL_LABELS) {
      return CHANNEL_LABELS[value as InteractionChannel];
    }
    if (value in DIRECTION_LABELS) {
      return DIRECTION_LABELS[value as InteractionDirection];
    }
    return value;
  }
  return String(value);
}

function badge(text: string, className: string): ReactNode {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${className}`}>{text}</span>
  );
}

export function InteractionsPanel({
  leadId,
  leadName,
  currentStageName,
  currentStageSortOrder,
  stages,
  interactions,
  aiPending = false,
  onAiPendingChange,
  aiDisabled = false,
}: InteractionsPanelProps) {
  const router = useRouter();
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [auditOpenId, setAuditOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = formMode === "edit" ? interactions.find((item) => item.id === editingId) ?? null : null;

  function closeForm(): void {
    setFormMode(null);
    setEditingId(null);
  }

  function handleSaved(): void {
    closeForm();
    setError(null);
    setNotice("沟通记录已保存");
    router.refresh();
  }

  return (
    <section id="interactions" className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          沟通记录（{interactions.length} 条）
        </h2>
        {formMode === null && (
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setError(null);
              setFormMode("create");
            }}
            className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            记录沟通
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && formMode === null && (
        <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {formMode === "create" && (
        <div className="mb-5 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            记录沟通 — {leadName}
          </h3>
          <InteractionForm
            mode="create"
            leadId={leadId}
            leadName={leadName}
            stages={stages}
            currentStageName={currentStageName}
            currentStageSortOrder={currentStageSortOrder}
            aiPending={aiPending}
            onAiPendingChange={onAiPendingChange}
            aiDisabled={aiDisabled}
            initial={{
              occurredAtInput: "",
              channel: "phone",
              direction: "outbound",
              connected: true,
              effective: false,
              feedback: null,
              confirmedPains: null,
              currentSystemConfirmed: null,
              purchaseTimeConfirmed: null,
              decisionMakerNote: null,
              objections: null,
              nextAction: null,
              nextContactAtInput: null,
              isQualified: false,
              demoBooked: false,
            }}
            onSaved={handleSaved}
            onCancel={closeForm}
          />
        </div>
      )}

      {formMode === "edit" && editing && (
        <div className="mb-5 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            修正沟通记录 — {editing.occurredAtDisplay}
          </h3>
          <InteractionForm
            mode="edit"
            leadId={leadId}
            leadName={leadName}
            interactionId={editing.id}
            stages={stages}
            currentStageName={currentStageName}
            currentStageSortOrder={currentStageSortOrder}
            initial={{
              occurredAtInput: editing.occurredAtInput,
              channel: editing.channel,
              direction: editing.direction,
              connected: editing.connected,
              effective: editing.effective,
              feedback: editing.feedback,
              confirmedPains: editing.confirmedPains,
              currentSystemConfirmed: editing.currentSystemConfirmed,
              purchaseTimeConfirmed: editing.purchaseTimeConfirmed,
              decisionMakerNote: editing.decisionMakerNote,
              objections: editing.objections,
              nextAction: editing.nextAction,
              nextContactAtInput: editing.nextContactAtInput,
              isQualified: editing.isQualified,
              demoBooked: editing.demoBooked,
            }}
            onSaved={handleSaved}
            onCancel={closeForm}
          />
        </div>
      )}

      <ol className="flex flex-col">
        {interactions.map((item) => {
          const auditCount = item.editAudit.length;
          return (
            <li key={item.id} className="border-b border-gray-100 py-3 first:pt-0 last:border-b-0">
              <div className="flex flex-wrap items-center gap-2">
                {badge(
                  `${CHANNEL_LABELS[item.channel as InteractionChannel] ?? item.channel} · ${DIRECTION_LABELS[item.direction as InteractionDirection] ?? item.direction}`,
                  "bg-gray-100 text-gray-600",
                )}
                {item.effective
                  ? badge("有效沟通", "bg-emerald-50 text-emerald-700")
                  : badge("未标记有效", "bg-gray-50 text-gray-400")}
                {item.isQualified && badge("合格线索", "bg-blue-50 text-blue-700")}
                {item.demoBooked && badge("预约演示", "bg-violet-50 text-violet-700")}
                {/* AI 草稿确认来源（T10）：原始输出与最终记录可区分（§7.1 摘要审核流） */}
                {item.aiRunId &&
                  badge("✦ AI 草稿确认", "border border-dashed border-violet-400 text-violet-700")}
                {auditCount > 0 &&
                  badge(`已修正 ${auditCount} 次`, "bg-amber-50 text-amber-700")}
                <span className="ml-auto flex items-center gap-2">
                  <span className="text-xs text-gray-400">
                    {item.occurredAtDisplay}
                    {item.userName ? ` · ${item.userName}` : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setFormMode("edit");
                      setEditingId(item.id);
                    }}
                    disabled={formMode !== null}
                    className="text-xs text-blue-600 hover:text-blue-700 disabled:text-gray-300"
                  >
                    修正
                  </button>
                </span>
              </div>
              {item.feedback && (
                <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-sm text-gray-800">
                  {item.feedback}
                </p>
              )}
              {(item.nextAction || item.nextContactAtDisplay) && (
                <p className="mt-1 text-xs text-gray-500">
                  下一步：
                  {item.nextAction ?? "—"}
                  {item.nextContactAtDisplay
                    ? `（下次联系 ${item.nextContactAtDisplay}）`
                    : ""}
                </p>
              )}
              {auditCount > 0 && (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setAuditOpenId((prev) => (prev === item.id ? null : item.id))
                    }
                    className="text-xs text-amber-600 hover:text-amber-700"
                  >
                    {auditOpenId === item.id ? "收起修改审计" : "查看修改审计"}
                  </button>
                  {auditOpenId === item.id && (
                    <ul className="mt-2 flex flex-col gap-2 rounded-md bg-amber-50/60 p-2.5">
                      {item.editAudit.map((entry, entryIndex) => (
                        <li key={entryIndex} className="text-xs text-gray-600">
                          <p className="text-gray-500">
                            {toShanghaiDateTimeString(new Date(entry.at))}
                            {entry.byName ? ` · ${entry.byName}` : ""}
                          </p>
                          <ul className="mt-1 flex flex-col gap-0.5">
                            {Object.entries(entry.changed).map(([field, diff]) => (
                              <li key={field}>
                                {INTERACTION_FIELD_LABELS[field] ?? field}：
                                {auditValueText(diff.from)} → {auditValueText(diff.to)}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {interactions.length === 0 && (
          <li className="text-sm text-gray-400">
            暂无沟通记录，完成首次沟通后点击「记录沟通」填写
          </li>
        )}
      </ol>
    </section>
  );
}
