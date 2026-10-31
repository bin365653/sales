import { expiryWindow, currentExpiryMonth } from "@/lib/expiry";
import { startOfShanghaiDay } from "@/lib/tasks";

// 跟进任务生成决策（V2.0-T06，实施计划 §4.5，纯函数无 IO——R6：
// 周期/anchor/轮次规则在此单测固化，引擎只负责按决策落库）。
//
// 四类任务源与互斥（§4.2/§4.5）：
// - 到期窗口 within_6m / expired → expiry_monthly（系统强制，priority 3，
//   同月唯一 cycleKey=M{YYYY-MM}）；
// - 到期未知（值为空或核实状态 unknown）→ profile_gap（priority 4，
//   cycleKey=G{YYYY-MM}，不套用普通长期策略）；
// - beyond_6m（含 2099 买断）且象限已定 → quadrant_periodic（priority 5，
//   cycleKey=轮次序号；客户有 pending 手工/约定任务时本轮跳过——约定优先）；
// - manual 不由引擎生成。
// 欠账只补当前一轮（R6 防洪泛）：anchor + intervalDays 已过也只生成一条
// dueAt=今天的任务，不追溯历史轮次。

export type QuadrantCode = "a" | "b" | "c" | "d";

export interface FollowupPolicyLite {
  id: string;
  quadrantCode: QuadrantCode | null;
  intervalDays: number;
  advanceDays: number;
  taskType: string;
  isActive: boolean;
  isSystem: boolean;
}

/** 画像补充任务的默认生成提前量（§4.5：生成日+advanceDays 默认 3 天） */
export const PROFILE_GAP_ADVANCE_DAYS = 3;

export interface GenerationLeadContext {
  now: Date;
  quadrant: QuadrantCode | null;
  contractExpiry: Date | null;
  /** contract_expiry 核实行状态（unknown 视同到期未知，§4.2） */
  expiryVerificationStatus: string;
  /** 生成锚点 = max(最后沟通 occurredAt, 最近完成任务 completedAt, quadrant_computed_at, createdAt) */
  anchor: Date;
  /** 该客户是否有 pending 的手工任务（约定/预约优先，§4.5 防重 #1/#3） */
  hasPendingManualTask: boolean;
  systemPolicy: FollowupPolicyLite | null;
  quadrantPolicies: Partial<Record<QuadrantCode, FollowupPolicyLite>>;
  /** 每策略已存在的「有效」周期键（status ∈ planned/task_created） */
  activeCycleKeys: Map<string, Set<string>>;
  /** 每策略的历史周期行数（不含 superseded——被重算取代的轮次不计） */
  roundCount: Map<string, number>;
}

export interface AutoTaskDecision {
  sourceType: "expiry_monthly" | "profile_gap" | "quadrant_periodic";
  policyId: string;
  cycleKey: string;
  title: string;
  /** 任务截止时间（到期月度/核实=今天；画像补充=今天+提前量；周期=anchor+interval，欠账收敛到今天） */
  dueAt: Date;
  /** 周期行 planned_date（@db.Date，上海日历日） */
  plannedDate: string;
  priority: number;
}

/** 上海日界起点（任务 dueAt 统一落在当日 00:00+08，与手工任务补录口径一致） */
function shanghaiDayStart(now: Date): Date {
  return startOfShanghaiDay(0, now);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

function monthOf(date: Date): string {
  return currentExpiryMonth(date);
}

/** 上海日历日 "YYYY-MM-DD"（@db.Date 与 planned_date 的口径；按 UTC 取日期会差一天） */
function shanghaiDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const QUADRANT_LETTER: Record<QuadrantCode, string> = {
  a: "A",
  b: "B",
  c: "C",
  d: "D",
};

/**
 * 单客户单轮自动任务决策（幂等的纯计算；同输入恒同输出）。
 * 返回 0–1 条决策：三类任务源互斥（if/else 链），每类内部由
 * activeCycleKeys 判定同周期是否已有有效计划。
 */
export function decideAutoTasks(ctx: GenerationLeadContext): AutoTaskDecision[] {
  const window = expiryWindow(ctx.contractExpiry, ctx.now, {
    status: ctx.expiryVerificationStatus,
  });
  const month = monthOf(ctx.now);
  const today = shanghaiDayStart(ctx.now);
  const sys = ctx.systemPolicy;

  // 半年内（含第 6 个月边界）或已过期 → 系统月度强制任务（§4.2）
  if (window === "within_6m" || window === "expired") {
    if (!sys || !sys.isActive) {
      return [];
    }
    const cycleKey = `M${month}`;
    if (ctx.activeCycleKeys.get(sys.id)?.has(cycleKey)) {
      return [];
    }
    const expired = window === "expired";
    return [
      {
        sourceType: "expiry_monthly",
        policyId: sys.id,
        cycleKey,
        title: expired
          ? "软件到期状态核实"
          : `软件到期月度跟进（${month}）`,
        dueAt: today,
        plannedDate: shanghaiDateKey(today),
        priority: 3,
      },
    ];
  }

  // 到期未知 → 画像补充任务（不套用普通长期策略）
  if (window === "unknown") {
    if (!sys || !sys.isActive) {
      return [];
    }
    const cycleKey = `G${month}`;
    if (ctx.activeCycleKeys.get(sys.id)?.has(cycleKey)) {
      return [];
    }
    const dueAt = addDays(today, PROFILE_GAP_ADVANCE_DAYS);
    return [
      {
        sourceType: "profile_gap",
        policyId: sys.id,
        cycleKey,
        title: "画像补充核实",
        dueAt,
        plannedDate: shanghaiDateKey(dueAt),
        priority: 4,
      },
    ];
  }

  // 超半年（含 2099 买断）→ 四象限周期任务（象限已定 + 策略启用）
  if (ctx.quadrant === null) {
    return [];
  }
  const policy = ctx.quadrantPolicies[ctx.quadrant];
  if (!policy || !policy.isActive) {
    return [];
  }
  // 约定优先：客户有 pending 手工/预约任务时，本轮不生成周期任务（防重 #1/#3）
  if (ctx.hasPendingManualTask) {
    return [];
  }
  // 同策略已有「有效」周期行（planned/task_created，任意轮次）→ 本轮已生成，跳过
  if ((ctx.activeCycleKeys.get(policy.id)?.size ?? 0) > 0) {
    return [];
  }
  const naturalDue = addDays(ctx.anchor, policy.intervalDays);
  // 提前量：把生成时点提前 advanceDays 天（任务截止仍是自然到期日）
  const generateFrom = addDays(naturalDue, -policy.advanceDays);
  if (generateFrom.getTime() > today.getTime()) {
    return [];
  }
  const round = (ctx.roundCount.get(policy.id) ?? 0) + 1;
  const dueAt =
    naturalDue.getTime() <= today.getTime() ? today : naturalDue;
  return [
    {
      sourceType: "quadrant_periodic",
      policyId: policy.id,
      cycleKey: String(round),
      title: `四象限周期跟进（${QUADRANT_LETTER[ctx.quadrant]}·${policy.intervalDays}天）`,
      dueAt,
      plannedDate: shanghaiDateKey(dueAt),
      priority: 5,
    },
  ];
}

/**
 * 自动任务的原因行文案（UIUX §5.4：自动任务必显示，来自生成规则，§7.2 红线
 * 文案）；任务行由服务端按来源+客户当前到期状态派生，前端不自算。
 */
export function autoTaskReasonLabel(
  sourceType: string,
  context: {
    contractExpiry: Date | null;
    expiryVerificationStatus: string;
    quadrant: QuadrantCode | null;
    intervalDays?: number | null;
    now: Date;
  },
): string | null {
  if (sourceType === "manual") {
    return null;
  }
  const window = expiryWindow(context.contractExpiry, context.now, {
    status: context.expiryVerificationStatus,
  });
  if (sourceType === "expiry_monthly") {
    if (window === "expired") {
      return "软件已过期：系统持续生成核实任务，直至确认续费、换系统或停止使用";
    }
    return `软件 ${context.contractExpiry ? monthOf(context.contractExpiry) : "—"} 到期，处于半年内窗口，系统按月度规则生成本月跟进任务（该规则优先于象限策略，不可覆盖）`;
  }
  if (sourceType === "profile_gap") {
    return "软件到期时间未知：先补充画像核实到期情况，暂不套用长期跟进策略";
  }
  if (sourceType === "quadrant_periodic") {
    const letter = context.quadrant ? QUADRANT_LETTER[context.quadrant] : "—";
    const days = context.intervalDays ?? "—";
    return `按 ${letter} 象限策略每 ${days} 天周期跟进（策略修改只影响之后生成的任务）`;
  }
  return null;
}

/** 任务来源徽章文案（UIUX §3.1：到期月度/四象限周期/画像补充；手工不显示） */
export const TASK_SOURCE_BADGE_LABELS: Record<string, string> = {
  expiry_monthly: "到期月度",
  quadrant_periodic: "四象限周期",
  profile_gap: "画像补充",
};
