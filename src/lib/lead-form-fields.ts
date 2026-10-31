// 表单与详情页的字段渲染元数据（T04）。
//
// 内置字段：分组/顺序取 BUILTIN_LEAD_FIELDS（单一事实源），label 允许被
// lead_field_defs 中管理员改过的展示名覆盖；已停用的内置字段不渲染。
// 自定义字段：仅渲染启用中的定义（停用字段不在表单出现，存量值由
// 服务端合并语义保留，详情页对仍有值的停用字段单独展示）。
//
// 表单字段名 = API 键（内置 camelCase / 自定义稳定 key），
// 提交时无需做键名转换；defKey（snake_case）用于时间线 updated 事件的字段名映射。

import {
  BUILTIN_LEAD_FIELDS,
  LEAD_FIELD_GROUP_LABELS,
  type LeadFieldGroup,
} from "@/lib/lead-fields";
import { FACT_STATUS_FIELDS } from "@/lib/lead-fields";
import type { FieldOption } from "@/lib/lead-field-validation";

export type BuiltinInput = "text" | "textarea" | "number" | "date" | "boolean";

export interface BuiltinFormField {
  /** lead_field_defs key（snake_case），映射 updated 事件 detail.fields */
  defKey: string;
  /** 表单字段名与 API 键（camelCase） */
  key: string;
  label: string;
  group: LeadFieldGroup;
  input: BuiltinInput;
}

export interface CustomFormField {
  key: string;
  label: string;
  input: "text" | "number" | "date" | "single_select";
  options: FieldOption[];
  required: boolean;
}

export interface FieldDefRow {
  key: string;
  label: string;
  isActive: boolean;
  isBuiltin: boolean;
  type: string;
  options: unknown;
  validation: unknown;
}

function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const TEXTAREA_DEF_KEYS = new Set([
  "known_pains",
  "main_concerns",
  "remark",
  "expressed_needs",
]);
const NUMBER_DEF_KEYS = new Set(["sales_team_size", "customer_count", "picker_count"]);
const DATE_DEF_KEYS = new Set(["contract_expiry"]);
const BOOLEAN_DEF_KEYS = new Set([
  "considering_switch",
  "has_clear_demand",
  "next_gen_mobile_order",
  "qince_interest",
  "is_boss_contact",
]);

function builtinInput(defKey: string): BuiltinInput {
  if (TEXTAREA_DEF_KEYS.has(defKey)) return "textarea";
  if (NUMBER_DEF_KEYS.has(defKey)) return "number";
  if (DATE_DEF_KEYS.has(defKey)) return "date";
  if (BOOLEAN_DEF_KEYS.has(defKey)) return "boolean";
  return "text";
}

/** 内置表单字段（按分组固定顺序；停用的不出现；label 以库中定义覆盖） */
export function buildBuiltinFormFields(defs: FieldDefRow[]): BuiltinFormField[] {
  const byKey = new Map(defs.map((def) => [def.key, def]));
  return BUILTIN_LEAD_FIELDS.flatMap((field) => {
    const def = byKey.get(field.key);
    if (def && !def.isActive) {
      return [];
    }
    return [
      {
        defKey: field.key,
        key: toCamel(field.key),
        label: def?.label ?? field.label,
        group: field.group,
        input: builtinInput(field.key),
      },
    ];
  });
}

function asOptions(raw: unknown): FieldOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (item): item is FieldOption =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as FieldOption).value === "string" &&
      typeof (item as FieldOption).label === "string",
  );
}

function isRequired(validation: unknown): boolean {
  return (
    typeof validation === "object" &&
    validation !== null &&
    (validation as { required?: unknown }).required === true
  );
}

/** 自定义表单字段（仅启用中；single_select 展开选项） */
export function buildCustomFormFields(defs: FieldDefRow[]): CustomFormField[] {
  return defs
    .filter((def) => !def.isBuiltin && def.isActive)
    .map((def) => ({
      key: def.key,
      label: def.label,
      input: def.type as CustomFormField["input"],
      options: def.type === "single_select" ? asOptions(def.options) : [],
      required: isRequired(def.validation),
    }));
}

/** 表单按组渲染的顺序（V2.0 六组，UIUX §5.1：基础/业务/软件/意愿/决策/管理） */
export const FORM_GROUP_ORDER: LeadFieldGroup[] = [
  "basic",
  "business",
  "software",
  "intent",
  "decision",
  "management",
];

export { LEAD_FIELD_GROUP_LABELS, FACT_STATUS_FIELDS };

/** updated 事件 detail.fields 的 snake_case 字段名 → 展示名（内置 + 自定义） */
export function buildFieldLabelMap(defs: FieldDefRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const field of BUILTIN_LEAD_FIELDS) {
    map.set(field.key, field.label);
  }
  for (const def of defs) {
    if (!def.isBuiltin) {
      map.set(`custom:${def.key}`, def.label);
    } else {
      map.set(def.key, def.label);
    }
  }
  // 批量/管理字段的展示名（不在 BUILTIN_LEAD_FIELDS 清单内）
  map.set("priority", "优先级");
  map.set("next_contact_at", "下次联系时间");
  return map;
}
