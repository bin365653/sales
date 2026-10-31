import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { getAnalyticsDashboard } from "@/server/metrics/analytics";
import { analyticsQuerySchema } from "@/lib/schemas/analytics";
import { isFunnelEmpty } from "@/lib/analytics";
import { AnalyticsFilters } from "@/components/analytics/analytics-filters";
import { FunnelSection } from "@/components/analytics/funnel";
import { StageDistributionSection } from "@/components/analytics/stage-bars";
import { ExperimentComparisonTable } from "@/components/analytics/comparison-table";
import { AssetDashboardSection } from "@/components/analytics/asset-dashboard";
import {
  EffectivePerHourValue,
  MetricDash,
} from "@/components/analytics/metric-dash";
import { EXPERIMENT_COMPARISON_METRICS } from "@/lib/experiments";
import { getCustomerAssetDashboard } from "@/server/services/asset-dashboard";

export const dynamic = "force-dynamic";

// P7 销售数据看板（T13，PRD §5.9 / UIUX P7）：复盘转化与效率。
// 数据一律经 getAnalyticsDashboard（与 GET /api/metrics 同一实现）：
// 周期（今日/本周/本月/自定义）+ 圈选（来源/行业/阶段 + 管理员负责人）联动
// 全部指标；数值全部来自 server/metrics 唯一口径，分母不可算一律 Dash + tooltip，
// 绝不显示 0%（C03）。看板数字不做点击下钻（V1.0，避免口径歧义）。

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === "string" && single !== "") {
      flat[key] = single;
    }
  }
  // 页面容错（与线索池同策略）：非法入参回落默认本周；API 层同入参严格 400
  const parsed = analyticsQuerySchema.safeParse(flat);
  const query = parsed.success
    ? parsed.data
    : analyticsQuerySchema.parse({});

  const view = await getAnalyticsDashboard(user, query);
  // V2.0-T13：客户资产看板（快照型 + 本月周期型；与漏斗周期筛选解耦）
  const assetView = await getCustomerAssetDashboard(user);
  const { rates, filters, options } = view;
  const funnelEmpty = isFunnelEmpty(view.counts);

  const activeFilterLabels = [
    filters.source ? `来源：${filters.source}` : null,
    filters.industry ? `行业：${filters.industry}` : null,
    filters.stageId ? `阶段：${view.stageName ?? "未知阶段"}` : null,
    filters.ownerId ? `负责人：${view.ownerName ?? "未知"}` : null,
  ].filter((label): label is string => label !== null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">销售数据看板</h1>
        <span className="text-sm text-gray-500">{view.periodLabel}</span>
      </div>

      <AnalyticsFilters
        query={query}
        options={options}
        showOwner={user.role === "admin"}
      />

      <p className="text-sm text-gray-500">
        {activeFilterLabels.length > 0
          ? `当前圈选：${activeFilterLabels.join(" · ")}（按线索属性圈定同批线索后计算全部指标）`
          : "当前圈选：全部客户"}
      </p>

      {funnelEmpty && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
          所选时间范围内没有沟通数据
        </div>
      )}

      <FunnelSection rows={view.funnelRows} rates={rates} />

      {/* V2.0-T13：客户资产看板（PRD 模块九，UIUX §5.8 漏斗区下方） */}
      <AssetDashboardSection view={assetView} />

      {/* 效率与 AI（UIUX P7 ▍效率与 AI） */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-base font-semibold">效率与 AI</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col">
            <span className="text-xs text-gray-400">平均处理时长（天）</span>
            {view.avgHandleTimeDays === null ? (
              <MetricDash reason="所选范围内没有线索到达终态（合格/关闭）" />
            ) : (
              <span className="text-lg font-semibold tabular-nums text-gray-900">
                {view.avgHandleTimeDays}
              </span>
            )}
            <span className="mt-1 text-xs text-gray-400">
              线索创建 → 首次成为合格商机或关闭，未到终点的线索不计入
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-400">每小时有效沟通</span>
            <EffectivePerHourValue
              value={rates.effectivePerHour}
              workHours={view.workHours}
            />
            <span className="mt-1 text-xs text-gray-400">
              有效沟通数 / 实际销售工作小时
              {view.workHours !== null
                ? `（本周期已填报 ${view.workHours} 小时）`
                : "（本周期未填报工时）"}
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-xs text-gray-400">AI 使用次数</span>
            <span className="text-lg font-semibold tabular-nums text-gray-900">
              {view.aiRunCount}
            </span>
            <span className="mt-1 text-xs text-gray-400">
              发起即计（含失败与重试）
            </span>
          </div>
        </div>
      </section>

      <StageDistributionSection rows={view.stageDistribution} />

      {/* AI 组对比（PRD §5.10，T14 接入）：进行中实验 × 看板所选周期；
          对比表组件与口径随 T13 交付，样本不足显示黄色横幅、绝无结论文案 */}
      {view.experimentComparison ? (
        <ExperimentComparisonTable
          experimentName={view.experimentComparison.experimentName}
          periodLabel={view.experimentComparison.periodLabel}
          controlSampleSize={view.experimentComparison.controlSampleSize}
          assistedSampleSize={view.experimentComparison.assistedSampleSize}
          rows={view.experimentComparison.rows.map((row) => ({
            metricLabel: row.metricLabel,
            comparison: row.comparison,
          }))}
        />
      ) : (
        <section className="rounded-lg border border-dashed border-gray-300 bg-white p-4">
          <h2 className="mb-1 text-base font-semibold">AI 组对比</h2>
          <p className="text-sm text-gray-500">
            当前没有进行中的实验。在「实验管理」创建实验并对线索随机分组后，
            此处展示两组（常规组 / AI 辅助组）的样本量、比例、绝对差异与统计周期；
            样本不足时将显示「样本不足，暂不宜判断」。
          </p>
        </section>
      )}

      {/* 口径说明（折叠，PRD §5.9 原公式） */}
      <details className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
        <summary className="cursor-pointer text-base font-semibold text-gray-900">
          口径说明
        </summary>
        <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
          <li>接通率 = 接通电话数 / 呼出电话数（呼出 = 电话渠道且方向为呼出的沟通）。</li>
          <li>有效沟通率 = 有效沟通数 / 接通电话数。</li>
          <li>合格线索率 = 合格线索数 / 有效沟通数。</li>
          <li>预约转化率 = 预约数 / 有效沟通数。</li>
          <li>
            每小时有效沟通数 = 有效沟通数 / 实际销售工作小时；未填报工时显示「—」。
          </li>
          <li>
            合格/预约/演示/报价/成交为周期内首次进入对应阶段的线索数
            （阶段推进记录），同一线索多次进出只计首次。
          </li>
          <li>
            沟通类指标含已删除客户的沟通（发生过就是发生过）；
            「各阶段客户数量」为当前快照，不含已删除客户。
          </li>
          <li>
            筛选按线索属性圈定同批线索后计算全部指标；工时不挂线索——来源/行业/阶段
            筛选不改变工时分母，按负责人筛选时工时取该负责人的填报。
          </li>
          <li>
            分母为 0 或缺工时显示「—」，绝不显示 0%。
          </li>
          <li>
            AI 组对比：样本量 = 分组时的组内线索数（固定）；比例 = 周期内达成该
            指标的线索占组内样本比例（去重）；绝对差异 = AI 辅助组比例 − 常规组比例
            （百分点）。任一组样本量 &lt; 实验阈值显示「样本不足，暂不宜判断」，
            不构成 AI 造成提升的因果结论（§5.10）。
          </li>
          {EXPERIMENT_COMPARISON_METRICS.length > 0 && (
            <li>
              对比指标口径：{EXPERIMENT_COMPARISON_METRICS.map((metric) => `${metric.label}（${metric.basis}）`).join("；")}。
            </li>
          )}
        </ul>
      </details>
    </div>
  );
}
