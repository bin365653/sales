import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { listLeads } from "@/server/services/leads";
import { listStages } from "@/server/services/stages";
import { listActiveUsers } from "@/server/services/users";
import { leadListQuerySchema, type LeadListQuery } from "@/lib/schemas/lead";
import { toShanghaiDateString, toShanghaiDateTimeString } from "@/lib/format";
import { LeadFilters } from "@/components/leads/lead-filters";
import { LeadsTable, type LeadRow } from "@/components/leads/leads-table";
import { ExportButton } from "@/components/leads/export-button";

export const dynamic = "force-dynamic";

// P3 线索池（T04）：搜索 + 组合筛选 + 分页 + 批量修改 + 新建入口。
// 数据查询直接走服务层（与 GET /api/leads 同一实现，口径必然一致）；
// 移动端保留可查看与搜索（次要列隐藏、表格横向滚动）。

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

function buildPageHref(query: LeadListQuery, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    keyword: query.keyword,
    city: query.city,
    industry: query.industry,
    source: query.source,
    salesMode: query.salesMode,
    currentSystem: query.currentSystem,
    stageId: query.stageId,
    priority: query.priority,
    nextContact: query.nextContact,
    ownerId: query.ownerId,
  })) {
    if (value) {
      params.set(key, value);
    }
  }
  params.set("page", String(page));
  params.set("pageSize", String(query.pageSize));
  return `/leads?${params.toString()}`;
}

export default async function LeadsPage({
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
  const parsed = leadListQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : leadListQuerySchema.parse({});

  const [result, stages, owners] = await Promise.all([
    listLeads(user, query),
    listStages({ activeOnly: true }),
    user.role === "admin" ? listActiveUsers() : Promise.resolve([]),
  ]);

  const rows: LeadRow[] = result.items.map((lead) => ({
    id: lead.id,
    name: lead.name,
    city: lead.city,
    industry: lead.industry,
    stageName: lead.stage.name,
    priority: lead.priority,
    contactName: lead.contactName,
    contactPhone: lead.contactPhone,
    lastContactAt: lead.lastContactAt
      ? toShanghaiDateString(lead.lastContactAt)
      : null,
    updatedAt: toShanghaiDateTimeString(lead.updatedAt),
  }));

  const totalPages =
    result.total === 0 ? 1 : Math.ceil(result.total / result.pageSize);
  const ownerNameById = new Map(owners.map((owner) => [owner.id, owner.name]));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">线索池</h1>
          <p className="mt-1 text-sm text-gray-500">
            共 {result.total} 位客户
            {query.nextContact === "today" ? " · 下次联系：今天" : ""}
            {user.role === "admin" && query.ownerId
              ? ` · 负责人：${ownerNameById.get(query.ownerId) ?? "未知"}`
              : ""}
            {user.role === "admin" && !query.ownerId ? " · 全部负责人" : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* 导出范围 = 当前筛选（与列表同一 where 构造器）；导入向导见 /leads/import */}
          <ExportButton query={query} />
          <Link
            href="/leads/import"
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            导入客户
          </Link>
          <Link
            href="/leads/new"
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            + 新建客户
          </Link>
        </div>
      </div>

      <LeadFilters
        query={query}
        stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
        owners={owners.map((owner) => ({ id: owner.id, name: owner.name }))}
      />

      <LeadsTable
        rows={rows}
        stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
      />

      <div className="flex items-center justify-between text-sm text-gray-600">
        <span>
          第 {result.page} / {totalPages} 页 · 每页 {result.pageSize} 条 · 共{" "}
          {result.total} 条
        </span>
        <div className="flex gap-2">
          {result.page > 1 && (
            <Link
              href={buildPageHref(query, result.page - 1)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 transition hover:bg-gray-50"
            >
              上一页
            </Link>
          )}
          {result.page < totalPages && (
            <Link
              href={buildPageHref(query, result.page + 1)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 transition hover:bg-gray-50"
            >
              下一页
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
