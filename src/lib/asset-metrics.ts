import type { LeadQuadrantCode } from "@/lib/quadrant";

// 客户资产看板口径（V2.0-T13，PRD 模块九 / UIUX §5.8，纯函数层）。
//
// 九项指标（PRD 1:1）：
// 1. 四象限客户数量及比例（含待完善）；2. 画像待完善客户数量；
// 3. 软件半年内到期客户数量；4. 每月跟进任务完成率；
// 5. 到期客户有效沟通率；6. 各象限合格商机率；7. 各象限演示转化率；
// 8. 各象限成交贡献；9. 长期培育客户激活数量。
//
// 口径决策：
// - 比率/占比分母为 0 → null，界面显示"—"，绝不显示 0%（C03 沿用）；
// - 百分比数值已乘 100、保留 1 位小数；
// - 「客户转化率按同一批客户的实际阶段变化计算」（PRD 模块九）：
//   同批 = 当前象限划分的非删除客户全集（cohort），转化 = 该客户历史上
//   首次进入对应语义锚点阶段（首次进入语义，同 T12 引擎；不限周期——
//   客户资产是存量视图，快照型指标 1–3/6–8 不随看板周期筛选联动）；
// - 周期型指标（4/5/9）固定取自然月（本月，上海日历日），口径在界面注明；
// - 成交贡献 = 该象限 won 客户数占全部 won 客户数的比例（分母含全部象限）。

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 占比（百分数 1 位小数）；分母 0 → null（"—"） */
export function ratioPercent(numerator: number, denominator: number): number | null {
  return denominator <= 0 ? null : round1((numerator / denominator) * 100);
}

export type AssetQuadrant = LeadQuadrantCode | "pending";

export interface QuadrantDistributionRow {
  code: AssetQuadrant;
  count: number;
  ratio: number | null;
}

/** 指标 1：四象限分布（含待完善）；总分为 0 时全部 ratio=null */
export function buildQuadrantDistribution(
  counts: Map<AssetQuadrant, number>,
): QuadrantDistributionRow[] {
  const order: AssetQuadrant[] = ["a", "b", "c", "d", "pending"];
  const total = order.reduce((sum, code) => sum + (counts.get(code) ?? 0), 0);
  return order.map((code) => {
    const count = counts.get(code) ?? 0;
    return { code, count, ratio: ratioPercent(count, total) };
  });
}

export interface MonthlyTaskCompletion {
  /** 本月应完成（dueAt 落本月）的到期月度任务数（含已完成/已取消/待处理） */
  due: number;
  /** 其中已完成数 */
  done: number;
  /** 完成率；分母 0 → null */
  rate: number | null;
}

/** 指标 4：每月跟进任务完成率（本月 dueAt 落本月的 expiry_monthly 任务） */
export function computeMonthlyTaskCompletion(
  tasks: { status: string; dueAt: Date }[],
  monthStart: Date,
  monthEnd: Date,
): MonthlyTaskCompletion {
  const inMonth = tasks.filter(
    (task) => task.dueAt >= monthStart && task.dueAt < monthEnd,
  );
  const done = inMonth.filter((task) => task.status === "done").length;
  return { due: inMonth.length, done, rate: ratioPercent(done, inMonth.length) };
}

export interface ExpiryEffectiveRate {
  /** 周期内与到期客户（到期月 ≤ M+6，含已过期，值非空）的沟通数 */
  total: number;
  /** 其中有效沟通数 */
  effective: number;
  /** 有效沟通率；分母 0 → null */
  rate: number | null;
}

/** 指标 5：到期客户有效沟通率（周期型，本月） */
export function computeExpiryEffectiveRate(
  interactions: { effective: boolean; expiryMonth: string | null }[],
  currentMonth: string,
  upperBoundMonth: string,
): ExpiryEffectiveRate {
  const withExpiry = interactions.filter(
    (row) =>
      row.expiryMonth !== null &&
      row.expiryMonth <= upperBoundMonth, // 含已过期（< M）与半年内（≤ M+6）
  );
  const effective = withExpiry.filter((row) => row.effective).length;
  return {
    total: withExpiry.length,
    effective,
    rate: ratioPercent(effective, withExpiry.length),
  };
}

export interface QuadrantFunnelRow {
  code: LeadQuadrantCode;
  /** 同批客户数（当前象限划分的非删除客户） */
  cohort: number;
  /** 历史上首次进入合格商机阶段的客户数 */
  qualified: number;
  /** 合格商机率（同批口径）；cohort 0 → null */
  qualifiedRate: number | null;
  /** 历史上首次进入已预约演示阶段的客户数 */
  demo: number;
  /** 演示转化率（同批口径）；cohort 0 → null */
  demoRate: number | null;
  /** 历史上首次进入成交阶段的客户数 */
  won: number;
  /** 成交贡献 = 该象限 won 数 / 全部象限 won 数；分母 0 → null */
  wonShare: number | null;
}

/** 指标 6/7/8：各象限同批转化（首次进入语义，不限周期） */
export function buildQuadrantFunnel(
  cohorts: Map<LeadQuadrantCode, Set<string>>,
  firstEntries: { leadId: string; anchor: string }[],
  anchors: { qualified: string; demo: string; won: string },
): QuadrantFunnelRow[] {
  // 每客户每锚点只取一次（首次进入语义在引擎层已去重；此处再兜底去重）
  const entered = new Set<string>();
  for (const row of firstEntries) {
    entered.add(`${row.leadId}:${row.anchor}`);
  }
  const has = (leadId: string, anchor: string): boolean =>
    entered.has(`${leadId}:${anchor}`);

  const totalWon = (["a", "b", "c", "d"] as const).reduce(
    (sum, code) =>
      sum +
      [...(cohorts.get(code) ?? [])].filter((leadId) => has(leadId, anchors.won))
        .length,
    0,
  );

  return (["a", "b", "c", "d"] as const).map((code) => {
    const cohort = cohorts.get(code) ?? new Set<string>();
    const size = cohort.size;
    const qualified = [...cohort].filter((leadId) =>
      has(leadId, anchors.qualified),
    ).length;
    const demo = [...cohort].filter((leadId) => has(leadId, anchors.demo)).length;
    const won = [...cohort].filter((leadId) => has(leadId, anchors.won)).length;
    return {
      code,
      cohort: size,
      qualified,
      qualifiedRate: ratioPercent(qualified, size),
      demo,
      demoRate: ratioPercent(demo, size),
      won,
      wonShare: ratioPercent(won, totalWon),
    };
  });
}

/** 指标 9：长期培育激活数——周期内 B/D 象限客户中有有效沟通的客户数（去重） */
export function countNurtureActivated(
  interactions: { leadId: string; effective: boolean; quadrant: LeadQuadrantCode | null }[],
): number {
  const activated = new Set<string>();
  for (const row of interactions) {
    if (row.effective && (row.quadrant === "b" || row.quadrant === "d")) {
      activated.add(row.leadId);
    }
  }
  return activated.size;
}
