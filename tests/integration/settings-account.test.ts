import { afterAll, describe, expect, it } from "vitest";
import { login } from "@/server/auth/service";
import { resolveSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import {
  createUser,
  generateInitialPassword,
  listUsers,
  resetUserPassword,
  setUserStatus,
} from "@/server/services/users";
import { listAuditLogs } from "@/server/services/audit-logs";
import { createPromptVersion, listPromptTemplates } from "@/server/services/prompts";
import { AuditAction, writeAudit } from "@/server/auth/audit";
import { cleanupTestUsers, createTestUser } from "./helpers";

// 设置中心集成测试（T15）：账号管理（建号/重置密码/停用启用）、
// 操作日志查询（筛选/分页/权限）、提示词版本（只增不改、保存即生效）。
// 真实数据库 + 真实 Argon2id + 真实会话行。

const createdPromptVersionIds: string[] = [];

afterAll(async () => {
  // 自建提示词版本先行回收（helpers 不清理 prompt_versions；T08 版本只增不改，
  // 只删本测试创建的 v>1 行，不动 seed v1 与 ai_runs 引用）
  if (createdPromptVersionIds.length > 0) {
    await prisma.promptVersion.deleteMany({
      where: { id: { in: createdPromptVersionIds } },
    });
  }
  await cleanupTestUsers();
});

describe("账号管理（建号/重置密码/停用启用）", () => {
  it("管理员建号：初始密码可登录、审计不含明文密码", async () => {
    const admin = await createTestUser("admin");
    const created = await createUser(admin, {
      username: `t15-${generateInitialPassword().toLowerCase()}`,
      name: "T15 新销售",
      role: "sales",
    });
    expect(created.status).toBe("active");
    expect(created.initialPassword).toMatch(/^[A-Za-z0-9_-]{12}$/);

    // 初始密码可登录
    const session = await login(
      { username: created.username, password: created.initialPassword },
      {},
    );
    expect(session.user.id).toBe(created.id);

    // 审计：settings.user_created；detail 只含 username/name/role
    const audit = await prisma.auditLog.findFirst({
      where: { action: AuditAction.userCreated, objectId: created.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).not.toContain(created.initialPassword);
    expect(audit?.userId).toBe(admin.id);
  });

  it("用户名重复 → 409 username_conflict；销售调用 → 403", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const username = `t15-dup-${generateInitialPassword().toLowerCase()}`;
    await createUser(admin, { username, name: "首个", role: "sales" });
    await expect(
      createUser(admin, { username, name: "重复", role: "sales" }),
    ).rejects.toMatchObject({ status: 409, code: "username_conflict" });
    await expect(
      createUser(sales, { username: `${username}x`, name: "越权", role: "sales" }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("管理员重置他人密码：旧密码失效、会话全部撤销、新密码可登录", async () => {
    const admin = await createTestUser("admin");
    const target = await createTestUser("sales");
    const oldSession = await login(
      { username: target.username, password: target.plainPassword },
      {},
    );

    const reset = await resetUserPassword(admin, target.id);
    expect(reset.initialPassword).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(reset.initialPassword).not.toBe(target.plainPassword);

    // 被重置者的既有会话立即失效
    expect(await resolveSession(oldSession.token)).toBeNull();
    // 旧密码不能再登录，新初始密码可以
    await expect(
      login({ username: target.username, password: target.plainPassword }, {}),
    ).rejects.toMatchObject({ status: 401 });
    const withNew = await login(
      { username: target.username, password: reset.initialPassword },
      {},
    );
    expect(withNew.user.id).toBe(target.id);

    const audit = await prisma.auditLog.findFirst({
      where: { action: AuditAction.userPasswordReset, objectId: target.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).not.toContain(reset.initialPassword);
  });

  it("不能对自己重置密码/停用（400 user_self_action）", async () => {
    const admin = await createTestUser("admin");
    await expect(resetUserPassword(admin, admin.id)).rejects.toMatchObject({
      status: 400,
      code: "user_self_action",
    });
    await expect(
      setUserStatus(admin, admin.id, { status: "disabled" }),
    ).rejects.toMatchObject({ status: 400, code: "user_self_action" });
  });

  it("停用账号：会话立即失效 + 登录 403 + 审计；启用恢复", async () => {
    const admin = await createTestUser("admin");
    const target = await createTestUser("sales");
    const session = await login(
      { username: target.username, password: target.plainPassword },
      {},
    );

    const disabled = await setUserStatus(admin, target.id, { status: "disabled" });
    expect(disabled.status).toBe("disabled");
    expect(await resolveSession(session.token)).toBeNull();
    await expect(
      login({ username: target.username, password: target.plainPassword }, {}),
    ).rejects.toMatchObject({ status: 403, code: "account_disabled" });

    const audit = await prisma.auditLog.findFirst({
      where: { action: AuditAction.userUpdated, objectId: target.id },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).toContain("disabled");

    const enabled = await setUserStatus(admin, target.id, { status: "active" });
    expect(enabled.status).toBe("active");
    const again = await login(
      { username: target.username, password: target.plainPassword },
      {},
    );
    expect(again.user.id).toBe(target.id);
  });

  it("重复停用幂等（不写审计不报错）；销售调用 → 403；不存在账号 → 404", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const before = await prisma.auditLog.count({
      where: { action: AuditAction.userUpdated, objectId: sales.id },
    });
    const same = await setUserStatus(admin, sales.id, { status: "active" });
    expect(same.status).toBe("active");
    const after = await prisma.auditLog.count({
      where: { action: AuditAction.userUpdated, objectId: sales.id },
    });
    expect(after).toBe(before);

    await expect(
      setUserStatus(sales, sales.id, { status: "disabled" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      setUserStatus(admin, "0f0e0d0c-0b0a-0908-0706-050403020100", { status: "disabled" }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("停用最后一个其他活跃管理员被兜底拒绝（400 last_admin）", async () => {
    // 正常调用链上 actor 必为活跃管理员（禁自停后结构性保证 ≥1），
    // 该守卫为防御性分支：临时停用库内全部其他活跃管理员，构造
    // "目标是最后一个活跃管理员"的场景，断言后恢复
    const admin = await createTestUser("admin");
    const otherAdmin = await createTestUser("admin");
    const otherActiveIds = (
      await prisma.user.findMany({
        where: { role: "admin", status: "active", id: { not: otherAdmin.id } },
        select: { id: true },
      })
    ).map((row) => row.id);
    await prisma.user.updateMany({
      where: { id: { in: otherActiveIds } },
      data: { status: "disabled" },
    });
    try {
      await expect(
        setUserStatus(admin, otherAdmin.id, { status: "disabled" }),
      ).rejects.toMatchObject({ status: 400, code: "last_admin" });
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: otherActiveIds } },
        data: { status: "active" },
      });
    }
  });

  it("用户列表：仅管理员、不含密码哈希", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    await expect(listUsers(sales)).rejects.toMatchObject({ status: 403 });
    const users = await listUsers(admin);
    expect(users.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(users)).not.toContain("passwordHash");
  });
});

describe("操作日志查询（筛选/分页/权限）", () => {
  it("销售 → 403；管理员可按动作/操作人/时间范围筛选", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    await expect(
      listAuditLogs(sales, { action: undefined }),
    ).rejects.toMatchObject({ status: 403 });

    await writeAudit({
      userId: sales.id,
      action: "t15.query_probe",
      objectType: "probe",
      detail: { marker: "t15" },
      ip: "10.0.0.9",
    });
    // 把该审计行的时间固定到两天前（上海日历日口径）
    const probe = await prisma.auditLog.findFirst({
      where: { userId: sales.id, action: "t15.query_probe" },
    });
    expect(probe).not.toBeNull();
    await prisma.auditLog.update({
      where: { id: probe!.id },
      data: { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
    });

    // 动作筛选
    const byAction = await listAuditLogs(admin, { action: "t15.query_probe" });
    expect(byAction.total).toBeGreaterThanOrEqual(1);
    expect(byAction.logs.every((log) => log.action === "t15.query_probe")).toBe(true);
    // 操作人姓名已映射
    expect(byAction.logs[0]?.userName).toBe(sales.name);

    // 时间范围（上海日历日）：限定为"昨天起"应排除两天前的探针
    const dayMs = 24 * 60 * 60 * 1000;
    const shanghaiToday = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const yesterday = new Date(Date.now() + 8 * 60 * 60 * 1000 - dayMs)
      .toISOString()
      .slice(0, 10);
    const recentOnly = await listAuditLogs(admin, { from: yesterday, to: shanghaiToday });
    expect(
      recentOnly.logs.every((log) => log.action !== "t15.query_probe"),
    ).toBe(true);
    // 只看两天前（from=to=前天）应包含探针
    const twoDaysAgo = new Date(Date.now() + 8 * 60 * 60 * 1000 - 2 * dayMs)
      .toISOString()
      .slice(0, 10);
    const oldOnly = await listAuditLogs(admin, { from: twoDaysAgo, to: twoDaysAgo });
    expect(oldOnly.logs.some((log) => log.action === "t15.query_probe")).toBe(true);
    // from > to 由 Schema 拒绝（单元测试已覆盖），服务层不再重复校验
  });

  it("分页：每页 50 条，page=2 返回余量", async () => {
    const admin = await createTestUser("admin");
    const rows = Array.from({ length: 55 }, (_, index) => ({
      userId: admin.id,
      action: "t15.pagination",
      objectType: "probe",
      detail: { index },
    }));
    await prisma.auditLog.createMany({ data: rows });
    const page1 = await listAuditLogs(admin, { action: "t15.pagination", page: 1 });
    const page2 = await listAuditLogs(admin, { action: "t15.pagination", page: 2 });
    expect(page1.total).toBe(55);
    expect(page1.logs).toHaveLength(50);
    expect(page2.logs).toHaveLength(5);
    expect(page2.page).toBe(2);
  });
});

describe("提示词版本（只增不改、保存即生效）", () => {
  it("新建版本：version 递增、Registry 取最高版本、审计留痕", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const template = await prisma.promptTemplate.findUnique({
      where: { runType: "analysis" },
    });
    expect(template).not.toBeNull();
    const beforeMax = await prisma.promptVersion.aggregate({
      where: { templateId: template!.id },
      _max: { version: true },
    });

    // 销售 → 403；不存在模板 → 404
    await expect(
      createPromptVersion(sales, template!.id, { content: "越权版本" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createPromptVersion(admin, "0f0e0d0c-0b0a-0908-0706-050403020100", {
        content: "x",
      }),
    ).rejects.toMatchObject({ status: 404 });

    const created = await createPromptVersion(admin, template!.id, {
      content: "T15 集成测试版本：仅使用输入资料，信息不足输出 unknown。",
      outputSchema: { facts: "string[]" },
    });
    createdPromptVersionIds.push(created.id);
    expect(created.version).toBe((beforeMax._max.version ?? 0) + 1);

    // Registry（T08 口径）：版本最高者启用 → 解析出新内容
    const { resolveActivePromptVersion } = await import("@/server/ai/prompt-registry");
    const resolved = await resolveActivePromptVersion("analysis");
    expect(resolved.versionId).toBe(created.id);
    expect(resolved.content).toContain("T15 集成测试版本");

    // 再建一个版本：继续递增（版本只增不改，回滚=再建新版本）
    const second = await createPromptVersion(admin, template!.id, {
      content: "T15 第二个版本",
    });
    createdPromptVersionIds.push(second.id);
    expect(second.version).toBe(created.version + 1);

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: AuditAction.promptVersionCreated,
        objectId: template!.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).toContain(String(second.version));
  });

  it("列表返回模板与版本（新→旧），供 P9 时间线渲染", async () => {
    const templates = await listPromptTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) {
      expect(template.versions.length).toBeGreaterThan(0);
      for (let i = 1; i < template.versions.length; i += 1) {
        expect(template.versions[i - 1]!.version).toBeGreaterThan(
          template.versions[i]!.version,
        );
      }
    }
  });
});
