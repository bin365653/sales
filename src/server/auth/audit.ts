import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

// 审计日志（实施计划 §4.2 audit_logs）：T02 记录登录成功/失败、登出、改密；
// 查询界面随 T15 交付。不记密码与密钥等敏感明文。

export const AuditAction = {
  login: "auth.login",
  loginFailed: "auth.login_failed",
  logout: "auth.logout",
  passwordChanged: "auth.password_changed",
  // 实验分组（T14）：生命周期动作 + 常规组 AI 拦截留痕（验收项"403 且留痕"）
  experimentCreated: "experiment.created",
  experimentUpdated: "experiment.updated",
  experimentAssigned: "experiment.assigned",
  experimentClosed: "experiment.closed",
  aiControlGroupBlocked: "ai.control_group_blocked",
} as const;

export interface AuditEntry {
  userId?: string | null;
  action: string;
  objectType?: string;
  objectId?: string;
  detail?: Prisma.InputJsonValue;
  ip?: string | null;
}

/** 审计写入失败只告警不阻断主流程（登录本身不能因审计故障不可用） */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: entry.userId ?? null,
        action: entry.action,
        objectType: entry.objectType ?? null,
        objectId: entry.objectId ?? null,
        detail: entry.detail ?? undefined,
        ip: entry.ip ?? null,
      },
    });
  } catch (error) {
    console.error(
      "[audit] 写入失败：",
      entry.action,
      error instanceof Error ? error.message : error,
    );
  }
}
