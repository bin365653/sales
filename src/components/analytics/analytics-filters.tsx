import Link from "next/link";
import type { AnalyticsQuery } from "@/lib/schemas/analytics";
import type { AnalyticsFilterOptions } from "@/server/metrics/analytics";

// 看板筛选器（UIUX P7 顶部：[今日|本周|本月|自定义范围] [来源▾][行业▾][阶段▾]）：
// GET 表单提交到 /analytics，参数名与 analyticsQuerySchema 一致，禁 JS 可用；
// 自定义范围时启用 from/to（date input）。来源/行业下拉选项来自用户数据范围内
// 的去重值（P3 文本精确筛选的看板版）；负责人仅管理员可见。

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

const PERIOD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "today", label: "今日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "custom", label: "自定义范围" },
];

export function AnalyticsFilters({
  query,
  options,
  showOwner,
}: {
  query: AnalyticsQuery;
  options: AnalyticsFilterOptions;
  showOwner: boolean;
}) {
  const hasCohortFilter = Boolean(
    query.source || query.industry || query.stageId || query.ownerId,
  );

  // 快速周期链接：保留当前圈选参数（服务端组装，禁 JS 可用）
  const quickHref = (period: string) => {
    const params = new URLSearchParams();
    params.set("period", period);
    for (const [key, value] of Object.entries({
      source: query.source,
      industry: query.industry,
      stageId: query.stageId,
      ownerId: query.ownerId,
    })) {
      if (value) {
        params.set(key, value);
      }
    }
    return `/analytics?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {PERIOD_OPTIONS.filter((option) => option.value !== "custom").map(
          (option) => (
            <Link
              key={option.value}
              href={quickHref(option.value)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                query.period === option.value
                  ? "bg-blue-600 font-medium text-white"
                  : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </Link>
          ),
        )}
      </div>
      <form
        method="GET"
        action="/analytics"
        className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-4 xl:grid-cols-6"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="a-period" className="text-xs text-gray-500">
            统计周期
          </label>
          <select
            id="a-period"
            name="period"
            defaultValue={query.period}
            className={INPUT_CLASS}
          >
            {PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-from" className="text-xs text-gray-500">
            自定义起（自定义范围时生效）
          </label>
          <input
            id="a-from"
            name="from"
            type="date"
            defaultValue={query.from ?? ""}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-to" className="text-xs text-gray-500">
            自定义止（自定义范围时生效）
          </label>
          <input
            id="a-to"
            name="to"
            type="date"
            defaultValue={query.to ?? ""}
            className={INPUT_CLASS}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-source" className="text-xs text-gray-500">
            客户来源
          </label>
          <select
            id="a-source"
            name="source"
            defaultValue={query.source ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">全部来源</option>
            {options.sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-industry" className="text-xs text-gray-500">
            行业
          </label>
          <select
            id="a-industry"
            name="industry"
            defaultValue={query.industry ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">全部行业</option>
            {options.industries.map((industry) => (
              <option key={industry} value={industry}>
                {industry}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="a-stage" className="text-xs text-gray-500">
            客户阶段
          </label>
          <select
            id="a-stage"
            name="stageId"
            defaultValue={query.stageId ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">全部阶段</option>
            {options.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </div>
        {showOwner && (
          <div className="flex flex-col gap-1">
            <label htmlFor="a-owner" className="text-xs text-gray-500">
              负责人
            </label>
            <select
              id="a-owner"
              name="ownerId"
              defaultValue={query.ownerId ?? ""}
              className={INPUT_CLASS}
            >
              <option value="">全部负责人</option>
              {options.owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="col-span-2 flex items-end gap-2 md:col-span-1">
          <button
            type="submit"
            className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            应用筛选
          </button>
          {hasCohortFilter && (
            <Link
              href="/analytics"
              className="h-9 rounded-md border border-gray-300 px-3 text-sm leading-8 text-gray-600 transition hover:bg-gray-50"
            >
              重置
            </Link>
          )}
        </div>
      </form>
    </div>
  );
}
