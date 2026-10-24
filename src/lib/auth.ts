// 认证共享常量与类型：前后端与 middleware 共用。
// 本文件必须保持零服务端依赖（middleware 运行在 edge，不得引入 node/prisma 模块）。

export const SESSION_COOKIE = "qince_session";

/** 会话有效期：30 天滑动续期（实施计划 §8.1） */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type UserRole = "sales" | "admin";

/** 会话有效时的当前用户（不含密码哈希等敏感字段） */
export interface AuthUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
}

export const ROLE_LABELS: Record<UserRole, string> = {
  sales: "销售",
  admin: "管理员",
};
