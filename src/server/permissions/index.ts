import { AuthUser } from "@/lib/auth";
import { ApiError } from "@/server/http/api";

/**
 * 权限与数据范围唯一出口（实施计划 §8.2 防线 2）。
 *
 * 规则：
 * - 销售仅可读写 owner_id = 自己的线索及其子资源（interactions/tasks/ai_runs 经线索归属判定）；
 * - 管理员可读写全量客户（K1/C10），并独占配置写权限（阶段/字段/模型/提示词等）；
 * - 管理员的"配置权"与"客户查看权"分别由 assertAdmin / leadReadScope 校验，互不捆绑。
 *
 * 越权访问一律按"资源不存在"返回 404（§8.2 固定用例），避免暴露他人资源的存在性。
 * 列表查询必须使用 leadReadScope 注入数据范围过滤，不允许业务代码手写 where 绕过。
 */

export function isAdmin(user: AuthUser): boolean {
  return user.role === "admin";
}

/** 配置写权限（设置中心各类端点）仅管理员 */
export function assertAdmin(user: AuthUser): void {
  if (!isAdmin(user)) {
    throw new ApiError(403, "forbidden", "仅管理员可执行此操作");
  }
}

export interface LeadOwnershipScope {
  /** 销售固定为本人 id；管理员无此约束（全量） */
  ownerId?: string;
}

/** 线索列表查询强制注入的数据范围过滤（数据访问层使用） */
export function leadReadScope(user: AuthUser): LeadOwnershipScope {
  return isAdmin(user) ? {} : { ownerId: user.id };
}

export function leadWriteScope(user: AuthUser): LeadOwnershipScope {
  return leadReadScope(user);
}

/** 单条线索读权限（详情/子资源读取） */
export function assertLeadReadable(user: AuthUser, ownerId: string): void {
  if (!isAdmin(user) && ownerId !== user.id) {
    throw new ApiError(404, "not_found", "资源不存在");
  }
}

/** 单条线索写权限（编辑/删除/子资源写入） */
export function assertLeadWritable(user: AuthUser, ownerId: string): void {
  if (!isAdmin(user) && ownerId !== user.id) {
    throw new ApiError(404, "not_found", "资源不存在");
  }
}
