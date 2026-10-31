import { prisma } from "@/server/db";
import { AuthUser } from "@/lib/auth";
import { leadReadScope } from "@/server/permissions";
import { toShanghaiDateString } from "@/lib/format";
import {
  currentExpiryMonth,
  addExpiryMonths,
  toExpiryMonth,
} from "@/lib/expiry";
import { countLeadsByExpiryView } from "@/server/services/leads";
import { loadAnchorStageMap } from "@/server/metrics/engine";
import {
  buildQuadrantDistribution,
  buildQuadrantFunnel,
  computeExpiryEffectiveRate,
  computeMonthlyTaskCompletion,
  countNurtureActivated,
  type AssetQuadrant,
} from "@/lib/asset-metrics";

// 客户资产看板服务（V2.0-T13，PRD 模块九 / UIUX §5.8）。
//
// 快照型指标（1–3/6–8）：当前象限/完善度/到期划分的非删除客户全集（cohort），
// 转化按"同批客户实际阶段变化"= 历史首次进入语义锚点阶段（不限周期）；
// 周期型指标（4/5/9）：固定自然月（本月，上海日历日），口径在界面注明。
// 数据范围一律经 leadReadScope（销售=本人，管理员=全量）。

const MONTH_NAMES = ["1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

/** 上海自然月起止（本月 1 日 00:00 → 次月 1 日 00:00，+08） */
function monthBounds(now: Date): { start: Date; end: Date; label: string } {
  const month = currentExpiryMonth(now);
  const start = new Date(`${month}-01T00:00:00+08:00`);
  const next = addExpiryMonths(month, 1);
  const end = new Date(`${next}-01T00:00:00+08:00`);
  const [, m] = month.split("-").map(Number);
  return { start, end, label: `${MONTH_NAMES[(m ?? 1) - 1]}` };
}

export interface CustomerAssetDashboard {
  /** 快照生成时间与数据范围说明 */
  generatedLabel: string;
  scopeLabel: string;
  /** 本月（周期型指标口径） */
  monthLabel: string;
  quadrantDistribution: ReturnType<typeof buildQuadrantDistribution>;
  profileGapCount: number;
  expiringSoonCount: number;
  monthlyTaskCompletion: ReturnType<typeof computeMonthlyTaskCompletion>;
  expiryEffectiveRate: ReturnType<typeof computeExpiryEffectiveRate>;
  quadrantFunnel: ReturnType<typeof buildQuadrantFunnel>;
  nurtureActivated: number;
}

export async function getCustomerAssetDashboard(
  user: AuthUser,
  options: { now?: Date } = {},
): Promise<CustomerAssetDashboard> {
  const now = options.now ?? new Date();
  const scope = leadReadScope(user);
  const month = monthBounds(now);

  // —— 快照集合：非删除客户按象限/完善度划分 ——
  const leads = await prisma.lead.findMany({
    where: { deletedAt: null, ...scope },
    select: {
      id: true,
      quadrantCode: true,
      profileStatus: true,
      contractExpiry: true,
      stageId: true,
    },
  });
  const profileGapCount = leads.filter(
    (lead) => lead.profileStatus === "incomplete" || lead.profileStatus === null,
  ).length;
  const cohorts = new Map<"a" | "b" | "c" | "d", Set<string>>();
  const quadrantCounts = new Map<AssetQuadrant, number>();
  for (const lead of leads) {
    const code = (lead.quadrantCode ?? "pending") as AssetQuadrant;
    quadrantCounts.set(code, (quadrantCounts.get(code) ?? 0) + 1);
    if (lead.quadrantCode) {
      const bucket = cohorts.get(lead.quadrantCode) ?? new Set<string>();
      bucket.add(lead.id);
      cohorts.set(lead.quadrantCode, bucket);
    }
  }

  // —— 首次进入语义（历史全量，不限周期）：qualified / booked_demo / won ——
  const anchorMap = await loadAnchorStageMap();
  const anchorStageIds = Array.from(anchorMap.keys());
  const stageEvents = anchorStageIds.length
    ? await prisma.leadEvent.findMany({
        where: {
          eventType: "stage_changed",
          toStageId: { in: anchorStageIds },
          lead: { deletedAt: null, ...scope },
        },
        select: { leadId: true, toStageId: true, occurredAt: true },
      })
    : [];
  const firstEntry = new Map<string, string>(); // leadId:anchor → 恒置
  for (const event of stageEvents) {
    const anchor = event.toStageId ? anchorMap.get(event.toStageId) : undefined;
    if (!anchor) {
      continue;
    }
    firstEntry.set(`${event.leadId}:${anchor}`, anchor);
  }
  const firstEntries = [...firstEntry.keys()].map((key) => ({
    leadId: key.slice(0, key.lastIndexOf(":")),
    anchor: key.slice(key.lastIndexOf(":") + 1),
  }));

  // —— 周期型：本月月度任务完成率 ——
  const monthlyTasks = await prisma.task.findMany({
    where: {
      sourceType: "expiry_monthly",
      dueAt: { gte: month.start, lt: month.end },
      lead: { deletedAt: null, ...scope },
    },
    select: { status: true, dueAt: true },
  });

  // —— 周期型：本月与到期客户的沟通（到期 = 到期月 ≤ M+6，含已过期，值非空） ——
  const monthInteractions = await prisma.interaction.findMany({
    where: {
      occurredAt: { gte: month.start, lt: month.end },
      lead: { deletedAt: null, ...scope },
    },
    select: {
      leadId: true,
      effective: true,
      lead: { select: { contractExpiry: true, quadrantCode: true } },
    },
  });

  const currentMonth = currentExpiryMonth(now);
  const expiryEffectiveRate = computeExpiryEffectiveRate(
    monthInteractions.map((row) => ({
      effective: row.effective,
      leadId: row.leadId,
      expiryMonth: row.lead.contractExpiry ? toExpiryMonth(row.lead.contractExpiry) : null,
      quadrant: (row.lead.quadrantCode ?? null) as "a" | "b" | "c" | "d" | null,
    })),
    currentMonth,
    addExpiryMonths(currentMonth, 6),
  );

  const nurtureActivated = countNurtureActivated(
    monthInteractions.map((row) => ({
      leadId: row.leadId,
      effective: row.effective,
      quadrant: (row.lead.quadrantCode ?? null) as "a" | "b" | "c" | "d" | null,
    })),
  );

  const expiringSoonCount = (await countLeadsByExpiryView(user, now)).within_6m;

  const scopeLabel = user.role === "admin" ? "全部客户" : "我的客户";

  return {
    generatedLabel: toShanghaiDateString(now),
    scopeLabel,
    monthLabel: month.label,
    quadrantDistribution: buildQuadrantDistribution(quadrantCounts),
    profileGapCount,
    expiringSoonCount,
    monthlyTaskCompletion: computeMonthlyTaskCompletion(
      monthlyTasks,
      month.start,
      month.end,
    ),
    expiryEffectiveRate,
    quadrantFunnel: buildQuadrantFunnel(
      cohorts,
      firstEntries,
      { qualified: "qualified", demo: "booked_demo", won: "won" },
    ),
    nurtureActivated,
  };
}
