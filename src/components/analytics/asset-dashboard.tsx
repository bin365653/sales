import Link from "next/link";
import { QuadrantBadge } from "@/components/leads/quadrant-badge";
import { MetricDash } from "@/components/analytics/metric-dash";
import type { CustomerAssetDashboard } from "@/server/services/asset-dashboard";
import { QUADRANT_LABELS } from "@/components/leads/quadrant-badge";

// 客户资产看板（V2.0-T13，PRD 模块九 / UIUX §5.8）：九项指标 + 象限分布条。
// 快照型指标（分布/待完善/到期/同批转化）为当前全量口径；
// 周期型指标（月度任务完成率/到期有效沟通率/培育激活）固定自然月，口径注明。
// 分母 0 一律 Dash（"—"），绝不显示 0%（C03 沿用）；转化率注明同批口径。

const QUADRANT_BAR_CLASS: Record<string, string> = {
  a: "bg-blue-500",
  b: "bg-teal-500",
  c: "bg-emerald-500",
  d: "bg-gray-400",
  pending: "bg-amber-500",
};

function MetricCell({
  label,
  children,
  note,
}: {
  label: string;
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="mt-0.5 text-xl font-semibold tabular-nums text-gray-900">
        {children}
      </span>
      {note && <span className="mt-0.5 text-xs text-gray-400">{note}</span>}
    </div>
  );
}

export function AssetDashboardSection({ view }: { view: CustomerAssetDashboard }) {
  const maxCount = Math.max(
    ...view.quadrantDistribution.map((row) => row.count),
    1,
  );

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">客户资产看板</h2>
        <span className="text-xs text-gray-400">
          快照截至 {view.generatedLabel} · {view.scopeLabel} ·
          周期型指标口径={view.monthLabel}
        </span>
      </div>

      {/* 象限分布横向条形（点击跳对应列表筛选） */}
      <div className="mt-3 flex flex-col gap-2">
        {view.quadrantDistribution.map((row) => (
          <Link
            key={row.code}
            href={`/leads?quadrant=${row.code}`}
            className="flex items-center gap-2 rounded-md px-1 py-0.5 transition hover:bg-gray-50"
          >
            <span className="w-28 shrink-0">
              <QuadrantBadge code={row.code} />
            </span>
            <span className="h-3 flex-1 overflow-hidden rounded-full bg-gray-100">
              <span
                className={`block h-full ${QUADRANT_BAR_CLASS[row.code] ?? "bg-gray-300"}`}
                style={{ width: `${Math.round(((row.count / maxCount) * 100))}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right text-sm tabular-nums text-gray-700">
              {row.count}
              {row.ratio === null ? "" : ` · ${row.ratio}%`}
            </span>
          </Link>
        ))}
      </div>

      {/* 九项指标卡 */}
      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-gray-100 pt-4 sm:grid-cols-3 lg:grid-cols-4">
        <MetricCell label="画像待完善客户" note="核心画像未全部核实（P5）">
          {view.profileGapCount}
        </MetricCell>
        <MetricCell label="软件半年内到期" note="含已过期；月粒度口径（P4）">
          {view.expiringSoonCount}
        </MetricCell>
        <MetricCell
          label={`每月跟进任务完成率（${view.monthLabel}）`}
          note={`到期月度任务 ${view.monthlyTaskCompletion.done}/${view.monthlyTaskCompletion.due}`}
        >
          {view.monthlyTaskCompletion.rate === null ? (
            <MetricDash reason={`${view.monthLabel}没有应完成的到期月度任务`} />
          ) : (
            `${view.monthlyTaskCompletion.rate}%`
          )}
        </MetricCell>
        <MetricCell
          label={`到期客户有效沟通率（${view.monthLabel}）`}
          note={`有效 ${view.expiryEffectiveRate.effective}/${view.expiryEffectiveRate.total}（到期=半年内含已过期）`}
        >
          {view.expiryEffectiveRate.rate === null ? (
            <MetricDash reason={`${view.monthLabel}没有与到期客户的沟通`} />
          ) : (
            `${view.expiryEffectiveRate.rate}%`
          )}
        </MetricCell>
      </div>

      {/* 各象限同批转化（指标 6/7/8） */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
              <th className="px-2 py-2 font-medium">象限</th>
              <th className="px-2 py-2 font-medium">同批客户</th>
              <th className="px-2 py-2 font-medium">合格商机率</th>
              <th className="px-2 py-2 font-medium">演示转化率</th>
              <th className="px-2 py-2 font-medium">成交客户</th>
              <th className="px-2 py-2 font-medium">成交贡献</th>
            </tr>
          </thead>
          <tbody>
            {view.quadrantFunnel.map((row) => (
              <tr key={row.code} className="border-b border-gray-50 last:border-b-0">
                <td className="px-2 py-2">
                  <span className="text-xs text-gray-600">
                    {QUADRANT_LABELS[row.code]}
                  </span>
                </td>
                <td className="px-2 py-2 tabular-nums">{row.cohort}</td>
                <td className="px-2 py-2 tabular-nums">
                  {row.qualifiedRate === null ? (
                    <MetricDash reason="该象限暂无客户" />
                  ) : (
                    `${row.qualifiedRate}%（${row.qualified}）`
                  )}
                </td>
                <td className="px-2 py-2 tabular-nums">
                  {row.demoRate === null ? (
                    <MetricDash reason="该象限暂无客户" />
                  ) : (
                    `${row.demoRate}%（${row.demo}）`
                  )}
                </td>
                <td className="px-2 py-2 tabular-nums">{row.won}</td>
                <td className="px-2 py-2 tabular-nums">
                  {row.wonShare === null ? (
                    <MetricDash reason="全量暂无成交客户" />
                  ) : (
                    `${row.wonShare}%`
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <MetricCell label={`长期培育激活（${view.monthLabel}）`} note="本月有有效沟通的 B/D 象限客户数（去重）">
        {view.nurtureActivated}
      </MetricCell>

      <p className="mt-3 text-xs text-gray-400">
        ⓘ 转化率按同一批客户的实际阶段变化计算：同批 = 当前象限划分的存量客户，
        转化 = 该客户历史上首次进入对应阶段（首次进入语义，同线索可多次进出只计首次）。
        快照型指标不随看板周期筛选联动；周期型指标固定自然月。
      </p>
    </section>
  );
}
