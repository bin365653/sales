import type { FunnelRow } from "@/lib/analytics";
import { RateValue } from "@/components/analytics/metric-dash";
import type { MetricRates } from "@/lib/metrics";

// 转化漏斗（UIUX P7 ▍转化漏斗）：呼出→接通→有效→合格→预约→演示→报价→成交
// 8 行横向条形 + 图下四项比率。用纯 CSS 条形而非图表库——无新依赖、
// 禁 JS 可用、移动端自然纵向堆叠（§P7 移动端"漏斗转纵向"）。
// 数值一律来自指标引擎（FunnelRow），本组件不做任何计算，条宽为纯展示。

export function FunnelSection({
  rows,
  rates,
}: {
  rows: FunnelRow[];
  rates: MetricRates;
}) {
  const max = Math.max(...rows.map((row) => row.value), 1);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-base font-semibold">转化漏斗</h2>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-right text-xs text-gray-500">
              {row.label}
            </span>
            <div className="h-5 min-w-0 flex-1 rounded-sm bg-gray-50">
              <div
                className="h-5 rounded-sm bg-blue-500/80"
                style={{ width: `${Math.max((row.value / max) * 100, row.value > 0 ? 2 : 0)}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-gray-900">
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-gray-100 pt-3 text-sm">
        <RateCell label="接通率" value={rates.connectRate} />
        <RateCell label="有效沟通率" value={rates.effectiveRate} />
        <RateCell label="合格线索率" value={rates.qualifiedRate} />
        <RateCell label="预约转化率" value={rates.bookingRate} />
      </div>
      <p className="mt-2 text-xs text-gray-400">
        阶段转化基于线索阶段推进记录（lead_events）按同批线索计算，非跨批次混合；同一线索多次进出同一阶段只计首次。
      </p>
    </section>
  );
}

function RateCell({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-gray-500">{label}</span>
      <RateValue value={value} />
    </span>
  );
}
