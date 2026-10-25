"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  EFFECTIVE_DEFINITION,
  INTERACTION_CHANNELS,
  INTERACTION_DIRECTIONS,
  interactionUpdateSchema,
} from "@/lib/schemas/interaction";
import { interactionCreateWithTaskSchema } from "@/lib/schemas/task";
import { TASK_TYPES, TASK_TYPE_LABELS } from "@/lib/tasks";
import { resolveStageAdvanceTargetName } from "@/lib/k4";
import { toDateTimeInputValue } from "@/lib/format";

// 沟通记录表单（P5 沟通 Drawer 的 T06 落地，PRD §5.6 全集）。
// 新建与修正共用：修正预填现值、提交 PATCH（M11 留痕由服务端 edit_audit 承担）；
// "本次确认"勾选仅新建提供（一次性人工确认动作，见服务层注释）；
// "同时创建任务"仅新建提供（T07/UIUX P5：与沟通保存同事务，服务端保证原子性）。
// 勾选合格/预约时按 K4 展示阶段推进提示（resolveStageAdvanceTargetName 与
// 服务端 resolveStageAdvance 同规则：目标阶段启用且排序晚于当前才推进）。

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-gray-300 bg-white p-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const SELECT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500";

export interface InteractionStageOption {
  id: string;
  name: string;
  sortOrder: number;
  semanticKey: string | null;
}

export interface InteractionFormInitial {
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
  nextContactAtInput: string | null;
  isQualified: boolean;
  demoBooked: boolean;
}

export interface InteractionFormProps {
  mode: "create" | "edit";
  leadId: string;
  leadName: string;
  /** 修正时必填 */
  interactionId?: string;
  initial: InteractionFormInitial;
  /** 启用中的阶段（含语义锚点），用于 K4 推进提示 */
  stages: InteractionStageOption[];
  currentStageName: string;
  currentStageSortOrder: number;
  onSaved: () => void;
  onCancel: () => void;
}

export function InteractionForm({
  mode,
  leadId,
  leadName,
  interactionId,
  initial,
  stages,
  currentStageName,
  currentStageSortOrder,
  onSaved,
  onCancel,
}: InteractionFormProps) {
  const [connected, setConnected] = useState(initial.connected);
  const [effective, setEffective] = useState(initial.effective);
  const [isQualified, setIsQualified] = useState(initial.isQualified);
  const [demoBooked, setDemoBooked] = useState(initial.demoBooked);
  const [confirmCurrentSystem, setConfirmCurrentSystem] = useState(false);
  const [confirmPurchaseTime, setConfirmPurchaseTime] = useState(false);
  const [withTask, setWithTask] = useState(false);
  const [taskType, setTaskType] = useState<(typeof TASK_TYPES)[number]>("follow_up");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // K4 提示：目标阶段启用且排序晚于当前（与服务端条件一致；停用阶段不在 stages 中）
  const stageHintTarget = useMemo(
    () =>
      resolveStageAdvanceTargetName(stages, currentStageSortOrder, {
        isQualified,
        demoBooked,
      }),
    [stages, currentStageSortOrder, isQualified, demoBooked],
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    const formData = new FormData(event.currentTarget);
    const text = (key: string) => {
      const raw = formData.get(key);
      return typeof raw === "string" ? raw : "";
    };
    const taskDueAt = text("taskDueAt");
    const payload: Record<string, unknown> = {
      occurredAt: text("occurredAt"),
      channel: text("channel"),
      direction: text("direction"),
      connected,
      effective,
      feedback: text("feedback"),
      confirmedPains: text("confirmedPains"),
      currentSystemConfirmed: text("currentSystemConfirmed"),
      purchaseTimeConfirmed: text("purchaseTimeConfirmed"),
      decisionMakerNote: text("decisionMakerNote"),
      objections: text("objections"),
      nextAction: text("nextAction"),
      nextContactAt: text("nextContactAt") || null,
      isQualified,
      demoBooked,
      ...(mode === "create"
        ? {
            confirmCurrentSystem,
            confirmPurchaseTime,
            // "同时创建任务"（T07/UIUX P5）：截止时间缺省取下次联系时间（自动联动）
            createTask: withTask
              ? {
                  type: taskType,
                  title: text("taskTitle") || `${TASK_TYPE_LABELS[taskType]}-${leadName}`,
                  dueAt: taskDueAt || text("nextContactAt"),
                }
              : null,
          }
        : {}),
    };

    const parsed = (
      mode === "create" ? interactionCreateWithTaskSchema : interactionUpdateSchema
    ).safeParse(payload);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        if (key && !errors[key]) {
          errors[key] = issue.message;
        }
      }
      setFieldErrors(errors);
      setSubmitError("请修正表单中标红的字段后重试");
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch(
        mode === "create"
          ? `/api/leads/${leadId}/interactions`
          : `/api/interactions/${interactionId}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (response.ok) {
        onSaved();
        return;
      }
      const failure = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      setSubmitError(
        failure?.error?.code === "version_conflict"
          ? "数据已被其他操作修改，请刷新页面后重试"
          : (failure?.error?.message ?? "保存失败，请稍后再试"),
      );
    } catch {
      setSubmitError("网络异常，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

  const nowInputValue = useMemo(() => toDateTimeInputValue(new Date()), []);

  function fieldError(key: string) {
    return fieldErrors[key] ? (
      <p className="text-xs text-red-600">{fieldErrors[key]}</p>
    ) : null;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {submitError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {submitError}
        </p>
      )}

      <section>
        <h4 className="mb-2 text-sm font-semibold text-gray-900">基本信息</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-occurred-at" className="text-sm font-medium text-gray-700">
              沟通时间 <span className="text-red-500">*</span>
            </label>
            <input
              id="i-occurred-at"
              name="occurredAt"
              type="datetime-local"
              defaultValue={initial.occurredAtInput || nowInputValue}
              className={INPUT_CLASS}
            />
            {fieldError("occurredAt")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-channel" className="text-sm font-medium text-gray-700">
              沟通渠道 <span className="text-red-500">*</span>
            </label>
            <select
              id="i-channel"
              name="channel"
              defaultValue={initial.channel}
              className={SELECT_CLASS}
            >
              {INTERACTION_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-direction" className="text-sm font-medium text-gray-700">
              方向 <span className="text-red-500">*</span>
            </label>
            <select
              id="i-direction"
              name="direction"
              defaultValue={initial.direction}
              className={SELECT_CLASS}
            >
              {INTERACTION_DIRECTIONS.map((direction) => (
                <option key={direction} value={direction}>
                  {DIRECTION_LABELS[direction]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={connected}
            onChange={(event) => {
              setConnected(event.target.checked);
              if (!event.target.checked) {
                setEffective(false);
              }
            }}
            className={CHECKBOX_CLASS}
          />
          已接通
        </label>
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-gray-900">沟通结果</h4>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={effective}
            disabled={!connected}
            onChange={(event) => setEffective(event.target.checked)}
            className={`mt-0.5 ${CHECKBOX_CLASS}`}
          />
          <span>
            <span className="font-medium text-gray-800">有效沟通</span>
            <span
              title={EFFECTIVE_DEFINITION}
              className="ml-1 cursor-help text-xs text-blue-600"
            >
              ⓘ 定义
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-gray-500">
              {EFFECTIVE_DEFINITION}
            </span>
          </span>
        </label>
        {fieldError("effective")}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="i-feedback" className="text-sm font-medium text-gray-700">
              客户实际反馈
            </label>
            <textarea
              id="i-feedback"
              name="feedback"
              rows={3}
              defaultValue={initial.feedback ?? ""}
              className={TEXTAREA_CLASS}
            />
            {fieldError("feedback")}
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="i-pains" className="text-sm font-medium text-gray-700">
              已确认的业务痛点
            </label>
            <textarea
              id="i-pains"
              name="confirmedPains"
              rows={2}
              defaultValue={initial.confirmedPains ?? ""}
              className={TEXTAREA_CLASS}
            />
            {fieldError("confirmedPains")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-system" className="text-sm font-medium text-gray-700">
              客户当前系统
            </label>
            <div className="flex items-center gap-2">
              <input
                id="i-system"
                name="currentSystemConfirmed"
                defaultValue={initial.currentSystemConfirmed ?? ""}
                className={INPUT_CLASS}
              />
              {mode === "create" && (
                <label
                  title="勾选后，画像中「当前使用系统」的核实状态将更新为已确认"
                  className="flex shrink-0 items-center gap-1 text-xs text-gray-600"
                >
                  <input
                    type="checkbox"
                    checked={confirmCurrentSystem}
                    onChange={(event) =>
                      setConfirmCurrentSystem(event.target.checked)
                    }
                    className={CHECKBOX_CLASS}
                  />
                  本次确认
                </label>
              )}
            </div>
            {fieldError("currentSystemConfirmed")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-purchase" className="text-sm font-medium text-gray-700">
              采购时间
            </label>
            <div className="flex items-center gap-2">
              <input
                id="i-purchase"
                name="purchaseTimeConfirmed"
                defaultValue={initial.purchaseTimeConfirmed ?? ""}
                className={INPUT_CLASS}
              />
              {mode === "create" && (
                <label
                  title="勾选后，画像中「采购时间」的核实状态将更新为已确认"
                  className="flex shrink-0 items-center gap-1 text-xs text-gray-600"
                >
                  <input
                    type="checkbox"
                    checked={confirmPurchaseTime}
                    onChange={(event) =>
                      setConfirmPurchaseTime(event.target.checked)
                    }
                    className={CHECKBOX_CLASS}
                  />
                  本次确认
                </label>
              )}
            </div>
            {fieldError("purchaseTimeConfirmed")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-decision" className="text-sm font-medium text-gray-700">
              决策人情况
            </label>
            <input
              id="i-decision"
              name="decisionMakerNote"
              defaultValue={initial.decisionMakerNote ?? ""}
              className={INPUT_CLASS}
            />
            {fieldError("decisionMakerNote")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-objections" className="text-sm font-medium text-gray-700">
              主要异议
            </label>
            <input
              id="i-objections"
              name="objections"
              defaultValue={initial.objections ?? ""}
              className={INPUT_CLASS}
            />
            {fieldError("objections")}
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-gray-900">结论与下一步</h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-next-action" className="text-sm font-medium text-gray-700">
              下一步动作
            </label>
            <input
              id="i-next-action"
              name="nextAction"
              defaultValue={initial.nextAction ?? ""}
              className={INPUT_CLASS}
            />
            {fieldError("nextAction")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="i-next-contact" className="text-sm font-medium text-gray-700">
              下次联系时间
            </label>
            <input
              id="i-next-contact"
              name="nextContactAt"
              type="datetime-local"
              defaultValue={initial.nextContactAtInput ?? ""}
              className={INPUT_CLASS}
            />
            {fieldError("nextContactAt")}
          </div>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={isQualified}
              onChange={(event) => setIsQualified(event.target.checked)}
              className={`mt-0.5 ${CHECKBOX_CLASS}`}
            />
            形成合格线索
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={demoBooked}
              onChange={(event) => setDemoBooked(event.target.checked)}
              className={`mt-0.5 ${CHECKBOX_CLASS}`}
            />
            预约演示/拜访
          </label>
          {stageHintTarget && (
            <p className="rounded-md bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-700">
              保存后将自动把客户阶段推进至「{stageHintTarget}」（当前：
              {currentStageName}），并记录在阶段时间线中；你之后仍可手动调整。
            </p>
          )}
        </div>

        {mode === "create" && (
          <div className="mt-3 rounded-md bg-gray-50 p-3">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={withTask}
                onChange={(event) => setWithTask(event.target.checked)}
                className={CHECKBOX_CLASS}
              />
              同时创建任务
              <span className="text-xs text-gray-400">
                （截止时间缺省取下次联系时间）
              </span>
            </label>
            {withTask && (
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="i-task-type" className="text-sm font-medium text-gray-700">
                    任务类型 <span className="text-red-500">*</span>
                  </label>
                  <select
                    id="i-task-type"
                    value={taskType}
                    onChange={(event) =>
                      setTaskType(event.target.value as (typeof TASK_TYPES)[number])
                    }
                    className={SELECT_CLASS}
                  >
                    {TASK_TYPES.map((item) => (
                      <option key={item} value={item}>
                        {TASK_TYPE_LABELS[item]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="i-task-due" className="text-sm font-medium text-gray-700">
                    任务截止时间 <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="i-task-due"
                    name="taskDueAt"
                    type="datetime-local"
                    className={INPUT_CLASS}
                  />
                  {fieldError("createTask.dueAt")}
                </div>
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <label htmlFor="i-task-title" className="text-sm font-medium text-gray-700">
                    任务标题 <span className="text-red-500">*</span>
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      缺省：{TASK_TYPE_LABELS[taskType]}-{leadName}
                    </span>
                  </label>
                  <input
                    id="i-task-title"
                    name="taskTitle"
                    key={taskType}
                    defaultValue={`${TASK_TYPE_LABELS[taskType]}-${leadName}`}
                    className={INPUT_CLASS}
                  />
                  {fieldError("createTask.title")}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-md bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "保存中…" : mode === "create" ? "保存沟通记录" : "保存修正"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="h-10 rounded-md border border-gray-300 px-5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
        >
          取消
        </button>
      </div>
    </form>
  );
}
