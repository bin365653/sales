import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/server/http/api";
import {
  assertAdmin,
  assertLeadReadable,
  assertLeadWritable,
  isAdmin,
  leadReadScope,
} from "@/server/permissions";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser } from "./helpers";

// T02 验收项：销售 A/B 数据互不可见（集成测试）；管理员可看全量。
// 本任务尚未建 leads 表（随 T03 迁移），此处以真实数据库用户为夹具，
// 对"范围过滤 + 所有权判定"做集成验证；T03 落地 leads 后在同一框架下补充行级用例。

afterAll(cleanupTestUsers);

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.status;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("数据范围（真实数据库用户夹具）", () => {
  it("销售 A/B 互不可见：跨归属读写一律 404，本人访问通过", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");

    expect(() => assertLeadReadable(a, a.id)).not.toThrow(); // 读自己的
    expect(() => assertLeadWritable(b, b.id)).not.toThrow();

    // A 访问 B 的资源 → 404（无论资源是否存在，统一"不存在"语义）
    expect(statusOf(() => assertLeadReadable(a, b.id))).toBe(404);
    expect(statusOf(() => assertLeadWritable(a, b.id))).toBe(404);
    expect(statusOf(() => assertLeadReadable(b, a.id))).toBe(404);

    // 数据库层面确认 A/B 是两个真实存在的独立账号（夹具有效性）
    const count = await prisma.user.count({
      where: { username: { in: [a.username, b.username] } },
    });
    expect(count).toBe(2);
  });

  it("管理员可看全量：无归属约束，对任意销售的资源读写通过", async () => {
    const a = await createTestUser("sales");
    const admin = await createTestUser("admin");

    expect(leadReadScope(admin)).toEqual({}); // 列表查询不注入 ownerId 过滤 → 全量
    expect(() => assertLeadReadable(admin, a.id)).not.toThrow();
    expect(() => assertLeadWritable(admin, a.id)).not.toThrow();
    expect(isAdmin(admin)).toBe(true);
  });

  it("越权用例夹具：销售无法通过 assertAdmin 冒充管理员入口", async () => {
    const a = await createTestUser("sales");
    expect(statusOf(() => assertAdmin(a))).toBe(403);
  });

  it("角色/状态枚举与 schema 一致（防漂移冒烟）", async () => {
    const admin = await createTestUser("admin");
    const row = await prisma.user.findUnique({
      where: { id: admin.id },
      select: { role: true, status: true },
    });
    expect(row?.role).toBe("admin");
    expect(row?.status).toBe("active");
  });
});
