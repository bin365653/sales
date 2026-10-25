// 自定义字段校验与归一化引擎（T03，实施计划 §4.4 / C12）。
//
// 纯函数、零依赖，API 服务端与前端表单（T04）共用同一份实现，
// 保证自定义字段校验前后端一致（T03 验收项）。
//
// 值约定（存入 leads.custom_values，键为字段稳定 key）：
// - text：字符串；
// - number：JSON 数字（兼容数字字符串，归一化为数字）；
// - date："YYYY-MM-DD" 字符串（真实日历日期）；
// - single_select：选项 value 字符串（选项 value 即稳定 ID，改 label 不影响存量数据）；
// - null / 缺席：清空 / 未提供。
//
// V1.0 自定义字段不参与筛选与统计（C12），仅做校验、存储与展示。

export type LeadCustomFieldType = "text" | "number" | "date" | "single_select";

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldValidationRules {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** JavaScript 正则表达式源文本，仅 text 类型生效 */
  pattern?: string;
}

export interface FieldDefLike {
  key: string;
  type: LeadCustomFieldType;
  options?: unknown;
  validation?: unknown;
}

export interface FieldIssue {
  key: string;
  message: string;
}

export interface CustomValuesResult {
  /** 归一化后的值（数字字符串转数字；不剔除任何键） */
  values: Record<string, string | number>;
  issues: FieldIssue[];
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

function asRules(raw: unknown): FieldValidationRules {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const rules: FieldValidationRules = {};
  if (typeof source.required === "boolean") {
    rules.required = source.required;
  }
  for (const key of ["minLength", "maxLength"] as const) {
    if (typeof source[key] === "number" && Number.isInteger(source[key])) {
      rules[key] = source[key] as number;
    }
  }
  for (const key of ["min", "max"] as const) {
    if (typeof source[key] === "number" && Number.isFinite(source[key])) {
      rules[key] = source[key] as number;
    }
  }
  if (typeof source.pattern === "string") {
    rules.pattern = source.pattern;
  }
  return rules;
}

/** "YYYY-MM-DD" 且为真实日历日期（拦截 2026-02-30 这类 JS Date 会静默进位的值） */
export function isValidDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** 校验并归一化单个字段值；合法返回 null，非法返回错误说明 */
function validateSingleField(
  def: FieldDefLike,
  value: unknown,
): { normalized: string | number | null; error: string | null } {
  const rules = asRules(def.validation);

  if (isEmptyValue(value)) {
    return rules.required
      ? { normalized: null, error: "为必填项，不能留空" }
      : { normalized: null, error: null };
  }

  switch (def.type) {
    case "text": {
      if (typeof value !== "string") {
        return { normalized: null, error: "须为文本" };
      }
      if (rules.minLength !== undefined && value.length < rules.minLength) {
        return { normalized: null, error: `长度不能少于 ${rules.minLength} 字` };
      }
      if (rules.maxLength !== undefined && value.length > rules.maxLength) {
        return { normalized: null, error: `长度不能超过 ${rules.maxLength} 字` };
      }
      if (rules.pattern !== undefined && rules.pattern !== "") {
        try {
          if (!new RegExp(rules.pattern, "u").test(value)) {
            return { normalized: null, error: "格式不符合字段要求" };
          }
        } catch {
          // 定义中的正则本身非法（配置创建时应已拦截）——此处跳过该规则，不阻断业务
        }
      }
      return { normalized: value, error: null };
    }
    case "number": {
      const num =
        typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (typeof value !== "number" && typeof value !== "string") {
        return { normalized: null, error: "须为数字" };
      }
      if (!Number.isFinite(num)) {
        return { normalized: null, error: "须为有效数字" };
      }
      if (rules.min !== undefined && num < rules.min) {
        return { normalized: null, error: `不能小于 ${rules.min}` };
      }
      if (rules.max !== undefined && num > rules.max) {
        return { normalized: null, error: `不能大于 ${rules.max}` };
      }
      return { normalized: num, error: null };
    }
    case "date": {
      if (typeof value !== "string" || !isValidDateString(value)) {
        return { normalized: null, error: "日期格式应为 YYYY-MM-DD" };
      }
      return { normalized: value, error: null };
    }
    case "single_select": {
      if (typeof value !== "string") {
        return { normalized: null, error: "须选择一个选项" };
      }
      const options = asOptions(def.options);
      if (!options.some((option) => option.value === value)) {
        return { normalized: null, error: "不在可选范围内" };
      }
      return { normalized: value, error: null };
    }
  }
}

/**
 * 校验并归一化一批自定义字段值。
 *
 * @param defs        字段定义（通常只传"启用中"的定义）
 * @param rawValues   提交的值（键为字段 key；null 表示清空）
 * @param requireAll  true（新建）：启用中的必填字段即使未提交也报错；
 *                    false（编辑）：只校验本次提交的键，缺席键保持原值不动。
 */
export function validateCustomValues(
  defs: FieldDefLike[],
  rawValues: Record<string, unknown>,
  options: { requireAll: boolean } = { requireAll: false },
): CustomValuesResult {
  const issues: FieldIssue[] = [];
  const values: Record<string, string | number> = {};
  const defByKey = new Map(defs.map((def) => [def.key, def]));

  const keysToCheck = new Set(Object.keys(rawValues));
  if (options.requireAll) {
    for (const def of defs) {
      if (asRules(def.validation).required) {
        keysToCheck.add(def.key);
      }
    }
  }

  for (const key of keysToCheck) {
    const def = defByKey.get(key);
    if (!def) {
      // 值存在（显式提交且非清空）但定义不存在 → 未知字段
      if (!isEmptyValue(rawValues[key])) {
        issues.push({ key, message: "未知自定义字段" });
      }
      continue;
    }
    const { normalized, error } = validateSingleField(def, rawValues[key]);
    if (error) {
      issues.push({ key, message: error });
      continue;
    }
    if (normalized !== null) {
      values[key] = normalized;
    }
  }

  return { values, issues };
}

/** 判定"提交键集合"中是否有已停用的内置字段（返回违规键列表） */
export function findInactiveBuiltinKeys(
  builtinDefs: { key: string; isActive: boolean }[],
  providedKeys: Iterable<string>,
): string[] {
  const statusByKey = new Map(builtinDefs.map((def) => [def.key, def.isActive]));
  const violated: string[] = [];
  for (const key of providedKeys) {
    if (statusByKey.get(key) === false) {
      violated.push(key);
    }
  }
  return violated;
}
