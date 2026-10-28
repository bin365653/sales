import Link from "next/link";
import { AUDIT_PAGE_SIZE, formatAuditAction } from "@/server/services/audit-logs";

// 操作日志（T15，UIUX P9）：表格（时间/操作人/动作/对象/IP）+ 行展开 detail +
// 筛选（时间范围/动作/操作人）+ 分页。纯服务端渲染（GET 表单 + details/summary），
// 禁 JS 可用；敏感明文（密码/密钥）在写入侧已保证不落审计。

export interface AuditLogRow {
  id: string;
  createdAtLabel: string;
  action: string;
  objectType: string | null;
  objectId: string | null;
  detail: unknown;
  ip: string | null;
  userName: string | null;
}

const ACTION_OPTIONS: Array<{ value: string; label: string }> = [
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "import.confirmed",
  "export.created",
  "settings.stage_created",
  "settings.stage_updated",
  "settings.field_created",
  "settings.field_updated",
  "settings.user_created",
  "settings.user_updated",
  "settings.user_password_reset",
  "settings.prompt_version_created",
  "ai.model_config_created",
  "ai.model_config_updated",
  "lead.deleted",
  "lead.batch_updated",
  "experiment.created",
  "experiment.updated",
  "experiment.assigned",
  "experiment.closed",
  "ai.control_group_blocked",
].map((value) => ({ value, label: `${formatAuditAction(value)}（${value}）` }));

const INPUT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function AuditLogsView({
  rows,
  users,
  filters,
  page,
  total,
}: {
  rows: AuditLogRow[];
  users: Array<{ id: string; name: string }>;
  filters: { action?: string; userId?: string; from?: string; to?: string };
  page: number;
  total: number;
}) {
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const hasFilter =
    filters.action !== undefined ||
    filters.userId !== undefined ||
    filters.from !== undefined ||
    filters.to !== undefined;

  function pageHref(target: number): string {
    const params = new URLSearchParams();
    params.set("tab", "audit");
    if (filters.action) {
      params.set("action", filters.action);
    }
    if (filters.userId) {
      params.set("userId", filters.userId);
    }
    if (filters.from) {
      params.set("from", filters.from);
    }
    if (filters.to) {
      params.set("to", filters.to);
    }
    if (target > 1) {
      params.set("page", String(target));
    }
    return `/settings?${params.toString()}`;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-gray-500">
        覆盖登录、导入确认、导出、配置修改、删除、密钥更新、实验分组等关键操作
        （实施计划 §4.2）；日志只追加，不含密码与密钥明文。
      </p>

      {/* 筛选（GET 表单，禁 JS 可用） */}
      <form
        method="get"
        action="/settings"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-3"
      >
        <input type="hidden" name="tab" value="audit" />
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          动作
          <select name="action" defaultValue={filters.action ?? ""} className={INPUT_CLASS}>
            <option value="">全部动作</option>
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          操作人
          <select name="userId" defaultValue={filters.userId ?? ""} className={INPUT_CLASS}>
            <option value="">全部操作人</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          开始日期
          <input
            type="date"
            name="from"
            defaultValue={filters.from ?? ""}
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          结束日期
          <input
            type="date"
            name="to"
            defaultValue={filters.to ?? ""}
            className={INPUT_CLASS}
          />
        </label>
        <button
          type="submit"
          className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          筛选
        </button>
        {hasFilter && (
          <Link
            href="/settings?tab=audit"
            className="h-9 rounded-md border border-gray-300 bg-white px-4 text-sm leading-9 text-gray-700 transition hover:bg-gray-50"
          >
            重置
          </Link>
        )}
      </form>

      <p className="text-xs text-gray-400">
        共 {total} 条记录；每页 {AUDIT_PAGE_SIZE} 条，第 {page}/{totalPages} 页。
      </p>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
          没有符合条件的日志。
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                <th className="px-3 py-2 font-medium">时间</th>
                <th className="px-3 py-2 font-medium">操作人</th>
                <th className="px-3 py-2 font-medium">动作</th>
                <th className="px-3 py-2 font-medium">对象</th>
                <th className="px-3 py-2 font-medium">IP</th>
                <th className="px-3 py-2 font-medium">详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-gray-50 last:border-b-0 align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                    {row.createdAtLabel}
                  </td>
                  <td className="px-3 py-2 text-gray-700">
                    {row.userName ?? <span className="text-gray-400">（未知用户）</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-gray-900">{formatAuditAction(row.action)}</span>
                    <span className="ml-1.5 font-mono text-xs text-gray-400">{row.action}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {row.objectType ?? "—"}
                    {row.objectId && (
                      <span className="ml-1 font-mono text-gray-400">
                        {row.objectId.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">
                    {row.ip ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {row.detail !== null && row.detail !== undefined ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-blue-600">
                          展开
                        </summary>
                        <pre className="mt-1 max-h-48 max-w-md overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-2 text-xs text-gray-600">
                          {JSON.stringify(row.detail, null, 2)}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || page < totalPages) && (
        <div className="flex items-center gap-3 text-sm">
          {page > 1 ? (
            <Link
              href={pageHref(page - 1)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-gray-700 transition hover:bg-gray-50"
            >
              上一页
            </Link>
          ) : (
            <span className="rounded-md border border-gray-200 px-3 py-1.5 text-gray-300">
              上一页
            </span>
          )}
          <span className="text-gray-500">
            第 {page} / {totalPages} 页
          </span>
          {page < totalPages ? (
            <Link
              href={pageHref(page + 1)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-gray-700 transition hover:bg-gray-50"
            >
              下一页
            </Link>
          ) : (
            <span className="rounded-md border border-gray-200 px-3 py-1.5 text-gray-300">
              下一页
            </span>
          )}
        </div>
      )}
    </div>
  );
}
