// 导入值归一化（T05，实施计划 M2 / §4.2）。
//
// 重复判定规则（M2 已确认）：
// - 手机号标准化（去 +86 / 空格 / 横线 / 括号）后精确匹配 = 确认重复（exact）；
// - 客户名称 + 城市匹配（大小写/空白不敏感）= 疑似重复（fuzzy）；
// - 只允许"跳过 / 仍新建"，不静默覆盖（确认阶段的 decision 语义，服务层实现）。
//
// 单元格值矫正（cell → 字段值）：
// - 解析层已把所有原始值拍平为 string | number | boolean | null（Date → "YYYY-MM-DD"）；
// - 布尔目标列接受 是/否/y/n/true/false/1/0 等常见写法；
// - 其余类型交由 leadCreateSchema / 自定义字段校验引擎给出准确中文错误。

/** 手机号标准化：去空格/横线/括号，去国家码前缀（+86 / 86 / 0086） */
export function normalizePhone(value: string): string {
  let s = value.replace(/[\s\-()（）]/g, "");
  if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (s.startsWith("0086") && /^\d{15}$/.test(s)) {
    s = s.slice(4);
  } else if (/^86\d{11}$/.test(s)) {
    s = s.slice(2);
  }
  return s;
}

/** 名称/城市标准化：去首尾与内部多余空白、大小写不敏感（用于疑似重复判定） */
export function normalizeNameLike(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 单元格是否为空（null/undefined/纯空白字符串） */
export function isBlankCell(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

const TRUE_WORDS = new Set(["是", "y", "yes", "true", "1", "有"]);
const FALSE_WORDS = new Set(["否", "n", "no", "false", "0", "无"]);

/**
 * 布尔目标列矫正：是/否/y/n/true/false/1/0/有/无 → boolean；空 → null。
 * 无法识别时返回原字符串（由 Zod Schema 报出准确错误）。
 */
export function coerceBooleanCell(value: unknown): boolean | string | null {
  if (isBlankCell(value)) {
    return null;
  }
  const text = String(value).trim().toLowerCase();
  if (TRUE_WORDS.has(text)) {
    return true;
  }
  if (FALSE_WORDS.has(text)) {
    return false;
  }
  return String(value);
}

/**
 * 日期目标列矫正：解析层已把 Excel 日期单元格转为 "YYYY-MM-DD" 字符串；
 * 此处仅做去空白，格式合法性（含 2026-02-30 这类假日期）交给校验层，
 * 保证错误信息与表单完全一致。
 */
export function coerceDateCell(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}
