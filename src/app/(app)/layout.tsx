import Link from "next/link";
import { redirect } from "next/navigation";
import { ROLE_LABELS } from "@/lib/auth";
import { getCurrentUser } from "@/server/auth/current-user";
import { LogoutButton } from "@/components/layout/logout-button";

export const dynamic = "force-dynamic";

// 受保护布局（§3 目录结构 (app)）：防线 2 —— 会话真伪在服务端校验，
// 失效（过期/撤销/停用）一律回登录页。业务导航随 T03+ 逐步点亮。

const NAV_ITEMS: ReadonlyArray<{ label: string; href: string | null }> = [
  { label: "工作台", href: "/" },
  { label: "线索池", href: "/leads" },
  { label: "任务中心", href: null },
  { label: "数据看板", href: null },
  { label: "实验管理", href: null },
  { label: "设置中心", href: null },
];

function NavList({ layout }: { layout: "sidebar" | "top" }) {
  return (
    <nav
      className={
        layout === "sidebar"
          ? "flex flex-col gap-1"
          : "flex items-center gap-1 overflow-x-auto"
      }
    >
      {NAV_ITEMS.map((item) =>
        item.href ? (
          <Link
            key={item.label}
            href={item.href}
            className={`rounded-md bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100 ${
              layout === "sidebar" ? "" : "whitespace-nowrap"
            }`}
          >
            {item.label}
          </Link>
        ) : (
          <span
            key={item.label}
            aria-disabled
            title="随后续任务交付"
            className={`cursor-default rounded-md px-3 py-1.5 text-sm text-gray-400 ${
              layout === "sidebar" ? "" : "whitespace-nowrap"
            }`}
          >
            {item.label}
          </span>
        ),
      )}
    </nav>
  );
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      {/* 桌面侧边栏 */}
      <aside className="hidden w-52 shrink-0 flex-col border-r border-gray-200 bg-white p-4 md:flex">
        <div className="mb-6 px-2 text-lg font-semibold">勤策</div>
        <NavList layout="sidebar" />
        <div className="mt-auto px-2 text-xs text-gray-400">
          V1.0 · 工程实施计划 T04
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏：移动端品牌 + 全端用户区 */}
        <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3">
          <span className="font-semibold md:hidden">勤策</span>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">
              {user.name}
              <span className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
                {ROLE_LABELS[user.role]}
              </span>
            </span>
            <LogoutButton />
          </div>
        </header>

        {/* 移动端横向导航 */}
        <div className="border-b border-gray-200 bg-white px-3 py-2 md:hidden">
          <NavList layout="top" />
        </div>

        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
