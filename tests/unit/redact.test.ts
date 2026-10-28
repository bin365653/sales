import { describe, expect, it } from "vitest";
import {
  describeError,
  isSensitiveKey,
  redactText,
  redactValue,
} from "@/server/http/redact";

// T16 日志脱敏：服务器日志/错误描述输出前掩去口令、令牌、密钥类值。

describe("redactText（文本兜底掩去）", () => {
  it("key=value / key:value 形态的密码与令牌被掩去", () => {
    expect(redactText("login failed for password=hunter2")).toBe(
      "login failed for password=[REDACTED]",
    );
    expect(redactText("password: hunter2 (again)")).toBe(
      "password: [REDACTED] (again)",
    );
    expect(redactText('{"api_key":"sk-abc123"}')).toBe('{"api_key":[REDACTED]}');
    expect(redactText("refresh_token=abc123;&next=/")).toBe(
      "refresh_token=[REDACTED];&next=/",
    );
  });

  it("Bearer 令牌被掩去（含键名形态不半截掩码）；普通文本不受影响", () => {
    expect(redactText("Authorization: Bearer eyJhbGciOi.abc123")).toBe(
      "Authorization: [REDACTED]",
    );
    expect(redactText("Bearer standalone-token-1")).toBe("Bearer [REDACTED]");
    expect(redactText("普通中文日志不含敏感值")).toBe("普通中文日志不含敏感值");
    // 仅"包含"关键字字样的键（如 keyboard）不误伤：整键匹配才掩去
    expect(redactText("total=3 keyboard=1")).toBe("total=3 keyboard=1");
  });

  it("中文冒号与大小写变体", () => {
    expect(redactText("PASSWORD：abc123")).toBe("PASSWORD：[REDACTED]");
    expect(redactText("ApiKey='sk-long'")).toBe("ApiKey=[REDACTED]");
  });
});

describe("isSensitiveKey / redactValue（结构化脱敏）", () => {
  it("敏感键整键匹配，普通键不误伤", () => {
    expect(isSensitiveKey("password")).toBe(true);
    expect(isSensitiveKey("API_KEY")).toBe(true);
    expect(isSensitiveKey("access-token")).toBe(true);
    expect(isSensitiveKey("authorization")).toBe(true);
    expect(isSensitiveKey("keyboard")).toBe(false);
    expect(isSensitiveKey("tokenCount")).toBe(false);
  });

  it("redactValue 掩去敏感键值、递归处理嵌套、不改原对象", () => {
    const input = {
      username: "admin",
      password: "hunter2",
      nested: { apiKey: "sk-xyz", note: "password=leak" },
      list: [{ token: "t-1" }, "plain"],
    };
    const output = redactValue(input) as typeof input;
    expect(input.password).toBe("hunter2"); // 原对象不变
    expect(output.username).toBe("admin");
    expect(output.password).toBe("[REDACTED]");
    expect((output.nested as { apiKey: string }).apiKey).toBe("[REDACTED]");
    expect((output.nested as { note: string }).note).toBe("password=[REDACTED]");
    expect((output.list[0] as { token: string }).token).toBe("[REDACTED]");
    expect(output.list[1]).toBe("plain");
  });

  it("循环引用安全；非对象标量原样", () => {
    const circular: Record<string, unknown> = { name: "a" };
    circular.self = circular;
    expect(redactValue(circular)).toMatchObject({ name: "a", self: "[TRUNCATED]" });
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBeNull();
  });
});

describe("describeError（错误单行脱敏描述）", () => {
  it("Error 输出 [Name] message 并掩去敏感值", () => {
    const error = new Error("connect failed with password=supersecret");
    expect(describeError(error)).toBe("[Error] connect failed with password=[REDACTED]");
  });

  it("非 Error 值 JSON 序列化后脱敏", () => {
    expect(describeError({ password: "abc" })).toBe(
      JSON.stringify({ password: "[REDACTED]" }),
    );
  });
});
