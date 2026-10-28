import { describe, expect, it } from "vitest";
import {
  auditLogQuerySchema,
  promptVersionCreateSchema,
  userCreateSchema,
  userStatusUpdateSchema,
} from "@/lib/schemas/settings";
import { modelConnectionTestSchema } from "@/lib/schemas/ai";
import { generateInitialPassword } from "@/server/services/users";

// T15 设置中心 Schema：账号管理 / 审计查询 / 提示词版本 / 测试连接入参。

describe("userCreateSchema（账号管理）", () => {
  it("合法入参通过（销售/管理员）", () => {
    expect(
      userCreateSchema.parse({ username: "zhangsan", name: "张三", role: "sales" }),
    ).toEqual({ username: "zhangsan", name: "张三", role: "sales" });
    expect(
      userCreateSchema.parse({ username: "a-b_01", name: "管理员", role: "admin" }),
    ).toMatchObject({ role: "admin" });
  });

  it("用户名格式约束：过短/非法字符/超长拒绝", () => {
    expect(() =>
      userCreateSchema.parse({ username: "a", name: "x", role: "sales" }),
    ).toThrow();
    expect(() =>
      userCreateSchema.parse({ username: "张三", name: "x", role: "sales" }),
    ).toThrow();
    expect(() =>
      userCreateSchema.parse({ username: "a".repeat(65), name: "x", role: "sales" }),
    ).toThrow();
    // 用户名两侧空白被 trim
    expect(
      userCreateSchema.parse({ username: "  bob  ", name: "x", role: "sales" }).username,
    ).toBe("bob");
  });

  it("角色枚举外值拒绝；姓名必填", () => {
    expect(() =>
      userCreateSchema.parse({ username: "bob", name: "x", role: "owner" }),
    ).toThrow();
    expect(() =>
      userCreateSchema.parse({ username: "bob", name: "  ", role: "sales" }),
    ).toThrow();
  });
});

describe("userStatusUpdateSchema（停用/启用）", () => {
  it("仅接受 active/disabled", () => {
    expect(userStatusUpdateSchema.parse({ status: "disabled" })).toEqual({
      status: "disabled",
    });
    expect(userStatusUpdateSchema.parse({ status: "active" })).toEqual({
      status: "active",
    });
    expect(() => userStatusUpdateSchema.parse({ status: "deleted" })).toThrow();
  });
});

describe("auditLogQuerySchema（操作日志筛选）", () => {
  it("全空入参通过（默认第一页）", () => {
    expect(auditLogQuerySchema.parse({})).toEqual({});
  });

  it("from 晚于 to 拒绝", () => {
    expect(() =>
      auditLogQuerySchema.parse({ from: "2026-10-02", to: "2026-10-01" }),
    ).toThrow();
    expect(
      auditLogQuerySchema.parse({ from: "2026-10-01", to: "2026-10-01" }).from,
    ).toBe("2026-10-01");
  });

  it("非法日期/UUID/页码拒绝", () => {
    expect(() => auditLogQuerySchema.parse({ from: "2026/10/01" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ userId: "not-a-uuid" })).toThrow();
    expect(() => auditLogQuerySchema.parse({ page: 0 })).toThrow();
    expect(() => auditLogQuerySchema.parse({ page: 1.5 })).toThrow();
  });

  it("页码经 coerce 转整数", () => {
    expect(auditLogQuerySchema.parse({ page: "3" }).page).toBe(3);
  });
});

describe("promptVersionCreateSchema（提示词版本）", () => {
  it("内容必填且上限 32000 字", () => {
    expect(() => promptVersionCreateSchema.parse({ content: "   " })).toThrow();
    expect(
      promptVersionCreateSchema.parse({ content: "  新版本内容  " }).content,
    ).toBe("新版本内容");
    expect(() =>
      promptVersionCreateSchema.parse({ content: "x".repeat(32001) }),
    ).toThrow();
  });

  it("outputSchema 必须为对象（数组/标量拒绝），可缺省", () => {
    expect(
      promptVersionCreateSchema.parse({ content: "x", outputSchema: { facts: "string" } })
        .outputSchema,
    ).toEqual({ facts: "string" });
    expect(() =>
      promptVersionCreateSchema.parse({ content: "x", outputSchema: [1, 2] }),
    ).toThrow();
    expect(() =>
      promptVersionCreateSchema.parse({ content: "x", outputSchema: "facts" }),
    ).toThrow();
    expect(promptVersionCreateSchema.parse({ content: "x" }).outputSchema).toBeUndefined();
  });
});

describe("modelConnectionTestSchema（测试连接）", () => {
  it("configId 形态：混传表单值拒绝", () => {
    expect(() =>
      modelConnectionTestSchema.parse({
        configId: "0f0e0d0c-0b0a-0908-0706-050403020100",
        baseUrl: "https://api.example.com/v1",
      }),
    ).toThrow();
    expect(
      modelConnectionTestSchema.parse({
        configId: "0f0e0d0c-0b0a-0908-0706-050403020100",
      }).configId,
    ).toBeDefined();
  });

  it("表单形态：三项齐全才通过，缺一拒绝", () => {
    expect(() =>
      modelConnectionTestSchema.parse({ baseUrl: "https://api.example.com/v1" }),
    ).toThrow();
    const parsed = modelConnectionTestSchema.parse({
      baseUrl: "https://api.example.com/v1",
      modelName: "glm-4.7",
      apiKey: "sk-test-12345",
    });
    expect(parsed.modelName).toBe("glm-4.7");
  });

  it("Base URL 非法（非 http(s)）拒绝", () => {
    expect(() =>
      modelConnectionTestSchema.parse({
        baseUrl: "ftp://api.example.com",
        modelName: "m",
        apiKey: "sk-test-12345",
      }),
    ).toThrow();
  });
});

describe("generateInitialPassword（一次性初始密码）", () => {
  it("12 位 base64url 字符集，满足至少 8 位策略", () => {
    const password = generateInitialPassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("随机性：多次生成不重复", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateInitialPassword()));
    expect(seen.size).toBe(50);
  });
});
