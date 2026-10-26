import { AuthUser } from "@/lib/auth";
import { LeadPriority } from "@/lib/format";
import {
  comparePriorityCandidates,
  countFilledProfileFields,
  evaluatePriorityReasons,
  PriorityCandidateCore,
} from "@/lib/metrics";
import { toShanghaiDateString, toUtcDateString } from "@/lib/format";
import { shiftDateString } from "@/lib/worktime";
import { startOfShanghaiDay } from "@/lib/tasks";
import { prisma } from "@/server/db";
import { leadReadScope } from "@/server/permissions";

// 建议优先联系规则引擎（T12，K6 / UIUX P2 核心区）。
//
// K6 双轨制：`priority` 列是人工管理字段，本模块的"建议优先联系"由
// 确定性规则生成并附理由（规则与理由文案见 src/lib/metrics.ts），
// AI 不参与优先级计算；缺少采购信号的客户不产生任何理由（无"高意向"话术）。
//
// 候选集用 OR 超集查询（今日待联系 / 合同 30 天内到期 / 从未联系），
// 规则评估在应用层逐条执行（纯函数，固定 fixtures 单测对账），
// 排序经 comparePriorityCandidates（权重 → 合同到期 → 下次联系 → 创建时间）。

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
  const todayStart = startOfShanghaiDay(0, now);
  const tomorrowStart = startOfShanghaiDay(1, now);
  // 合同到期窗口：今天（含已过期）～ 今天+30 天（@db.Date 按 UTC 日期比较）
  const contractUpperBound = new Date(
    `${shiftDateString(today, 30)}T00:00:00.000Z`,
  );

  const scope = leadReadScope(user);
  const candidates = await prisma.lead.findMany({
    where: {
      deletedAt: null,
      ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
      OR: [
        { nextContactAt: { gte: todayStart, lt: tomorrowStart } },
        { contractExpiry: { lte: contractUpperBound } },
        { lastContactAt: null },
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
      lastContactAt: true,
      createdAt: true,
      city: true,
      industry: true,
      mainCategory: true,
      source: true,
      salesTeamSize: true,
      salesMode: true,
      currentSystem: true,
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
        neverContacted: lead.lastContactAt === null,
        profileFilledCount: countFilledProfileFields(lead),
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
