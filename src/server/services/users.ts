import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { assertAdmin } from "@/server/permissions";
import { AuditAction, writeAudit } from "@/server/auth/audit";
import { hashPassword } from "@/server/auth/password";
import { revokeAllUserSessions } from "@/server/auth/session";
import {
  UserCreateInput,
  UserStatusUpdateInput,
} from "@/lib/schemas/settings";

// 用户服务：负责人筛选下拉与时间线操作人展示（T04 起）+
// 账号管理（T15，UIUX P9：管理员建号/重置密码/停用启用；无删除）。
// - 初始密码服务端生成、仅在建号/重置的响应中一次性返回，审计与日志绝不明文记录；
// - 重置密码/停用立即撤销该用户全部会话（"会话立即失效"，UIUX §4.8）；
// - 不能对自己停用/重置（防误操作把自己锁在门外，改密走「账号与密码」）；
//   停用兜底"至少保留一个启用中的管理员"（当前操作者必为活跃管理员，
//   该约束由禁自停结构性保证，此处显式校验防未来旁路）。

export interface OwnerOption {
  id: string;
  name: string;
  role: string;
}

/** 活跃用户（负责人筛选用；管理员视角 P10） */
export async function listActiveUsers(): Promise<OwnerOption[]> {
  const users = await prisma.user.findMany({
    where: { status: "active" },
    select: { id: true, name: true, role: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return users;
}

/** 批量取用户名：时间线/列表展示操作人；缺失（用户被物理删除）返回 null */
export async function getUserNames(
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

// ---------- 账号管理（T15） ----------

export interface ManagedUserView {
  id: string;
  username: string;
  name: string;
  role: string;
  status: string;
  createdAt: Date;
}

/**
 * 初始密码：12 位 base64url（约 71 bit 熵），满足"至少 8 位"策略；
 * 仅在创建/重置响应中出现一次，提示用户首次登录后自行修改。
 */
export function generateInitialPassword(): string {
  return randomBytes(9).toString("base64url");
}

export async function listUsers(actor: AuthUser): Promise<ManagedUserView[]> {
  assertAdmin(actor);
  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      status: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return users;
}

export interface UserWithInitialPassword extends ManagedUserView {
  /** 一次性明文初始密码（仅本响应可见，落库前已 Argon2id 哈希） */
  initialPassword: string;
}

export async function createUser(
  actor: AuthUser,
  input: UserCreateInput,
): Promise<UserWithInitialPassword> {
  assertAdmin(actor);
  const initialPassword = generateInitialPassword();
  try {
    const user = await prisma.user.create({
      data: {
        username: input.username,
        name: input.name,
        role: input.role,
        passwordHash: await hashPassword(initialPassword),
        status: "active",
      },
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });
    // 审计只记用户名/角色，绝不记初始密码明文（§4.2 不记敏感明文）
    await writeAudit({
      userId: actor.id,
      action: AuditAction.userCreated,
      objectType: "user",
      objectId: user.id,
      detail: { username: user.username, name: user.name, role: user.role },
    });
    return { ...user, initialPassword };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiError(409, "username_conflict", "用户名已被使用");
    }
    throw error;
  }
}

async function getManagedUser(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      status: true,
      createdAt: true,
    },
  });
  if (!user) {
    throw new ApiError(404, "not_found", "账号不存在");
  }
  return user;
}

function assertNotSelf(actor: AuthUser, targetId: string): void {
  if (actor.id === targetId) {
    throw new ApiError(
      400,
      "user_self_action",
      "不能对当前登录账号执行此操作，请改用「账号与密码」修改",
    );
  }
}

/** 管理员重置他人密码：生成新初始密码、撤销全部会话（立即失效）并审计 */
export async function resetUserPassword(
  actor: AuthUser,
  targetId: string,
): Promise<UserWithInitialPassword> {
  assertAdmin(actor);
  assertNotSelf(actor, targetId);
  const target = await getManagedUser(targetId);
  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: targetId }, data: { passwordHash } }),
    // 被重置者所有已登录会话立即失效（UIUX §4.8：确认文案承诺）
    revokeAllUserSessions(targetId),
  ]);
  await writeAudit({
    userId: actor.id,
    action: AuditAction.userPasswordReset,
    objectType: "user",
    objectId: targetId,
    detail: { username: target.username },
  });
  return { ...target, initialPassword };
}

export async function setUserStatus(
  actor: AuthUser,
  targetId: string,
  input: UserStatusUpdateInput,
): Promise<ManagedUserView> {
  assertAdmin(actor);
  assertNotSelf(actor, targetId);
  const target = await getManagedUser(targetId);
  if (target.status === input.status) {
    // 幂等：目标状态与请求一致时直接返回，不写审计不撤销会话
    return target;
  }
  if (input.status === "disabled" && target.role === "admin") {
    const otherActiveAdmins = await prisma.user.count({
      where: { role: "admin", status: "active", id: { not: targetId } },
    });
    if (otherActiveAdmins === 0) {
      throw new ApiError(
        400,
        "last_admin",
        "系统至少需要保留一个启用中的管理员账号",
      );
    }
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: targetId }, data: { status: input.status } }),
    // resolveSession 对停用账号本就拒绝（§8.1）；显式撤销让"立即失效"不依赖再次访问
    ...(input.status === "disabled" ? [revokeAllUserSessions(targetId)] : []),
  ]);
  await writeAudit({
    userId: actor.id,
    action: AuditAction.userUpdated,
    objectType: "user",
    objectId: targetId,
    detail: {
      username: target.username,
      status: { from: target.status, to: input.status },
    },
  });
  return { ...target, status: input.status };
}
