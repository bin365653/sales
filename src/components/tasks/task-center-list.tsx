"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { NewTaskForm } from "@/components/tasks/new-task-form";
import { TaskCard } from "@/components/tasks/task-card";
import type { TaskView } from "@/components/tasks/task-view";
import type { StageOptionLike } from "@/lib/k4";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/tasks";

// P6 任务中心列表（T07）：新建（线索搜索）+ 任务卡列表 + 分页。
// 视图 Tab（今日/逾期/全部）、状态与来源筛选由服务端页面渲染为链接
// （禁 JS 可用），本组件承担卡片操作（完成/取消/编辑）、新建表单与
// [立即生成]（V2.0-T06/T07 管理员手动兜底）。

export interface TaskCenterListProps {
  rows: TaskView[];
  total: number;
  page: number;
  pageSize: number;
  view: string;
  status: string;
  sourceType: string;
  counts: { today: number; overdue: number };
  stages: StageOptionLike[];
}

function buildHref(
  view: string,
  status: string,
  sourceType: string,
  page: number,
  pageSize: number,
): string {
  const params = new URLSearchParams({
    view,
    status,
    sourceType,
    page: String(page),
    pageSize: String(pageSize),
  });
  return `/tasks?${params.toString()}`;
}

export function TaskCenterList({
  rows,
  total,
  page,
  pageSize,
  view,
  status,
  sourceType,
  counts,
  stages,
}: TaskCenterListProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleChanged(message: string): void {
    setError(null);
    setNotice(message);
    router.refresh();
  }

  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-500">
          共 {total} 条任务
          {view === "today" && counts.overdue > 0
            ? ` · 其中逾期 ${counts.overdue} 条已置顶`
            : ""}
        </p>
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
            ＋ 新建任务
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && !creating && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {creating && (
        <div className="rounded-lg border border-blue-100 bg-blue-50/40 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">新建任务</h3>
          <NewTaskForm
            onSaved={(message) => {
              setCreating(false);
              handleChanged(message);
            }}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {rows.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            stages={stages}
            showLead
            onChanged={handleChanged}
          />
        ))}
        {rows.length === 0 && !creating && (
          <li className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-400">
            {view === "today"
              ? "今天没有待处理任务"
              : view === "overdue"
                ? "没有逾期任务，跟进节奏很好"
                : status !== "all"
                  ? `没有${TASK_STATUS_LABELS[status as (typeof TASK_STATUSES)[number]] ?? ""}任务`
                  : "还没有任务。点击「新建任务」安排下一步动作"}
          </li>
        )}
      </ul>

      {totalPages > 1 && (
        <nav className="flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link
              href={buildHref(view, status, sourceType, page - 1, pageSize)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50"
            >
              ‹ 上一页
            </Link>
          ) : (
            <span />
          )}
          <span className="text-gray-500">
            第 {page} / {totalPages} 页
          </span>
          {page < totalPages ? (
            <Link
              href={buildHref(view, status, sourceType, page + 1, pageSize)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-gray-600 transition hover:bg-gray-50"
            >
              下一页 ›
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
