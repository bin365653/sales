"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// 字段配置（T15，UIUX P9 / C12）：内置字段（启停 toggle；类型/必填只读）+
// 自定义字段（新建/编辑/停用；key 系统自动生成且不可变、type 不可变）。
// 固定提示：自定义字段参与新建/编辑/详情/导入/导出，V1.0 不参与筛选与统计。

export interface FieldDefItem {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "date" | "single_select";
  options: unknown;
  validation: unknown;
  isBuiltin: boolean;
  isActive: boolean;
}

const FIELD_TYPE_LABELS: Record<FieldDefItem["type"], string> = {
  text: "文本",
  number: "数字",
  date: "日期",
  single_select: "单选",
};

const INPUT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

/** 自动生成稳定内部 ID（UIUX P9：key 由系统生成，管理员不手输） */
function generateFieldKey(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `custom_${hex}`;
}

interface OptionRow {
  value: string;
  label: string;
}

function parseOptions(options: unknown): OptionRow[] {
  if (!Array.isArray(options)) {
    return [];
  }
  return options
    .filter(
      (item): item is { value: string; label: string } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { value?: unknown }).value === "string" &&
        typeof (item as { label?: unknown }).label === "string",
    )
    .map((item) => ({ value: item.value, label: item.label }));
}

interface ValidationRule {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

function parseValidation(validation: unknown): ValidationRule {
  if (typeof validation !== "object" || validation === null) {
    return {};
  }
  return validation as ValidationRule;
}

export function FieldsManager({ fields }: { fields: FieldDefItem[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const builtinFields = fields.filter((field) => field.isBuiltin);
  const customFields = fields.filter((field) => !field.isBuiltin);

  async function toggleActive(field: FieldDefItem): Promise<void> {
    setError(null);
    setNotice(null);
    const response = await fetch(`/api/settings/fields/${field.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !field.isActive }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    if (!response.ok) {
      setError(payload?.error?.message ?? "保存失败，请稍后再试");
      return;
    }
    setNotice(
      field.isActive
        ? `字段「${field.label}」已停用；仍有值的字段在详情页保留展示并标注。`
        : `字段「${field.label}」已启用。`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-gray-500">
        内置字段为线索表物理列（类型/必填规则由系统 Schema 固定，仅可停用）；
        自定义字段参与新建/编辑/详情/导入/导出，V1.0 不参与筛选与统计（C12）。
      </p>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {/* 内置字段 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-900">内置字段</h2>
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">字段名称</th>
                <th className="px-3 py-2 font-medium">标识</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {builtinFields.map((field) => (
                <tr key={field.id} className="border-b border-gray-50 last:border-b-0">
                  <td className="px-3 py-2 text-gray-900">{field.label}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{field.key}</td>
                  <td className="px-3 py-2 text-gray-500">
                    {FIELD_TYPE_LABELS[field.type]}
                  </td>
                  <td className="px-3 py-2">
                    {field.isActive ? (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                        启用中
                      </span>
                    ) : (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                        已停用
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void toggleActive(field)}
                      className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50"
                    >
                      {field.isActive ? "停用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 自定义字段 */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">自定义字段</h2>
          <button
            type="button"
            onClick={() => setCreating((prev) => !prev)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            {creating ? "收起新建表单" : "＋ 新建字段"}
          </button>
        </div>
        {creating && (
          <FieldDefForm
            onCancel={() => setCreating(false)}
            onDone={async (message) => {
              setCreating(false);
              setNotice(message);
              router.refresh();
            }}
          />
        )}
        {customFields.length === 0 && !creating ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
            尚无自定义字段。新建后可用于新建/编辑客户与导入导出。
          </div>
        ) : (
          customFields.length > 0 && (
            <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200 bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-3 py-2 font-medium">字段名称</th>
                    <th className="px-3 py-2 font-medium">标识</th>
                    <th className="px-3 py-2 font-medium">类型</th>
                    <th className="px-3 py-2 font-medium">校验规则</th>
                    <th className="px-3 py-2 font-medium">状态</th>
                    <th className="px-3 py-2 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {customFields.map((field) => (
                    <tr key={field.id} className="border-b border-gray-50 last:border-b-0">
                      <td className="px-3 py-2 text-gray-900">{field.label}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{field.key}</td>
                      <td className="px-3 py-2 text-gray-500">
                        {FIELD_TYPE_LABELS[field.type]}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-500">
                        {describeValidation(field)}
                      </td>
                      <td className="px-3 py-2">
                        {field.isActive ? (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700">
                            启用中
                          </span>
                        ) : (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                            已停用
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setEditingId(editingId === field.id ? null : field.id)
                            }
                            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50"
                          >
                            {editingId === field.id ? "收起" : "编辑"}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleActive(field)}
                            className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 transition hover:bg-gray-50"
                          >
                            {field.isActive ? "停用" : "启用"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {customFields.map((field) =>
          editingId === field.id ? (
            <div key={`edit-${field.id}`} className="mt-2">
              <FieldDefForm
                field={field}
                onCancel={() => setEditingId(null)}
                onDone={async (message) => {
                  setEditingId(null);
                  setNotice(message);
                  router.refresh();
                }}
              />
            </div>
          ) : null,
        )}
      </section>
    </div>
  );
}

function describeValidation(field: FieldDefItem): string {
  const rule = parseValidation(field.validation);
  const parts: string[] = [];
  if (rule.required) {
    parts.push("必填");
  }
  if (rule.minLength !== undefined || rule.maxLength !== undefined) {
    parts.push(`长度 ${rule.minLength ?? 0}–${rule.maxLength ?? "∞"}`);
  }
  if (rule.min !== undefined || rule.max !== undefined) {
    parts.push(`数值 ${rule.min ?? "-∞"}–${rule.max ?? "∞"}`);
  }
  if (rule.pattern) {
    parts.push(`正则 ${rule.pattern}`);
  }
  const options = parseOptions(field.options);
  if (field.type === "single_select" && options.length > 0) {
    parts.push(`选项：${options.map((option) => option.label).join("、")}`);
  }
  return parts.length > 0 ? parts.join("；") : "—";
}

function FieldDefForm({
  field,
  onDone,
  onCancel,
}: {
  field?: FieldDefItem;
  onDone: (message: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const isEdit = field !== undefined;
  const existingOptions = field ? parseOptions(field.options) : [];
  const existingValidation = field ? parseValidation(field.validation) : {};
  const [key] = useState(field?.key ?? generateFieldKey());
  const [label, setLabel] = useState(field?.label ?? "");
  const [type, setType] = useState<FieldDefItem["type"]>(field?.type ?? "text");
  const [optionRows, setOptionRows] = useState<OptionRow[]>(
    existingOptions.length > 0 ? existingOptions : [{ value: "", label: "" }],
  );
  const [required, setRequired] = useState(existingValidation.required ?? false);
  const [minLength, setMinLength] = useState(
    existingValidation.minLength?.toString() ?? "",
  );
  const [maxLength, setMaxLength] = useState(
    existingValidation.maxLength?.toString() ?? "",
  );
  const [min, setMin] = useState(existingValidation.min?.toString() ?? "");
  const [max, setMax] = useState(existingValidation.max?.toString() ?? "");
  const [pattern, setPattern] = useState(existingValidation.pattern ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setError(null);
    const validation: ValidationRule = {};
    if (required) {
      validation.required = true;
    }
    if (minLength.trim() !== "") {
      validation.minLength = Number(minLength);
    }
    if (maxLength.trim() !== "") {
      validation.maxLength = Number(maxLength);
    }
    if (min.trim() !== "") {
      validation.min = Number(min);
    }
    if (max.trim() !== "") {
      validation.max = Number(max);
    }
    if (pattern.trim() !== "") {
      validation.pattern = pattern.trim();
    }
    const body: Record<string, unknown> = { label: label.trim() };
    if (!isEdit) {
      body.key = key;
      body.type = type;
    } else {
      // 类型不可变：仅单选字段允许维护选项
    }
    if (type === "single_select") {
      body.options = optionRows
        .map((row) => ({ value: row.value.trim(), label: row.label.trim() }))
        .filter((row) => row.value !== "" && row.label !== "");
    }
    if (Object.keys(validation).length > 0) {
      body.validation = validation;
    }
    setBusy(true);
    try {
      const response = await fetch(
        isEdit ? `/api/settings/fields/${field!.id}` : "/api/settings/fields",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "保存失败，请稍后再试");
        return;
      }
      await onDone(
        isEdit ? "自定义字段已更新" : `自定义字段已创建（标识 ${key}）`,
      );
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-blue-100 bg-blue-50/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="mb-3 text-sm font-semibold text-gray-900">
        {isEdit ? `编辑自定义字段（${field!.label}）` : "新建自定义字段"}
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">字段名称 *</span>
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={64}
            required
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">
            {isEdit ? "字段标识（不可修改）" : "字段标识（系统自动生成）"}
          </span>
          <input
            value={key}
            readOnly
            disabled
            className={`${INPUT_CLASS} bg-gray-100 font-mono text-gray-500`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">
            {isEdit ? "类型（不可修改）" : "类型 *"}
          </span>
          <select
            value={type}
            onChange={(event) => setType(event.target.value as FieldDefItem["type"])}
            disabled={isEdit}
            className={`${INPUT_CLASS} ${isEdit ? "bg-gray-100 text-gray-500" : ""}`}
          >
            <option value="text">文本</option>
            <option value="number">数字</option>
            <option value="date">日期</option>
            <option value="single_select">单选</option>
          </select>
        </label>
      </div>

      {type === "single_select" && (
        <div className="mt-3">
          <p className="mb-1 text-sm text-gray-600">单选选项（值 + 显示名）*</p>
          <div className="flex flex-col gap-2">
            {optionRows.map((row, index) => (
              <div key={index} className="flex gap-2">
                <input
                  value={row.value}
                  onChange={(event) =>
                    setOptionRows((rows) =>
                      rows.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder="选项值（如 a）"
                  className={`${INPUT_CLASS} max-w-40 font-mono`}
                />
                <input
                  value={row.label}
                  onChange={(event) =>
                    setOptionRows((rows) =>
                      rows.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder="显示名（如 A 类）"
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() =>
                    setOptionRows((rows) => rows.filter((_, i) => i !== index))
                  }
                  disabled={optionRows.length <= 1}
                  className="rounded border border-gray-300 bg-white px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                >
                  移除
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOptionRows((rows) => [...rows, { value: "", label: "" }])}
            className="mt-2 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            ＋ 添加选项
          </button>
        </div>
      )}

      <div className="mt-3">
        <p className="mb-1 text-sm text-gray-600">校验规则（可选）</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={required}
              onChange={(event) => setRequired(event.target.checked)}
            />
            <span className="text-gray-600">必填</span>
          </label>
          {(type === "text" || type === "single_select") && (
            <>
              <input
                type="number"
                min={0}
                value={minLength}
                onChange={(event) => setMinLength(event.target.value)}
                placeholder="最小长度"
                aria-label="最小长度"
                className={INPUT_CLASS}
              />
              <input
                type="number"
                min={1}
                value={maxLength}
                onChange={(event) => setMaxLength(event.target.value)}
                placeholder="最大长度"
                aria-label="最大长度"
                className={INPUT_CLASS}
              />
            </>
          )}
          {type === "number" && (
            <>
              <input
                value={min}
                onChange={(event) => setMin(event.target.value)}
                placeholder="数值下限"
                aria-label="数值下限"
                className={INPUT_CLASS}
              />
              <input
                value={max}
                onChange={(event) => setMax(event.target.value)}
                placeholder="数值上限"
                aria-label="数值上限"
                className={INPUT_CLASS}
              />
            </>
          )}
          <input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            placeholder="正则（如 ^[0-9]+$）"
            aria-label="正则表达式"
            className={`${INPUT_CLASS} col-span-2 font-mono sm:col-span-3`}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={busy || label.trim() === ""}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "保存中…" : "保存"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
        >
          取消
        </button>
      </div>
    </form>
  );
}
