import { prisma } from "@/server/db";

// 用户查询服务（T04 起）：负责人筛选下拉与时间线操作人展示。
// 账号管理（建号/停用/重置密码）随 T15 交付。

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
