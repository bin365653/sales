import Link from "next/link";

// 设置中心页签导航（T15，UIUX P9）：顶部两大分段——个人设置 / 管理员设置。
// 纯链接实现（禁 JS 可用），销售不渲染管理员分段（服务端同时拒绝越权 tab，404）。

export const PERSONAL_TABS = [
  { key: "account", label: "账号与密码" },
  { key: "worktime", label: "每日工时" },
  { key: "export", label: "个人数据导出" },
] as const;

export const ADMIN_TABS = [
  { key: "ai", label: "AI 服务" },
  { key: "prompts", label: "提示词模板" },
  { key: "stages", label: "阶段管理" },
  { key: "fields", label: "字段配置" },
  { key: "dicts", label: "数据字典" },
  { key: "users", label: "账号管理" },
  { key: "audit", label: "操作日志" },
] as const;

export type SettingsTabKey =
  | (typeof PERSONAL_TABS)[number]["key"]
  | (typeof ADMIN_TABS)[number]["key"];

export function isPersonalTab(key: string): boolean {
  return PERSONAL_TABS.some((tab) => tab.key === key);
}

export function isAdminTab(key: string): boolean {
  return ADMIN_TABS.some((tab) => tab.key === key);
}

function TabLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition ${
        active
          ? "bg-blue-600 font-medium text-white"
          : "text-gray-600 hover:bg-gray-100"
      }`}
    >
      {label}
    </Link>
  );
}

export function SettingsTabs({
  current,
  isAdmin,
}: {
  current: string;
  isAdmin: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white p-1.5">
        <span className="px-2 text-xs font-medium text-gray-400">个人设置</span>
        {PERSONAL_TABS.map((tab) => (
          <TabLink
            key={tab.key}
            href={`/settings?tab=${tab.key}`}
            label={tab.label}
            active={current === tab.key}
          />
        ))}
      </div>
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-gray-200 bg-white p-1.5">
          <span className="px-2 text-xs font-medium text-gray-400">管理员设置</span>
          {ADMIN_TABS.map((tab) => (
            <TabLink
              key={tab.key}
              href={`/settings?tab=${tab.key}`}
              label={tab.label}
              active={current === tab.key}
            />
          ))}
        </div>
      )}
    </div>
  );
}
