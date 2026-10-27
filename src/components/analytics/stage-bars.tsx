import type { StageDistributionRow } from "@/server/metrics/engine";

// 各阶段客户数量（UIUX P7 ▍各阶段客户数量，横向条形，13+自定义阶段）：
// 当前快照（不含软删除），停用阶段仍持有线索时照常列出并标注。
// 条宽为纯展示（以最大值为基准），数值来自指标引擎 stageDistribution。

export function StageDistributionSection({
  rows,
}: {
  rows: StageDistributionRow[];
}) {
  const max = Math.max(...rows.map((row) => row.count), 1);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-1 text-base font-semibold">各阶段客户数量</h2>
      <p className="mb-3 text-xs text-gray-400">
        当前客户所在阶段快照（不含已删除客户）；阶段改名/改码不影响本统计（口径锚定阶段）。
      </p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-gray-300 p-4 text-center text-sm text-gray-500">
          当前筛选范围内没有客户
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <div key={row.stageId} className="flex items-center gap-2">
              <span
                className="w-28 shrink-0 truncate text-right text-xs text-gray-500"
                title={row.name}
              >
                {row.name}
                {row.isActive ? "" : "（已停用）"}
              </span>
              <div className="h-5 min-w-0 flex-1 rounded-sm bg-gray-50">
                <div
                  className="h-5 rounded-sm bg-indigo-400/80"
                  style={{
                    width: `${Math.max((row.count / max) * 100, row.count > 0 ? 2 : 0)}%`,
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-sm font-semibold tabular-nums text-gray-900">
                {row.count}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
