import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { assertAdmin } from "@/server/permissions";
import { AuthUser } from "@/lib/auth";
import { AuditLogQueryInput } from "@/lib/schemas/settings";

// 操作日志查询（T15，实施计划 §4.2 / UIUX P9「操作日志」页签）：
// 直接消费 audit_logs 现有结构（T02 建表，T03/T04/T05/T08/T14 持续写入）；
// 仅管理员可查；筛选=动作（精确）/操作人/时间范围（上海日历日，C13）+ 分页。
// 日志无外键（§4.4），操作人姓名二次批量映射；userId 可能未知（登录失败时用户不存在）。

/** 已知审计动作 → 展示文案（筛选项与行内标签；未知动作原样展示动作码） */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  "auth.login": "登录成功",
  "auth.login_failed": "登录失败",
  "auth.logout": "登出",
  "auth.password_changed": "修改密码",
  "import.confirmed": "确认导入",
  "export.created": "导出数据",
  "settings.stage_created": "新增阶段",
  "settings.stage_updated": "修改阶段",
  "settings.field_created": "新增字段",
  "settings.field_updated": "修改字段",
  "settings.user_created": "新建账号",
  "settings.user_updated": "修改账号状态",
  "settings.user_password_reset": "重置密码",
  "settings.prompt_version_created": "新建提示词版本",
  "ai.model_config_created": "新增模型配置",
  "ai.model_config_updated": "修改模型配置",
  "lead.deleted": "删除客户",
  "lead.batch_updated": "批量修改客户",
  "experiment.created": "新建实验",
  "experiment.updated": "修改实验",
  "experiment.assigned": "执行分组",
  "experiment.closed": "关闭实验",
  "ai.control_group_blocked": "常规组 AI 拦截",
};

export function formatAuditAction(action: string): string {
  return AUDIT_ACTION_LABELS[action] ?? action;
}

export const AUDIT_PAGE_SIZE = 50;

export interface AuditLogView {
  id: string;
  createdAt: Date;
  action: string;
  objectType: string | null;
  objectId: string | null;
  detail: Prisma.JsonValue | null;
  ip: string | null;
  userId: string | null;
  /** 操作人姓名；userId 未知（用户不存在）或系统动作为 null */
  userName: string | null;
}

export interface AuditLogListResult {
  logs: AuditLogView[];
  page: number;
  pageSize: number;
  total: number;
}

/** 上海日历日 "YYYY-MM-DD" → UTC 起点瞬间（C13：申报口径按上海日界） */
function shanghaiDateStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

export async function listAuditLogs(
  actor: AuthUser,
  query: AuditLogQueryInput,
): Promise<AuditLogListResult> {
  assertAdmin(actor);
  const page = query.page ?? 1;
  const where: Prisma.AuditLogWhereInput = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.from || query.to
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(shanghaiDateStartMs(query.from)) } : {}),
            // to 为含端日：上限取次日 0 点（开区间）
            ...(query.to
              ? { lt: new Date(shanghaiDateStartMs(query.to) + 24 * 60 * 60 * 1000) }
              : {}),
          },
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE_SIZE,
      skip: (page - 1) * AUDIT_PAGE_SIZE,
    }),
    prisma.auditLog.count({ where }),
  ]);
  const userIds = Array.from(
    new Set(rows.map((row) => row.userId).filter((id): id is string => id !== null)),
  );
  const names = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true },
  });
  const nameMap = new Map(names.map((user) => [user.id, user.name]));
  return {
    logs: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      detail: row.detail,
      ip: row.ip,
      userId: row.userId,
      userName: row.userId ? (nameMap.get(row.userId) ?? null) : null,
    })),
    page,
    pageSize: AUDIT_PAGE_SIZE,
    total,
  };
}
