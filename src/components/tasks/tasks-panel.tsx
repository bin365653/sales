"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { NewTaskForm } from "@/components/tasks/new-task-form";
import { TaskCard } from "@/components/tasks/task-card";
import type { TaskView } from "@/components/tasks/task-view";
import type { StageOptionLike } from "@/lib/k4";

// 客户详情任务区块（P5 任务 Tab 的 T07 落地，操作同 P6）：
// 待处理在前（按截止时间升序），已完成/已取消殿后；[新建任务] 打开表单
// （客户固定为当前线索）。展示数据由详情页服务端整形，保存后 refresh 重取。

export interface TasksPanelProps {
  leadId: string;
  leadName: string;
  stages: StageOptionLike[];
  tasks: TaskView[];
}

export function TasksPanel({ leadId, leadName, stages, tasks }: TasksPanelProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleChanged(message: string): void {
    setError(null);
    setNotice(message);
    router.refresh();
  }

  const pendingCount = tasks.filter((task) => task.status === "pending").length;

  return (
    <section id="tasks" className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">
          任务（{pendingCount} 条待处理 / 共 {tasks.length} 条）
        </h2>
        {!creating && (
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setError(null);
              setCreating(true);
            }}
            className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            新建任务
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && !creating && (
        <p className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {creating && (
        <div className="mb-5 rounded-lg border border-blue-100 bg-blue-50/40 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            新建任务 — {leadName}
          </h3>
          <NewTaskForm
            lead={{ id: leadId, name: leadName }}
            onSaved={(message) => {
              setCreating(false);
              handleChanged(message);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            stages={stages}
            onChanged={handleChanged}
          />
        ))}
        {tasks.length === 0 && !creating && (
          <li className="text-sm text-gray-400">
            暂无任务。点击「新建任务」为该客户安排下一步动作，或在沟通表单勾选「同时创建任务」
          </li>
        )}
      </ul>
    </section>
  );
}
