// 看板纯函数口径（T13，PRD §5.9 / §5.10 / UIUX P7）。
//
// 与 src/lib/metrics.ts 分工：metrics.ts 固化比率/优先规则的"计算"，
// 本模块固化看板层其余纯逻辑——周期解析（C13 上海日历日）、漏斗行文案、
// "—"原因文案与实验对比表（P7 组件与 P8 复用，数据随 T14 接入）。
// 均为纯函数：单测逐项对账，server 层与页面只消费不复制逻辑。

import { workweekDays, workweekStart } from "@/lib/worktime";
import type { MetricsPeriod } from "@/lib/metrics";
import type { AnalyticsPeriodPreset } from "@/lib/schemas/analytics";

// ---------- 周期解析（上海日历日，C13） ----------

/** 上海时区的今天（YYYY-MM-DD）——与 lib/format 同一 Intl 口径 */
function shanghaiToday(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 某日所在月的月末（YYYY-MM-DD）；跨年/闰年由 UTC 日历数学保证 */
function monthEnd(dayString: string): string {
  const year = Number(dayString.slice(0, 4));
  const month = Number(dayString.slice(5, 7));
  return `${dayString.slice(0, 7)}-${String(
    new Date(Date.UTC(year, month, 0)).getUTCDate(),
  ).padStart(2, "0")}`;
}

/**
 * 看板周期解析（PRD §5.9 日期筛选）：今日 / 本周（周一起算）/ 本月 /
 * 自定义闭区间。输入已由 analyticsQuerySchema 校验（custom 时 from/to 必填
 * 且 from ≤ to），本函数不再重复校验。
 */
export function resolveAnalyticsPeriod(
  preset: AnalyticsPeriodPreset,
  now: Date,
  custom?: { from: string; to: string },
): MetricsPeriod {
  const today = shanghaiToday(now);
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const days = workweekDays(workweekStart(today));
      return { from: days[0], to: days[6] };
    }
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: monthEnd(today) };
    case "custom":
      return { from: custom!.from, to: custom!.to };
  }
}

// ---------- 漏斗行（UIUX P7：呼出→接通→有效→合格→预约→演示→报价→成交） ----------

export interface FunnelRow {
  key: keyof FunnelRowCounts;
  label: string;
  value: number;
}

/** FunnelCounts 的结构别名（避免与 server 层类型反向依赖） */
export interface FunnelRowCounts {
  outboundCalls: number;
  connectedCalls: number;
  effectiveCommunications: number;
  qualifiedLeads: number;
  demoBookings: number;
  demoCompletions: number;
  quotes: number;
  deals: number;
}

/** 漏斗 8 行固定顺序与文案（UIUX P7 漏斗示意）；比值行由比率区展示 */
export function buildFunnelRows(counts: FunnelRowCounts): FunnelRow[] {
  return [
    { key: "outboundCalls", label: "呼出", value: counts.outboundCalls },
    { key: "connectedCalls", label: "接通", value: counts.connectedCalls },
    {
      key: "effectiveCommunications",
      label: "有效沟通",
      value: counts.effectiveCommunications,
    },
    { key: "qualifiedLeads", label: "合格线索", value: counts.qualifiedLeads },
    { key: "demoBookings", label: "预约演示", value: counts.demoBookings },
    {
      key: "demoCompletions",
      label: "演示完成",
      value: counts.demoCompletions,
    },
    { key: "quotes", label: "报价", value: counts.quotes },
    { key: "deals", label: "成交", value: counts.deals },
  ];
}

// ---------- 展示辅助（"—" 规则，C03/§4.6） ----------

/** 周期文案（看板标题旁）；自定义范围直接展示闭区间 */
export function formatAnalyticsPeriodLabel(
  preset: AnalyticsPeriodPreset,
  period: MetricsPeriod,
): string {
  switch (preset) {
    case "today":
      return `今日（${period.from}）`;
    case "week":
      return `本周（${period.from.slice(5)} ~ ${period.to.slice(5)}）`;
    case "month":
      return `本月（${period.from.slice(0, 7)}）`;
    case "custom":
      return `${period.from} ~ ${period.to}`;
  }
}

/** 比率 → "66.7%"；null → "—"（前端绝不二次舍入/自算） */
export function formatMetricRate(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/** Dash tooltip 原因文案（§4.6：分母为 0 / 未填报工时，禁止显示 0%） */
export const DASH_REASON_ZERO_DENOMINATOR = "分母为 0，无法计算";
export const DASH_REASON_NO_WORKTIME = "未填报工时，无法计算";
export const DASH_REASON_ZERO_WORKTIME = "填报工时为 0，无法计算";

/** 每小时有效沟通的 "—" 原因（工时分母三种形态；比率 null 且工时>0 不存在） */
export function effectivePerHourDashReason(workHours: number | null): string {
  if (workHours === null) {
    return DASH_REASON_NO_WORKTIME;
  }
  return workHours <= 0 ? DASH_REASON_ZERO_WORKTIME : DASH_REASON_ZERO_DENOMINATOR;
}

/** 看板主区空态（UIUX §7.4）：漏斗 8 项全 0 即视为该范围无沟通数据 */
export function isFunnelEmpty(counts: FunnelRowCounts): boolean {
  return buildFunnelRows(counts).every((row) => row.value === 0);
}

// ---------- 实验对比表（PRD §5.10；P7 组件 + P8 复用，数据随 T14 接入） ----------
//
// 只输出 数字/布尔：样本量、比例、绝对差异（百分点）、样本是否不足。
// 不产出任何"提升 X%"类结论文案——样本不足时 UI 只显示横幅
// SAMPLE_INSUFFICIENT_NOTICE，绝不宣称因果提升（§5.10 红线）。

export interface ExperimentGroupStat {
  /** 组内线索数（样本量） */
  sampleSize: number;
  /** 命中数（如"有效沟通数>0 的线索"——分子口径由调用方（T14）决定并标注） */
  hits: number;
}

export interface GroupComparisonResult {
  controlRatio: number | null;
  assistedRatio: number | null;
  /** 绝对差异（百分点，AI 辅助组 − 常规组）；任一组比例缺失时 null */
  diffPp: number | null;
  /** 任一组样本量 < minSampleSize → true（整表顶部横幅，不给结论） */
  insufficient: boolean;
}

/** 实验最小样本阈值默认值（UIUX P8"最小样本阈值(默认 50)"） */
export const EXPERIMENT_DEFAULT_MIN_SAMPLE = 50;

export const SAMPLE_INSUFFICIENT_NOTICE = "样本不足，暂不宜判断";

function groupRatioPercent(group: ExperimentGroupStat): number | null {
  if (group.sampleSize <= 0) {
    return null;
  }
  return Math.round((group.hits / group.sampleSize) * 1000) / 10;
}

/**
 * 两组对比（纯函数）：比例 = 命中/样本量 ×100（1 位小数），
 * 绝对差异 = AI 辅助组比例 − 常规组比例（百分点，1 位小数）。
 * 样本不足只置 insufficient 标志，不参与数值计算。
 */
export function computeGroupComparison(
  control: ExperimentGroupStat,
  assisted: ExperimentGroupStat,
  minSampleSize: number = EXPERIMENT_DEFAULT_MIN_SAMPLE,
): GroupComparisonResult {
  const controlRatio = groupRatioPercent(control);
  const assistedRatio = groupRatioPercent(assisted);
  return {
    controlRatio,
    assistedRatio,
    diffPp:
      controlRatio === null || assistedRatio === null
        ? null
        : Math.round((assistedRatio - controlRatio) * 10) / 10,
    insufficient:
      control.sampleSize < minSampleSize || assisted.sampleSize < minSampleSize,
  };
}
