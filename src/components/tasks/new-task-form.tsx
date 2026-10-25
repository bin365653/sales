"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { taskCreateSchema } from "@/lib/schemas/task";
import { TASK_TYPES, TASK_TYPE_LABELS } from "@/lib/tasks";
import type { TaskView } from "@/components/tasks/task-view";

// 新建 / 编辑任务表单（P6 新建任务 + P5 详情页任务区块共用）。
// 新建：必须关联客户（详情页传入固定客户；任务中心经线索搜索选择）；
// 标题自动 = 「类型-客户名」（UIUX P5/P6"标题[自动]"，仍可修改）；
// 编辑：预填现值提交 PATCH（仅待处理任务可编辑，服务端校验）。

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-gray-300 bg-white p-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const SELECT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export interface NewTaskFormProps {
  /** 详情页传入固定客户；任务中心为空 → 线索搜索选择 */
  lead?: { id: string; name: string } | null;
  /** 编辑模式：预填现值，提交 PATCH */
  task?: TaskView;
  onSaved: (message: string) => void;
  onCancel: () => void;
}

interface LeadSearchItem {
  id: string;
  name: string;
}

export function NewTaskForm({ lead, task, onSaved, onCancel }: NewTaskFormProps) {
  const [selectedLead, setSelectedLead] = useState<LeadSearchItem | null>(
    lead ? { id: lead.id, name: lead.name } : null,
  );
  const [keyword, setKeyword] = useState("");
  const [options, setOptions] = useState<LeadSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [type, setType] = useState<(typeof TASK_TYPES)[number]>(
    (task?.type as (typeof TASK_TYPES)[number]) ?? "follow_up",
  );
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 线索搜索（防抖 300ms，UIUX §4.3）；仅未固定客户时启用
  useEffect(() => {
    if (lead || selectedLead) {
      return;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ pageSize: "8" });
        if (keyword.trim()) {
          params.set("keyword", keyword.trim());
        }
        const response = await fetch(`/api/leads?${params.toString()}`);
        if (response.ok) {
          const data = (await response.json()) as { items?: LeadSearchItem[] };
          setOptions(data.items ?? []);
        }
      } catch {
        // 搜索失败不阻塞表单，保留当前选项
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [keyword, lead, selectedLead]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (!lead && !selectedLead && !task) {
      setFieldErrors({ leadId: "请选择关联客户" });
      setSubmitError("请先选择关联客户");
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
    const payload = {
      leadId: task?.lead.id ?? selectedLead?.id ?? lead?.id ?? "",
      type,
      title: text("title"),
      dueAt: text("dueAt"),
      remark: text("remark"),
    };
    const parsed = taskCreateSchema.safeParse(payload);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
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
        task ? `/api/tasks/${task.id}` : "/api/tasks",
        {
          method: task ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            task
              ? { type: parsed.data.type, title: parsed.data.title, dueAt: parsed.data.dueAt, remark: parsed.data.remark ?? null }
              : parsed.data,
          ),
        },
      );
      if (response.ok) {
        onSaved(task ? "任务已更新" : "任务已创建");
        return;
      }
      const failure = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      setSubmitError(failure?.error?.message ?? "保存失败，请稍后再试");
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

  const titleDefault = task
    ? task.title
    : `${TASK_TYPE_LABELS[type]}-${selectedLead?.name ?? lead?.name ?? ""}`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {submitError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {submitError}
        </p>
      )}

      {!lead && !task && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="nt-lead" className="text-sm font-medium text-gray-700">
            关联客户 <span className="text-red-500">*</span>
          </label>
          {selectedLead ? (
            <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
              <span className="font-medium text-blue-800">{selectedLead.name}</span>
              <button
                type="button"
                onClick={() => {
                  setSelectedLead(null);
                  setKeyword("");
                  setOptions([]);
                }}
                className="text-xs text-blue-600 hover:text-blue-700"
              >
                重选
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <input
                id="nt-lead"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="输入客户名称 / 联系人 / 电话搜索"
                className={INPUT_CLASS}
              />
              {fieldError("leadId")}
              <ul className="flex max-h-48 flex-col overflow-y-auto rounded-md border border-gray-200">
                {searching && (
                  <li className="px-3 py-2 text-sm text-gray-400">搜索中…</li>
                )}
                {!searching && options.length === 0 && (
                  <li className="px-3 py-2 text-sm text-gray-400">
                    没有匹配的客户，请调整关键词
                  </li>
                )}
                {options.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedLead(option)}
                      className="w-full px-3 py-2 text-left text-sm text-gray-800 transition hover:bg-blue-50"
                    >
                      {option.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="nt-type" className="text-sm font-medium text-gray-700">
            任务类型 <span className="text-red-500">*</span>
          </label>
          <select
            id="nt-type"
            value={type}
            onChange={(event) => setType(event.target.value as (typeof TASK_TYPES)[number])}
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
          <label htmlFor="nt-due" className="text-sm font-medium text-gray-700">
            截止时间 <span className="text-red-500">*</span>
          </label>
          <input
            id="nt-due"
            name="dueAt"
            type="datetime-local"
            defaultValue={task?.dueAtInput ?? ""}
            className={INPUT_CLASS}
          />
          {fieldError("dueAt")}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="nt-title" className="text-sm font-medium text-gray-700">
          任务标题 <span className="text-red-500">*</span>
        </label>
        <input
          id="nt-title"
          name="title"
          key={`${type}-${selectedLead?.id ?? lead?.id ?? "edit"}`}
          defaultValue={titleDefault}
          className={INPUT_CLASS}
        />
        {fieldError("title")}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="nt-remark" className="text-sm font-medium text-gray-700">
          备注
        </label>
        <textarea
          id="nt-remark"
          name="remark"
          rows={2}
          defaultValue={task?.remark ?? ""}
          className={TEXTAREA_CLASS}
        />
        {fieldError("remark")}
      </div>

      <div className="flex items-center gap-3 border-t border-gray-100 pt-4">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-md bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "保存中…" : task ? "保存修改" : "创建任务"}
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
