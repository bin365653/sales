"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  FACT_STATUSES,
  LEAD_PRIORITIES,
  leadCreateSchema,
  leadUpdateSchema,
} from "@/lib/schemas/lead";
import {
  FACT_STATUS_FIELDS,
  FORM_GROUP_ORDER,
  LEAD_FIELD_GROUP_LABELS,
  buildBuiltinFormFields,
  buildCustomFormFields,
  type FieldDefRow,
} from "@/lib/lead-form-fields";
import { validateCustomValues } from "@/lib/lead-field-validation";
import { FACT_STATUS_LABELS, PRIORITY_LABELS } from "@/lib/format";

// 客户新建/编辑共用表单（P3 新建入口 + P5 详情编辑，T04）。
// 校验与服务端共用同一份 Schema（leadCreateSchema/leadUpdateSchema）与
// 自定义字段引擎（validateCustomValues）——提交前先在本地跑一遍，
// 失败定位到具体字段；服务端仍全量重校（前端不可信）。
// 表单字段名 = API 键；空输入提交为 null（= 清空，与编辑局部更新语义一致）。

const INPUT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50";
const TEXTAREA_CLASS =
  "w-full rounded-md border border-gray-300 bg-white p-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
const SELECT_CLASS =
  "h-10 w-full rounded-md border border-gray-300 bg-white px-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export interface LeadFormProps {
  mode: "create" | "edit";
  /** 编辑时必填 */
  leadId?: string;
  dataVersion?: number;
  /** 全量字段定义（服务端传入；表单只渲染启用中的） */
  defs: FieldDefRow[];
  /** 启用阶段（新建时选择；编辑时阶段流转走详情页独立控件，不在此表单） */
  stages: { id: string; name: string }[];
  /** 新建默认阶段（new_lead 锚点） */
  defaultStageId?: string;
  /** 编辑初值：表单字段名 → 值（布尔以 true/false 字符串或布尔值；空 = 空输入） */
  initial?: Record<string, string | number | boolean | null>;
  /** 编辑保存成功回调（详情页切回查看态）；新建固定跳转详情页 */
  onSaved?: () => void;
  onCancel?: () => void;
}

function initialOf(
  initial: Record<string, string | number | boolean | null> | undefined,
  key: string,
): string {
  const value = initial?.[key];
  return value === null || value === undefined ? "" : String(value);
}

export function LeadForm({
  mode,
  leadId,
  dataVersion,
  defs,
  stages,
  defaultStageId,
  initial,
  onSaved,
  onCancel,
}: LeadFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const builtinFields = buildBuiltinFormFields(defs);
  const customFields = buildCustomFormFields(defs);
  const customDefLikes = defs
    .filter((def) => !def.isBuiltin && def.isActive)
    .map((def) => ({
      key: def.key,
      type: def.type as "text" | "number" | "date" | "single_select",
      options: def.options,
      validation: def.validation,
    }));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});

    const formData = new FormData(event.currentTarget);
    const payload: Record<string, unknown> = {};
    for (const field of builtinFields) {
      const raw = formData.get(field.key);
      payload[field.key] = typeof raw === "string" && raw === "" ? null : raw;
    }
    for (const status of FACT_STATUS_FIELDS) {
      const raw = formData.get(status.statusKey);
      payload[status.statusKey] =
        typeof raw === "string" && raw !== "" ? raw : "unknown";
    }
    const priority = formData.get("priority");
    payload.priority =
      typeof priority === "string" && priority !== "" ? priority : "mid";
    const nextContactAt = formData.get("nextContactAt");
    payload.nextContactAt = nextContactAt === "" ? null : nextContactAt;
    if (mode === "create") {
      const stageId = formData.get("stageId");
      if (typeof stageId === "string" && stageId !== "") {
        payload.stageId = stageId;
      }
    }
    const customValues: Record<string, unknown> = {};
    for (const field of customFields) {
      const raw = formData.get(field.key);
      customValues[field.key] =
        typeof raw === "string" && raw === "" ? null : raw;
    }
    payload.customValues = customValues;

    // 前置校验：与 API 同一份 Schema + 自定义字段引擎
    const errors: Record<string, string> = {};
    const schema = mode === "create" ? leadCreateSchema : leadUpdateSchema;
    const body =
      mode === "edit"
        ? { ...payload, dataVersion: dataVersion ?? 0 }
        : payload;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !errors[key]) {
          errors[key] = issue.message;
        }
      }
    }
    const customCheck = validateCustomValues(customDefLikes, customValues, {
      requireAll: mode === "create",
    });
    for (const issue of customCheck.issues) {
      if (!errors[issue.key]) {
        errors[issue.key] = issue.message;
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setSubmitError("请修正表单中标红的字段后重试");
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch(
        mode === "create" ? "/api/leads" : `/api/leads/${leadId}`,
        {
          method: mode === "create" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "edit" ? { ...parsed.data, dataVersion } : parsed.data),
        },
      );
      if (response.ok) {
        if (mode === "create") {
          const created = (await response.json()) as { lead: { id: string } };
          router.push(`/leads/${created.lead.id}`);
        } else {
          router.refresh();
          onSaved?.();
        }
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

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      {submitError && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {submitError}
        </p>
      )}

      {FORM_GROUP_ORDER.map((group) => {
        const fields = builtinFields.filter((field) => field.group === group);
        if (fields.length === 0) {
          return null;
        }
        return (
          <section key={group}>
            <h3 className="mb-3 text-sm font-semibold text-gray-900">
              {LEAD_FIELD_GROUP_LABELS[group]}
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {fields.map((field) => {
                const fact =
                  FACT_STATUS_FIELDS.find(
                    (item) => item.valueKey === field.key,
                  ) ?? null;
                const error = fieldErrors[field.key];
                return (
                  <div
                    key={field.key}
                    className={`flex flex-col gap-1.5 ${
                      field.input === "textarea" ? "sm:col-span-2" : ""
                    }`}
                  >
                    <label
                      htmlFor={`f-${field.key}`}
                      className="text-sm font-medium text-gray-700"
                    >
                      {field.label}
                      {field.key === "name" && (
                        <span className="ml-0.5 text-red-500">*</span>
                      )}
                    </label>
                    <div className="flex gap-2">
                      {field.input === "textarea" ? (
                        <textarea
                          id={`f-${field.key}`}
                          name={field.key}
                          rows={3}
                          defaultValue={initialOf(initial, field.key)}
                          className={TEXTAREA_CLASS}
                        />
                      ) : field.input === "boolean" ? (
                        <select
                          id={`f-${field.key}`}
                          name={field.key}
                          defaultValue={initialOf(initial, field.key)}
                          className={SELECT_CLASS}
                        >
                          <option value="">未确认</option>
                          <option value="true">是</option>
                          <option value="false">否</option>
                        </select>
                      ) : (
                        <input
                          id={`f-${field.key}`}
                          name={field.key}
                          type={
                            field.input === "number"
                              ? "number"
                              : field.input === "date"
                                ? "date"
                                : "text"
                          }
                          inputMode={field.input === "number" ? "numeric" : undefined}
                          defaultValue={initialOf(initial, field.key)}
                          className={INPUT_CLASS}
                        />
                      )}
                      {fact && (
                        <select
                          id={`f-${fact.statusKey}`}
                          name={fact.statusKey}
                          title={`${fact.label}核实状态`}
                          defaultValue={initialOf(initial, fact.statusKey) || "unknown"}
                          className={`${SELECT_CLASS} w-32 shrink-0`}
                        >
                          {FACT_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {FACT_STATUS_LABELS[status]}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {error && <p className="text-xs text-red-600">{error}</p>}
                  </div>
                );
              })}

              {group === "management" && (
                <>
                  {mode === "create" && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="f-stage" className="text-sm font-medium text-gray-700">
                        客户阶段
                      </label>
                      <select
                        id="f-stage"
                        name="stageId"
                        defaultValue={defaultStageId ?? stages[0]?.id ?? ""}
                        className={SELECT_CLASS}
                      >
                        {stages.map((stage) => (
                          <option key={stage.id} value={stage.id}>
                            {stage.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="f-priority" className="text-sm font-medium text-gray-700">
                      优先级
                    </label>
                    <select
                      id="f-priority"
                      name="priority"
                      defaultValue={initialOf(initial, "priority") || "mid"}
                      className={SELECT_CLASS}
                    >
                      {LEAD_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {PRIORITY_LABELS[priority]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="f-next-contact"
                      className="text-sm font-medium text-gray-700"
                    >
                      下次联系时间
                    </label>
                    <input
                      id="f-next-contact"
                      name="nextContactAt"
                      type="datetime-local"
                      defaultValue={initialOf(initial, "nextContactAt")}
                      className={INPUT_CLASS}
                    />
                    {fieldErrors.nextContactAt && (
                      <p className="text-xs text-red-600">
                        {fieldErrors.nextContactAt}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>
        );
      })}

      {customFields.length > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-gray-900">自定义字段</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {customFields.map((field) => {
              const error = fieldErrors[field.key];
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`c-${field.key}`}
                    className="text-sm font-medium text-gray-700"
                  >
                    {field.label}
                    {field.required && <span className="ml-0.5 text-red-500">*</span>}
                  </label>
                  {field.input === "single_select" ? (
                    <select
                      id={`c-${field.key}`}
                      name={field.key}
                      defaultValue={initialOf(initial, field.key)}
                      className={SELECT_CLASS}
                    >
                      <option value="">（未选择）</option>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`c-${field.key}`}
                      name={field.key}
                      type={
                        field.input === "number"
                          ? "number"
                          : field.input === "date"
                            ? "date"
                            : "text"
                      }
                      defaultValue={initialOf(initial, field.key)}
                      className={INPUT_CLASS}
                    />
                  )}
                  {error && <p className="text-xs text-red-600">{error}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="h-10 rounded-md bg-blue-600 px-5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "保存中…" : mode === "create" ? "创建客户" : "保存修改"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-10 rounded-md border border-gray-300 px-5 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-60"
          >
            取消
          </button>
        )}
      </div>
    </form>
  );
}
