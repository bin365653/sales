// 日志脱敏（T16，实施计划 §9：日志脱敏）：服务器日志/错误信息输出前
// 掩去口令、令牌、密钥类字段值。审计（audit_logs）的"不记敏感明文"由各
// 写入侧保证（T02/T08/T15），本模块负责兜住"未处理异常/底层错误"进入
// 日志时夹带敏感值的通道。

/** 命中即掩去的字段名（不区分大小写、容忍 -/_ 分隔与复数） */
const SENSITIVE_KEY_RE =
  /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|authorization|cookie|credential)s?$/i;

/** key=value / key:value / "key": "value" 形态的值掩去（值分支吞掉 Bearer 前缀，避免半截掩码） */
const KEY_VALUE_RE =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|authorization|cookie|credential)s?"?\s*[=:：]\s*)(?:(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&}'"]+))/gi;

/** Bearer 令牌掩去（无键名形态的兜底） */
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** 掩去文本中疑似敏感的键值对与 Bearer 令牌（日志输出兜底；先键值后 Bearer，避免双重掩码） */
export function redactText(text: string): string {
  return redactTextOf(text.replace(KEY_VALUE_RE, "$1[REDACTED]"));
}

function redactTextOf(text: string): string {
  return text.replace(BEARER_RE, "$1[REDACTED]");
}

/** 判断对象键是否为敏感字段（结构化日志用） */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_RE.test(key.trim());
}

/**
 * 对任意值做深脱敏（不修改原对象）：
 * - 字符串：按文本规则掩去；
 * - 对象/数组：敏感键的值替换为 "[REDACTED]"，其余递归（循环引用安全，深度限 8）；
 * - 其他标量原样返回。
 */
export function redactValue(
  value: unknown,
  maxDepth = 8,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value as object) || maxDepth <= 0) {
    return "[TRUNCATED]";
  }
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, maxDepth - 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : redactValue(item, maxDepth - 1, seen);
  }
  return result;
}

/** 错误 → 单行脱敏描述（"[Name] message"；Error 以外的值结构化脱敏后序列化） */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `[${error.name}] ${redactText(error.message)}`;
  }
  try {
    return JSON.stringify(redactValue(error)) ?? String(error);
  } catch {
    return String(error);
  }
}
