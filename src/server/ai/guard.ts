import { ApiError } from "@/server/http/api";
import { prisma } from "@/server/db";
import { AuditAction, writeAudit } from "@/server/auth/audit";

// AI 发起 guard（T09 预留 / T14 实现，UIUX §4.7 常规组拦截、§6.2、K3、C04）：
// 实验进行中且该线索属于常规组时，服务端 403 拒绝 AI 调用（前端以同文案呈现，
// 直达 URL 绕过前端同样被拦）。调用位置在频控之前（createAiRun / retryAiRun）：
// 常规组拒绝不消耗每日额度、不落 ai_runs 行（T09 契约）；
// 拦截写审计日志 ai.control_group_blocked（T14 验收项"403 且留痕"）。
// 关闭语义（T14 确认 UIUX P8 建议）：仅"进行中"实验拦截——实验关闭后
// 常规组禁 AI 规则解除，历史统计不受影响。

export async function assertAiAllowedForLead(
  leadId: string,
  actor?: { id: string },
): Promise<void> {
  const assignment = await prisma.experimentAssignment.findUnique({
    where: { leadId },
    select: {
      group: true,
      experiment: { select: { id: true, name: true, status: true } },
    },
  });
  if (!assignment || assignment.group !== "control") {
    return;
  }
  if (assignment.experiment.status !== "running") {
    return;
  }
  // 留痕（writeAudit 内部失败只告警不抛出，不会阻断拦截本身；
  // await 保证调用方收到 403 时审计行已落库）
  await writeAudit({
    userId: actor?.id ?? null,
    action: AuditAction.aiControlGroupBlocked,
    objectType: "lead",
    objectId: leadId,
    detail: {
      experimentId: assignment.experiment.id,
      experimentName: assignment.experiment.name,
    },
  });
  throw controlGroupError();
}

/** 常规组拦截的统一错误（UIUX §7.2 常规组文案） */
export function controlGroupError(): ApiError {
  return new ApiError(
    403,
    "ai_control_group",
    "该客户属于实验常规组，按实验设计不提供 AI 辅助",
  );
}
