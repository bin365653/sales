"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  CHANNEL_LABELS,
  DIRECTION_LABELS,
  EFFECTIVE_DEFINITION,
  INTERACTION_CHANNELS,
  INTERACTION_DIRECTIONS,
} from "@/lib/schemas/interaction";
import { taskCompleteSchema } from "@/lib/schemas/task";
import { TASK_TYPES, TASK_TYPE_LABELS } from "@/lib/tasks";
import { resolveStageAdvanceTargetName } from "@/lib/k4";
import type { StageOptionLike } from "@/lib/k4";
import { toDateTimeInputValue } from "@/lib/format";
import type { TaskView } from "@/components/tasks/task-view";

// 完成任务表单（UIUX P6 完成任务弹窗的 T07 落地）：
// ① 沟通结果（必填：方向/是否接通/是否有效；其余为沟通表单精简版）——
//    校验复用 interactionCreateSchema（taskCompleteSchema），文案与沟通保存一字不差；
// ② 下一步（可选）：创建下一步任务（类型/标题自动/截止时间）或暂不创建；
// 一个事务完成：任务 done（completed_at）+ 沟通记录 + 下一任务 + K4 阶段联动
// （服务端 completeTaskWithInteraction）。完成后由父组件刷新并提示。

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-gray-300 bg-white p-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const SELECT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const CHECKBOX_CLASS =
  "h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500";

export interface CompleteTaskFormProps {
  task: TaskView;
  /** 启用中的阶段（含语义锚点），用于 K4 推进提示 */
  stages: StageOptionLike[];
  onSaved: (message: string) => void;
  onCancel: () => void;
}

export function CompleteTaskForm({ task, stages, onSaved, onCancel }: CompleteTaskFormProps) {
  const [connected, setConnected] = useState(true);
  const [effective, setEffective] = useState(false);
  const [isQualified, setIsQualified] = useState(false);
  const [demoBooked, setDemoBooked] = useState(false);
  const [createNext, setCreateNext] = useState(false);
  const [nextType, setNextType] = useState<(typeof TASK_TYPES)[number]>("follow_up");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nowInputValue = useMemo(() => toDateTimeInputValue(new Date()), []);
  const nextTitleDefault = `${TASK_TYPE_LABELS[nextType]}-${task.lead.name}`;

  const stageHintTarget = useMemo(
    () =>
      resolveStageAdvanceTargetName(stages, task.lead.stageSortOrder, {
        isQualified,
        demoBooked,
      }),
    [stages, task.lead.stageSortOrder, isQualified, demoBooked],
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
    const nextTaskDueAt = text("nextTaskDueAt");
    const payload = {
      interaction: {
        occurredAt: text("occurredAt") || nowInputValue,
        channel: text("channel"),
        direction: text("direction"),
        connected,
        effective,
        feedback: text("feedback"),
        nextAction: text("nextAction"),
        nextContactAt: text("nextContactAt") || null,
        isQualified,
        demoBooked,
      },
      nextTask: createNext
        ? {
            type: nextType,
            title: text("nextTaskTitle") || nextTitleDefault,
            dueAt: nextTaskDueAt,
          }
        : null,
    };

    const parsed = taskCompleteSchema.safeParse(payload);
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
      const response = await fetch(`/api/tasks/${task.id}/complete-with-interaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (response.ok) {
        const result = (await response.json()) as {
          stageAdvanced?: { toStageId: string } | null;
          nextTask?: { title: string } | null;
        };
        const parts = ["任务已完成"];
        if (result.nextTask) {
          parts.push(`已创建下一任务：${result.nextTask.title}`);
        }
        if (result.stageAdvanced) {
          parts.push("客户阶段已联动推进");
        }
        onSaved(parts.join("，"));
        return;
      }
      const failure = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      setSubmitError(
        failure?.error?.code === "task_conflict"
          ? "该任务刚被其他窗口处理，请刷新页面"
          : (failure?.error?.message ?? "保存失败，请稍后再试"),
      );
    } catch {
      setSubmitError("网络异常，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  }

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
        <h4 className="mb-2 text-sm font-semibold text-gray-900">
          ① 沟通结果 <span className="text-xs font-normal text-gray-500">（与沟通记录同口径，必填：方向/是否接通/是否有效）</span>
        </h4>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`c-occurred-${task.id}`} className="text-sm font-medium text-gray-700">
              沟通时间 <span className="text-red-500">*</span>
            </label>
            <input
              id={`c-occurred-${task.id}`}
              name="occurredAt"
              type="datetime-local"
              defaultValue={nowInputValue}
              className={INPUT_CLASS}
            />
            {fieldError("interaction.occurredAt")}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`c-channel-${task.id}`} className="text-sm font-medium text-gray-700">
              沟通渠道 <span className="text-red-500">*</span>
            </label>
            <select
              id={`c-channel-${task.id}`}
              name="channel"
              defaultValue="phone"
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
            <label htmlFor={`c-direction-${task.id}`} className="text-sm font-medium text-gray-700">
              方向 <span className="text-red-500">*</span>
            </label>
            <select
              id={`c-direction-${task.id}`}
              name="direction"
              defaultValue="outbound"
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
        <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
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
        {fieldError("interaction.effective")}
        <div className="mt-3 grid grid-cols-1 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`c-feedback-${task.id}`} className="text-sm font-medium text-gray-700">
              客户实际反馈
            </label>
            <textarea
              id={`c-feedback-${task.id}`}
              name="feedback"
              rows={2}
              className={TEXTAREA_CLASS}
            />
            {fieldError("interaction.feedback")}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`c-next-action-${task.id}`} className="text-sm font-medium text-gray-700">
                下一步动作
              </label>
              <input
                id={`c-next-action-${task.id}`}
                name="nextAction"
                className={INPUT_CLASS}
              />
              {fieldError("interaction.nextAction")}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`c-next-contact-${task.id}`} className="text-sm font-medium text-gray-700">
                下次联系时间
              </label>
              <input
                id={`c-next-contact-${task.id}`}
                name="nextContactAt"
                type="datetime-local"
                className={INPUT_CLASS}
              />
              {fieldError("interaction.nextContactAt")}
            </div>
          </div>
          <div className="flex flex-col gap-2">
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
                {task.lead.stageName}），并记录在阶段时间线中；你之后仍可手动调整。
              </p>
            )}
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-sm font-semibold text-gray-900">② 下一步</h4>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="nextChoice"
              checked={!createNext}
              onChange={() => setCreateNext(false)}
              className={CHECKBOX_CLASS}
            />
            暂不创建
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="radio"
              name="nextChoice"
              checked={createNext}
              onChange={() => setCreateNext(true)}
              className={CHECKBOX_CLASS}
            />
            创建下一步任务
          </label>
        </div>
        {createNext && (
          <div className="mt-3 grid grid-cols-1 gap-4 rounded-md bg-gray-50 p-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`c-nt-type-${task.id}`} className="text-sm font-medium text-gray-700">
                类型 <span className="text-red-500">*</span>
              </label>
              <select
                id={`c-nt-type-${task.id}`}
                value={nextType}
                onChange={(event) => setNextType(event.target.value as (typeof TASK_TYPES)[number])}
                className={SELECT_CLASS}
              >
                {TASK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TASK_TYPE_LABELS[type]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`c-nt-title-${task.id}`} className="text-sm font-medium text-gray-700">
                标题 <span className="text-red-500">*</span>
              </label>
              <input
                id={`c-nt-title-${task.id}`}
                name="nextTaskTitle"
                defaultValue={nextTitleDefault}
                key={nextType}
                className={INPUT_CLASS}
              />
              {fieldError("nextTask.title")}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`c-nt-due-${task.id}`} className="text-sm font-medium text-gray-700">
                截止时间 <span className="text-red-500">*</span>
              </label>
              <input
                id={`c-nt-due-${task.id}`}
                name="nextTaskDueAt"
                type="datetime-local"
                className={INPUT_CLASS}
              />
              {fieldError("nextTask.dueAt")}
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-md bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "保存中…" : "保存并完成"}
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
