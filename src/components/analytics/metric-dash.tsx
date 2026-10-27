import {
  DASH_REASON_ZERO_DENOMINATOR,
  effectivePerHourDashReason,
} from "@/lib/analytics";

// Dash 组件（UIUX §4.6）：比率不可计算时显示"—"+ tooltip 说明原因，
// 禁止显示 0%（C03/PRD §5.9）。纯展示：原因文案取自 lib/analytics 常量，
// 不自行计算任何指标数值。

export function MetricDash({ reason }: { reason: string }) {
  return (
    <span
      title={reason}
      className="cursor-help text-lg font-semibold text-gray-300"
      aria-label={`无法计算：${reason}`}
    >
      —
    </span>
  );
}

/** 百分比类指标的 Dash（null = 分母为 0） */
export function RateValue({ value }: { value: number | null }) {
  if (value === null) {
    return <MetricDash reason={DASH_REASON_ZERO_DENOMINATOR} />;
  }
  return (
    <span className="text-lg font-semibold tabular-nums text-gray-900">
      {value}%
    </span>
  );
}

/** 每小时有效沟通的 Dash（未填报 / 工时为 0 / 分母 0 三种原因，§4.6） */
export function EffectivePerHourValue({
  value,
  workHours,
}: {
  value: number | null;
  workHours: number | null;
}) {
  if (value === null) {
    return <MetricDash reason={effectivePerHourDashReason(workHours)} />;
  }
  return (
    <span className="text-lg font-semibold tabular-nums text-gray-900">
      {value}
    </span>
  );
}
