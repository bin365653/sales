import { computeGroupComparison } from "@/lib/analytics";
import type { GroupComparisonResult } from "@/lib/analytics";

// 实验分组展示层纯逻辑（T14，PRD §5.10 / UIUX P8）：
// 状态/分组徽章文案与配色、常规组说明卡文案、对比行组装。
// 对比口径（比例/绝对差异/样本不足标志）一律经 lib/analytics 的
// computeGroupComparison（T13 已单测固化），本模块只做"命中数 → 对比行"的组装，
// 不复制任何比率计算（server 层与页面只消费）。

export const EXPERIMENT_STATUS_LABELS = {
  draft: "草稿",
  running: "进行中",
  closed: "已关闭",
} as const;

export type ExperimentStatusValue = keyof typeof EXPERIMENT_STATUS_LABELS;

export const EXPERIMENT_STATUS_BADGE_CLASS: Record<
  ExperimentStatusValue,
  string
> = {
  draft: "bg-gray-100 text-gray-600",
  running: "bg-emerald-50 text-emerald-700",
  closed: "bg-gray-100 text-gray-400",
};

export const EXPERIMENT_GROUP_LABELS = {
  control: "常规组",
  assisted: "AI 辅助组",
} as const;

export type ExperimentGroupValue = keyof typeof EXPERIMENT_GROUP_LABELS;

/** UIUX §5 分组徽章色：常规组 = 灰 #64748B，AI 辅助组 = 紫（--ai）；
 * 带文字，与阶段紫徽章不会混淆 */
export const EXPERIMENT_GROUP_BADGE_CLASS: Record<
  ExperimentGroupValue,
  string
> = {
  control: "bg-[#64748B] text-white",
  assisted: "bg-violet-600 text-white",
};

/** 常规组说明卡文案（UIUX §4.7/§7.2；服务端 403 message 同文） */
export const CONTROL_GROUP_NOTICE =
  "该客户属于实验常规组，按实验设计不提供 AI 辅助。";

/** 执行分组强确认（UIUX P8 / M3） */
export const ASSIGN_CONFIRM_TEXT =
  "分组结果随机生成后固定不可修改，确定执行？";

/** 分组规则快照中的执行方式说明（随 assignment.rule_snapshot 落库，PRD §5.10） */
export const ASSIGN_CONFIRM_RULE_NOTE = "random: 圈选范围内随机分组，结果固定不可修改";

// ---------- 对比行组装（命中数 → computeGroupComparison） ----------

/** 对比指标键（server/metrics/experiment 命中口径的唯一键位） */
export type ExperimentMetricKey =
  | "effective"
  | "qualified"
  | "booked_demo"
  | "won"
  | "ai_used";

export interface ExperimentMetricCounts {
  control: Record<ExperimentMetricKey, number>;
  assisted: Record<ExperimentMetricKey, number>;
}

export interface ExperimentMetricDef {
  key: ExperimentMetricKey;
  /** 表格行名（如"有效沟通率"） */
  label: string;
  /** 命中口径副标注（对比表下方统一注明，避免"提升 X%"式结论） */
  basis: string;
}

export const EXPERIMENT_COMPARISON_METRICS: readonly ExperimentMetricDef[] = [
  {
    key: "effective",
    label: "有效沟通率",
    basis: "周期内发生过有效沟通的线索占组内样本比例",
  },
  {
    key: "qualified",
    label: "合格线索率",
    basis: "周期内首次进入「合格商机」阶段的线索占组内样本比例",
  },
  {
    key: "booked_demo",
    label: "预约演示率",
    basis: "周期内首次进入「预约演示」阶段的线索占组内样本比例",
  },
  {
    key: "won",
    label: "成交率",
    basis: "周期内首次进入「成交」阶段的线索占组内样本比例",
  },
  {
    key: "ai_used",
    label: "AI 使用率",
    basis: "周期内有过成功 AI 调用记录的线索占组内样本比例（AI 是否实际使用以 ai_runs 成功记录为准）",
  },
] as const;

export interface ExperimentComparisonRow {
  metricKey: ExperimentMetricKey;
  metricLabel: string;
  comparison: GroupComparisonResult;
}

/**
 * 组装对比行：每指标一组 {样本量下的命中数} → computeGroupComparison。
 * 样本量 = 分组时的组内线索数（固定，不随统计周期变化）；
 * 命中数 = 周期内达成该指标的线索数（去重）。
 */
export function buildExperimentComparisonRows(
  counts: ExperimentMetricCounts,
  controlSampleSize: number,
  assistedSampleSize: number,
  minSampleSize: number,
): ExperimentComparisonRow[] {
  return EXPERIMENT_COMPARISON_METRICS.map((metric) => ({
    metricKey: metric.key,
    metricLabel: metric.label,
    comparison: computeGroupComparison(
      { sampleSize: controlSampleSize, hits: counts.control[metric.key] },
      { sampleSize: assistedSampleSize, hits: counts.assisted[metric.key] },
      minSampleSize,
    ),
  }));
}
