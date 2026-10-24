import { prisma } from "@/server/db";
import { AuthUser } from "@/lib/auth";
import { ApiError } from "@/server/http/api";
import { AuditAction, writeAudit } from "@/server/auth/audit";
import { loginRateLimiter } from "@/server/auth/login-rate-limit";
import { equalizingVerify, hashPassword, verifyPassword } from "@/server/auth/password";
import {
  createSession,
  hashSessionToken,
  revokeOtherUserSessions,
  revokeSession,
} from "@/server/auth/session";
import { ChangePasswordInput, LoginInput } from "@/lib/schemas/auth";

// 认证业务编排（实施计划 §8.1）：登录（限流 + 等时校验 + 审计）、
// 登出（撤销会话）、改密（重哈希 + 撤销其他会话）。

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const INVALID_CREDENTIALS_MESSAGE = "用户名或密码错误";

export interface LoginResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

export async function login(
  input: LoginInput,
  meta: RequestMeta,
): Promise<LoginResult> {
  const rateKey = `${meta.ip ?? "-"}|${input.username.toLowerCase()}`;
  if (loginRateLimiter.isBlocked(rateKey)) {
    throw new ApiError(429, "rate_limited", "登录尝试过于频繁，请 15 分钟后再试");
  }

  const user = await prisma.user.findUnique({
    where: { username: input.username },
  });
  const passwordOk = await equalizingVerify(
    user?.passwordHash ?? null,
    input.password,
  );

  if (!user || !passwordOk) {
    loginRateLimiter.recordFailure(rateKey);
    await writeAudit({
      userId: user?.id ?? null,
      action: AuditAction.loginFailed,
      objectType: "user",
      detail: {
        username: input.username,
        reason: user ? "wrong_password" : "unknown_user",
      },
      ip: meta.ip ?? null,
    });
    throw new ApiError(401, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE);
  }

  if (user.status !== "active") {
    loginRateLimiter.recordFailure(rateKey);
    await writeAudit({
      userId: user.id,
      action: AuditAction.loginFailed,
      objectType: "user",
      detail: { username: input.username, reason: "account_disabled" },
      ip: meta.ip ?? null,
    });
    throw new ApiError(403, "account_disabled", "账号已被停用，请联系管理员");
  }

  loginRateLimiter.reset(rateKey);
  const session = await createSession(user.id);
  await writeAudit({
    userId: user.id,
    action: AuditAction.login,
    objectType: "user",
    objectId: user.id,
    detail: { userAgent: meta.userAgent ?? null },
    ip: meta.ip ?? null,
  });

  return {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    },
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** 登出：撤销会话并审计；未登录调用同样安全（幂等清 Cookie） */
export async function logout(
  token: string | undefined | null,
  meta: RequestMeta,
  userIdForAudit?: string,
): Promise<void> {
  if (!token) {
    return;
  }
  await revokeSession(token);
  if (userIdForAudit) {
    await writeAudit({
      userId: userIdForAudit,
      action: AuditAction.logout,
      objectType: "user",
      objectId: userIdForAudit,
      ip: meta.ip ?? null,
    });
  }
}

export async function changePassword(
  token: string,
  currentUser: AuthUser,
  input: ChangePasswordInput,
  meta: RequestMeta,
): Promise<void> {
  const record = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (!record || !(await verifyPassword(record.passwordHash, input.currentPassword))) {
    throw new ApiError(400, "wrong_current_password", "当前密码不正确");
  }

  const passwordHash = await hashPassword(input.newPassword);
  await prisma.user.update({
    where: { id: currentUser.id },
    data: { passwordHash },
  });
  // 其他端已登录的会话全部失效，仅保留当前会话（防盗号者长期驻留）
  await revokeOtherUserSessions(currentUser.id, hashSessionToken(token));
  await writeAudit({
    userId: currentUser.id,
    action: AuditAction.passwordChanged,
    objectType: "user",
    objectId: currentUser.id,
    ip: meta.ip ?? null,
  });
}
