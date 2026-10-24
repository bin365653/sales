import { createHash, randomBytes } from "node:crypto";
import type { NextResponse } from "next/server";
import { AuthUser, SESSION_COOKIE, SESSION_TTL_MS } from "@/lib/auth";
import { prisma } from "@/server/db";

// 数据库会话（实施计划 §8.1）：Cookie 只存随机 token，库里存 SHA-256 哈希；
// 30 天滑动续期；登出/停用账号立即失效。
// 本模块保持纯数据库逻辑，不引用 next/headers，便于单元/集成测试直接复用。

/** 滑动续期节流：距上次更新不足该时长不写库，避免每个请求都 UPDATE sessions */
const RENEWAL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashSessionToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/**
 * 校验会话并返回当前用户；无效（不存在/已撤销/已过期/账号停用）返回 null。
 * 命中且距上次续期超过 24h 时滑动延长过期时间（30 天滑动续期）。
 */
export async function resolveSession(
  token: string | undefined | null,
): Promise<AuthUser | null> {
  if (!token) {
    return null;
  }
  const record = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      updatedAt: true,
      user: {
        select: { id: true, username: true, name: true, role: true, status: true },
      },
    },
  });
  if (!record) {
    return null;
  }
  if (record.revokedAt !== null || record.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  if (record.user.status !== "active") {
    // 停用账号立即失效：不依赖提前回收所有会话行（§8.1）
    return null;
  }

  if (Date.now() - record.updatedAt.getTime() >= RENEWAL_INTERVAL_MS) {
    // 竞态无害：多次续期写入同一目标值；revoked_at 非空时不覆盖撤销标记
    await prisma.session.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
  }

  return {
    id: record.user.id,
    username: record.user.username,
    name: record.user.name,
    role: record.user.role,
  };
}

export async function revokeSession(
  token: string | undefined | null,
): Promise<void> {
  if (!token) {
    return;
  }
  await prisma.session.updateMany({
    where: { tokenHash: hashSessionToken(token), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** 修改密码后撤销该用户除当前会话外的全部会话 */
export async function revokeOtherUserSessions(
  userId: string,
  keepTokenHash?: string,
): Promise<void> {
  await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(keepTokenHash ? { tokenHash: { not: keepTokenHash } } : {}),
    },
    data: { revokedAt: new Date() },
  });
}

// ---------- Cookie 写入（Route Handler 专用） ----------

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: "lax",
    // 生产环境前置 Nginx HTTPS 后强制 Secure（§8.1）
    secure: process.env.NODE_ENV === "production",
    path: "/",
  } as const;
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date,
): void {
  response.cookies.set({ name: SESSION_COOKIE, value: token, expires: expiresAt, ...cookieBase() });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({ name: SESSION_COOKIE, value: "", maxAge: 0, ...cookieBase() });
}
