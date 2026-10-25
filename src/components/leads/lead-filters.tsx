import Link from "next/link";
import { PRIORITY_LABELS } from "@/lib/format";
import type { LeadListQuery } from "@/lib/schemas/lead";

// 线索池筛选器（P3，T04）：GET 表单提交到 /leads，参数名与
// leadListQuerySchema 一致；无 JS 环境也可用。文本筛选为精确匹配
// （与 API 语义一致），placeholder 已注明。提交后 page 归 1（GET 表单不带 page）。

const INPUT_CLASS =
  "h-9 w-full rounded-md border border-gray-300 bg-white px-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export interface LeadFiltersProps {
  query: LeadListQuery;
  stages: { id: string; name: string }[];
  /** 仅管理员：负责人筛选（销售数据范围强制本人，K1） */
  owners: { id: string; name: string }[];
}

export function LeadFilters({ query, stages, owners }: LeadFiltersProps) {
  const hasFilter =
    Boolean(query.keyword) ||
    Boolean(query.city) ||
    Boolean(query.industry) ||
    Boolean(query.source) ||
    Boolean(query.salesMode) ||
    Boolean(query.currentSystem) ||
    Boolean(query.stageId) ||
    Boolean(query.priority) ||
    Boolean(query.ownerId);

  return (
    <form
      method="GET"
      action="/leads"
      className="grid grid-cols-2 gap-3 rounded-lg border border-gray-200 bg-white p-3 md:grid-cols-4 xl:grid-cols-5"
    >
      <div className="col-span-2 flex flex-col gap-1 md:col-span-2 xl:col-span-1">
        <label htmlFor="q-keyword" className="text-xs text-gray-500">
          关键词（名称/联系人/电话）
        </label>
        <input
          id="q-keyword"
          name="keyword"
          type="search"
          defaultValue={query.keyword ?? ""}
          maxLength={64}
          placeholder="模糊搜索"
          className={INPUT_CLASS}
        />
      </div>
      {(
        [
          ["city", "城市（精确）"],
          ["industry", "行业（精确）"],
          ["source", "客户来源（精确）"],
          ["salesMode", "销售模式（精确）"],
          ["currentSystem", "在用系统（精确）"],
        ] as const
      ).map(([name, label]) => (
        <div key={name} className="flex flex-col gap-1">
          <label htmlFor={`q-${name}`} className="text-xs text-gray-500">
            {label}
          </label>
          <input
            id={`q-${name}`}
            name={name}
            defaultValue={query[name] ?? ""}
            maxLength={128}
            className={INPUT_CLASS}
          />
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <label htmlFor="q-stage" className="text-xs text-gray-500">
          阶段
        </label>
        <select id="q-stage" name="stageId" defaultValue={query.stageId ?? ""} className={INPUT_CLASS}>
          <option value="">全部阶段</option>
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="q-priority" className="text-xs text-gray-500">
          优先级
        </label>
        <select
          id="q-priority"
          name="priority"
          defaultValue={query.priority ?? ""}
          className={INPUT_CLASS}
        >
          <option value="">全部优先级</option>
          {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {owners.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="q-owner" className="text-xs text-gray-500">
            负责人
          </label>
          <select
            id="q-owner"
            name="ownerId"
            defaultValue={query.ownerId ?? ""}
            className={INPUT_CLASS}
          >
            <option value="">全部负责人</option>
            {owners.map((owner) => (
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
          筛选
        </button>
        {hasFilter && (
          <Link
            href="/leads"
            className="h-9 rounded-md border border-gray-300 px-3 text-sm leading-8 text-gray-600 transition hover:bg-gray-50"
          >
            重置
          </Link>
        )}
      </div>
    </form>
  );
}
