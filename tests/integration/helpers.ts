import { randomBytes } from "node:crypto";
import { AuthUser } from "@/lib/auth";
import { hashPassword } from "@/server/auth/password";
import { prisma } from "@/server/db";

// 集成测试夹具：每个用例创建随机用户名，结束后统一清理（sessions 级联、audit_logs 显式清）。

const createdUserIds: string[] = [];

export interface TestUser extends AuthUser {
  plainPassword: string;
}

export function uniqueUsername(prefix: string): string {
  return `t02-${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function createTestUser(
  role: AuthUser["role"],
  password = "Passw0rd!123",
): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      username: uniqueUsername(role),
      passwordHash: await hashPassword(password),
      name: `测试${role === "admin" ? "管理员" : "销售"}`,
      role,
      status: "active",
    },
  });
  createdUserIds.push(user.id);
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    plainPassword: password,
  };
}

export async function cleanupTestUsers(): Promise<void> {
  if (createdUserIds.length === 0) {
    return;
  }
  // audit_logs 不加外键（§4.4），先按 user_id 清理，再删用户（sessions 级联删除）
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
}
