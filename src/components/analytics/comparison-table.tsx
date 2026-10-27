import { SAMPLE_INSUFFICIENT_NOTICE } from "@/lib/analytics";
import type { GroupComparisonResult } from "@/lib/analytics";

// 实验对比表（PRD §5.10 / UIUX P7 ▍AI 组对比；P8"复用 P7 对比表组件"）。
// 四要素齐全：样本量（列头）、比例、绝对差异（百分点）、统计周期；
// 样本量 < 阈值时整表顶部黄色横幅 SAMPLE_INSUFFICIENT_NOTICE，
// 组件内不存在也不允许出现"提升 X%"类结论文案（§5.10 红线，纯函数层只给数值）。
//
// T13 交付组件与口径（computeGroupComparison 纯函数 + 本组件，单测固化）；
// 数据接入随 T14 实验分组交付——/analytics 页在拿到实验数据前仅展示占位说明。

export interface ComparisonRow {
  /** 指标名（如"有效沟通率"） */
  metricLabel: string;
  comparison: GroupComparisonResult;
}

export function ExperimentComparisonTable({
  experimentName,
  periodLabel,
  controlLabel = "常规组",
  assistedLabel = "AI 辅助组",
  controlSampleSize,
  assistedSampleSize,
  rows,
}: {
  experimentName: string;
  periodLabel: string;
  controlLabel?: string;
  assistedLabel?: string;
  controlSampleSize: number;
  assistedSampleSize: number;
  rows: ComparisonRow[];
}) {
  const insufficient = rows.some((row) => row.comparison.insufficient);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">AI 组对比：{experimentName}</h2>
        <span className="text-xs text-gray-400">
          统计周期：{periodLabel}
        </span>
      </div>
      {insufficient && (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ⚠ {SAMPLE_INSUFFICIENT_NOTICE}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-100 text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 pr-4 font-medium">指标</th>
              <th className="py-2 pr-4 font-medium">
                {controlLabel}（{controlSampleSize}）
              </th>
              <th className="py-2 pr-4 font-medium">
                {assistedLabel}（{assistedSampleSize}）
              </th>
              <th className="py-2 font-medium">绝对差异</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.metricLabel} className="border-b border-gray-100">
                <td className="py-2 pr-4 text-gray-700">{row.metricLabel}</td>
                <td className="py-2 pr-4 tabular-nums">
                  {row.comparison.controlRatio === null
                    ? "—"
                    : `${row.comparison.controlRatio}%`}
                </td>
                <td className="py-2 pr-4 tabular-nums">
                  {row.comparison.assistedRatio === null
                    ? "—"
                    : `${row.comparison.assistedRatio}%`}
                </td>
                <td className="py-2 tabular-nums">
                  {row.comparison.diffPp === null
                    ? "—"
                    : `${row.comparison.diffPp > 0 ? "+" : ""}${row.comparison.diffPp}pp`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
