import { afterAll, describe, expect, it } from "vitest";
import { changePassword, login, logout } from "@/server/auth/service";
import { resolveSession } from "@/server/auth/session";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser } from "./helpers";

// 认证业务集成测试：真实数据库 + 真实 Argon2id + 真实会话行（T02 验收框架）。

afterAll(cleanupTestUsers);

describe("登录与会话（服务层，真实数据库）", () => {
  it("正确凭据登录：创建会话行（哈希存储），token 可解析出用户", async () => {
    const user = await createTestUser("sales");
    const result = await login(
      { username: user.username, password: user.plainPassword },
      { ip: "127.0.0.1" },
    );
    expect(result.user.id).toBe(user.id);
    expect(result.user.role).toBe("sales");

    const resolved = await resolveSession(result.token);
    expect(resolved).not.toBeNull();
    expect(resolved?.username).toBe(user.username);

    const rows = await prisma.session.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    const tokenHash = rows[0]?.tokenHash;
    expect(tokenHash).toBeDefined();
    expect(tokenHash).not.toBe(result.token); // 库里不存明文 token
    expect(tokenHash).toHaveLength(64);
  });

  it("错误密码 → 401 invalid_credentials，且审计留痕", async () => {
    const user = await createTestUser("sales");
    await expect(
      login({ username: user.username, password: "definitely-wrong" }, {}),
    ).rejects.toMatchObject({ status: 401, code: "invalid_credentials" });

    const audits = await prisma.auditLog.findMany({
      where: { userId: user.id, action: "auth.login_failed" },
    });
    expect(audits.length).toBeGreaterThan(0);
  });

  it("连续 5 次失败后，第 6 次即使密码正确也被限流 429", async () => {
    const user = await createTestUser("sales");
    for (let i = 0; i < 5; i += 1) {
      await expect(
        login({ username: user.username, password: "bad-password" }, {}),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      login({ username: user.username, password: user.plainPassword }, {}),
    ).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("登出撤销会话：再解析返回 null", async () => {
    const user = await createTestUser("sales");
    const { token } = await login(
      { username: user.username, password: user.plainPassword },
      {},
    );
    expect(await resolveSession(token)).not.toBeNull();
    await logout(token, {}, user.id);
    expect(await resolveSession(token)).toBeNull();

    const row = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(row?.revokedAt).not.toBeNull();
  });

  it("停用账号：既有会话立即失效，重新登录被拒 403", async () => {
    const user = await createTestUser("sales");
    const { token } = await login(
      { username: user.username, password: user.plainPassword },
      {},
    );
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "disabled" },
    });
    expect(await resolveSession(token)).toBeNull();
    await expect(
      login({ username: user.username, password: user.plainPassword }, {}),
    ).rejects.toMatchObject({ status: 403, code: "account_disabled" });
  });

  it("修改密码：当前密码错误被拒；成功后旧密码失效、其他会话撤销、当前会话保留", async () => {
    const user = await createTestUser("sales");
    const first = await login(
      { username: user.username, password: user.plainPassword },
      {},
    );
    const second = await login(
      { username: user.username, password: user.plainPassword },
      {},
    );

    await expect(
      changePassword(
        second.token,
        second.user,
        { currentPassword: "wrong-current", newPassword: "NewPassw0rd!456" },
        {},
      ),
    ).rejects.toMatchObject({ status: 400, code: "wrong_current_password" });

    await changePassword(
      second.token,
      second.user,
      { currentPassword: user.plainPassword, newPassword: "NewPassw0rd!456" },
      {},
    );

    expect(await resolveSession(second.token)).not.toBeNull(); // 当前会话保留
    expect(await resolveSession(first.token)).toBeNull(); // 其他会话撤销

    await expect(
      login({ username: user.username, password: user.plainPassword }, {}),
    ).rejects.toMatchObject({ status: 401 });
    const withNew = await login(
      { username: user.username, password: "NewPassw0rd!456" },
      {},
    );
    expect(withNew.user.id).toBe(user.id);
  });

  it("会话滑动续期：距上次续期超过 24h 的会话命中后延长 30 天", async () => {
    const user = await createTestUser("sales");
    const { token, expiresAt } = await login(
      { username: user.username, password: user.plainPassword },
      {},
    );
    // 直接把 updatedAt 回拨 25 小时，模拟"昨天活跃"的会话
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    await resolveSession(token);
    const row = await prisma.session.findFirst({ where: { userId: user.id } });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime());
  });
});
