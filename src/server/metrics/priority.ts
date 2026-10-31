import { AuthUser } from "@/lib/auth";
import { LeadPriority } from "@/lib/format";
import {
  comparePriorityCandidates,
  evaluatePriorityReasons,
  PriorityCandidateCore,
} from "@/lib/metrics";
import { toShanghaiDateString, toUtcDateString } from "@/lib/format";
import { currentExpiryMonth, expiryMonthToUtcDate, addExpiryMonths } from "@/lib/expiry";
import { startOfShanghaiDay } from "@/lib/tasks";
import { prisma } from "@/server/db";
import { leadReadScope } from "@/server/permissions";
import { TASK_GENERATION_TERMINAL_STAGES } from "@/server/services/followup-policies";

// 建议优先联系规则引擎（T12 + V2.0-T10 升级，K6 / D4 / UIUX §5.6 核心区）。
//
// K6 双轨制：`priority` 列是人工管理字段，本模块的"建议优先联系"由
// 确定性规则生成并附理由（规则与理由文案见 src/lib/metrics.ts），
// AI 不参与优先级计算；缺少采购信号的客户不产生任何理由（无"高意向"话术）。
//
// V2.0-T10（D4）：候选集 OR 超集改为 半年内到期 / 今日待联系 / 画像待完善
// （核心未全核实）；won/closed 终态客户不参与（与作战列表、任务生成器同口径——
// 终态客户不再是"待联系"）。

export interface PriorityCandidateView extends PriorityCandidateCore {
  leadId: string;
  name: string;
  stageId: string;
  stageName: string;
  /** 人工优先级字段徽标（K6 双轨制：与规则理由分开展示） */
  priority: LeadPriority;
  contactName: string | null;
  contactPhone: string | null;
}

export async function suggestPriorityLeads(
  user: AuthUser,
  options: { now?: Date; limit?: number } = {},
): Promise<PriorityCandidateView[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 5;
  const today = toShanghaiDateString(now);
  // 半年窗口上界（月粒度 P4）：到期 ≤ M+6 月末（含已过期——过期更需核实续费）
  const upperBound = expiryMonthToUtcDate(
    addExpiryMonths(currentExpiryMonth(now), 7),
  );

  const scope = leadReadScope(user);
  const candidates = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
      stage: { semanticKey: { notIn: [...TASK_GENERATION_TERMINAL_STAGES] } },
      OR: [
        { nextContactAt: { gte: startOfShanghaiDay(0, now), lt: startOfShanghaiDay(1, now) } },
        { contractExpiry: { lte: upperBound, not: null } },
        { OR: [{ profileStatus: "incomplete" as const }, { profileStatus: null }] },
      ],
    },
    select: {
      id: true,
      name: true,
      priority: true,
      contactName: true,
      contactPhone: true,
      contractExpiry: true,
      contractExpiryStatus: true,
      nextContactAt: true,
      profileStatus: true,
      createdAt: true,
      stage: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
    take: 500,
  });

  const rows: PriorityCandidateView[] = [];
  for (const lead of candidates) {
    const { reasons, score } = evaluatePriorityReasons(
      {
        contractExpiryDate:
          lead.contractExpiry === null
            ? null
            : toUtcDateString(lead.contractExpiry),
        contractExpiryStatus: lead.contractExpiryStatus,
        nextContactDate:
          lead.nextContactAt === null
            ? null
            : toShanghaiDateString(lead.nextContactAt),
        profileIncomplete:
          lead.profileStatus === "incomplete" || lead.profileStatus === null,
      },
      today,
    );
    if (reasons.length === 0) {
      continue;
    }
    rows.push({
      leadId: lead.id,
      name: lead.name,
      stageId: lead.stage.id,
      stageName: lead.stage.name,
      priority: lead.priority,
      contactName: lead.contactName,
      contactPhone: lead.contactPhone,
      contractExpiryDate:
        lead.contractExpiry === null
          ? null
          : toUtcDateString(lead.contractExpiry),
      nextContactDate:
        lead.nextContactAt === null
          ? null
          : toShanghaiDateString(lead.nextContactAt),
      createdAt: lead.createdAt.toISOString(),
      reasons,
      score,
    });
  }

  rows.sort(comparePriorityCandidates);
  return rows.slice(0, limit);
}
