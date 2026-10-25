"use client";

import Link from "next/link";
import { useState } from "react";
import {
  TASK_STATUS_BADGE_CLASS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  TaskStatusValue,
} from "@/lib/tasks";
import { CompleteTaskForm } from "@/components/tasks/complete-task-form";
import { NewTaskForm } from "@/components/tasks/new-task-form";
import { taskDueDisplay, type TaskView } from "@/components/tasks/task-view";
import type { StageOptionLike } from "@/lib/k4";

// 任务卡（UIUX P6 卡片样式的 T07 落地，P5 任务区块与 P6 任务中心共用）：
// 类型徽章 + 标题 + 状态徽章 + 截止时间（今日"今天 HH:mm"、逾期红字"已逾期 X 天"、
// 逾期整卡左侧 3px 红条）；待处理任务可 完成（弹窗式表单：沟通结果+下一任务）/
// 取消（简单确认，C11 只可取消不可删）/ 编辑；已完成显示完成时间与沟通记录链接。

export interface TaskCardProps {
  task: TaskView;
  /** 启用中的阶段（含语义锚点），完成表单 K4 提示用 */
  stages: StageOptionLike[];
  /** 是否展示客户入口（任务中心展示；详情页自身不展示） */
  showLead?: boolean;
  onChanged: (message: string) => void;
}

export function TaskCard({ task, stages, showLead = false, onChanged }: TaskCardProps) {
  const [mode, setMode] = useState<"view" | "complete" | "edit">("view");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function cancelTask(): Promise<void> {
    if (busy) {
      return;
    }
    const confirmed = window.confirm(
      `确定取消任务「${task.title}」吗？取消后不可恢复（任务只能取消、不能删除）。`,
    );
    if (!confirmed) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "canceled" }),
      });
      if (response.ok) {
        onChanged("任务已取消");
        return;
      }
      const payload = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string } }
        | null;
      setError(
        payload?.error?.code === "task_conflict"
          ? "该任务刚被其他窗口处理，请刷新页面"
          : (payload?.error?.message ?? "取消失败，请稍后再试"),
      );
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  const statusBadge =
    TASK_STATUS_BADGE_CLASS[task.status as TaskStatusValue] ?? "bg-gray-100 text-gray-500";

  return (
    <li
      className={`rounded-lg border border-gray-200 bg-white p-3 md:p-4 ${
        task.overdue ? "border-l-[3px] border-l-red-500" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
          {TASK_TYPE_LABELS[task.type as keyof typeof TASK_TYPE_LABELS] ?? task.type}
        </span>
        <span className="text-sm font-medium text-gray-900">{task.title}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs ${statusBadge}`}>
          {TASK_STATUS_LABELS[task.status as TaskStatusValue] ?? task.status}
        </span>
        <span
          className={`ml-auto text-xs ${
            task.overdue ? "font-medium text-red-600" : "text-gray-500"
          }`}
          title={`截止时间：${task.dueAtDisplay}`}
        >
          {task.overdue ? "⚠ " : "⏰ "}
          {taskDueDisplay(task)}
        </span>
      </div>

      {showLead && (
        <p className="mt-1 text-xs text-gray-500">
          客户：
          <Link
            href={`/leads/${task.lead.id}`}
            className="text-blue-600 hover:text-blue-700"
          >
            {task.lead.name}
          </Link>
        </p>
      )}
      {task.remark && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{task.remark}</p>
      )}
      {task.status === "done" && (
        <p className="mt-1 text-xs text-gray-500">
          完成于 {task.completedAtDisplay ?? "—"}
          {task.interactionId && (
            <>
              {" · "}
              <Link
                href={`/leads/${task.lead.id}#interactions`}
                className="text-blue-600 hover:text-blue-700"
              >
                查看沟通记录
              </Link>
            </>
          )}
        </p>
      )}
      {task.status === "canceled" && (
        <p className="mt-1 text-xs text-gray-400">该任务已取消</p>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {mode === "view" && task.status === "pending" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("complete");
            }}
            disabled={busy}
            className="h-8 rounded-md bg-blue-600 px-3 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
          >
            完成任务
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("edit");
            }}
            disabled={busy}
            className="h-8 rounded-md border border-gray-300 px-3 text-xs text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
          >
            编辑
          </button>
          <button
            type="button"
            onClick={cancelTask}
            disabled={busy}
            className="h-8 rounded-md border border-gray-300 px-3 text-xs text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
          >
            取消
          </button>
          {showLead && (
            <Link
              href={`/leads/${task.lead.id}`}
              className="h-8 rounded-md border border-gray-300 px-3 text-xs leading-8 text-gray-600 transition hover:bg-gray-50"
            >
              详情→
            </Link>
          )}
        </div>
      )}

      {mode === "complete" && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/40 p-3 md:p-4">
          <h4 className="mb-3 text-sm font-semibold text-gray-900">
            完成任务：{task.title}
          </h4>
          <CompleteTaskForm
            task={task}
            stages={stages}
            onSaved={(message) => {
              setMode("view");
              onChanged(message);
            }}
            onCancel={() => setMode("view")}
          />
        </div>
      )}

      {mode === "edit" && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/40 p-3 md:p-4">
          <h4 className="mb-3 text-sm font-semibold text-gray-900">编辑任务</h4>
          <NewTaskForm
            task={task}
            onSaved={(message) => {
              setMode("view");
              onChanged(message);
            }}
            onCancel={() => setMode("view")}
          />
        </div>
      )}
    </li>
  );
}
