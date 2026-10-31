import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import {
  formatRelativeShanghai,
  oneLineSnippet,
  shanghaiWeekdayLabel,
  toShanghaiDateString,
} from "@/lib/format";
import { CHANNEL_LABELS, DIRECTION_LABELS } from "@/lib/schemas/interaction";
import { getOperationsWorkbench } from "@/server/services/workbench";
import { runTaskGenerationLazy } from "@/server/services/task-generation";
import { listRecentInteractions } from "@/server/services/interactions";
import { prisma } from "@/server/db";
import { leadReadScope } from "@/server/permissions";
import type { LeadQuadrantCode } from "@/lib/quadrant";
import { QuadrantBadge } from "@/components/leads/quadrant-badge";
import { WORKBENCH_TABS } from "@/lib/workbench";
import type { WorkbenchRow } from "@/server/services/workbench";
import { PRIORITY_RULE_EXPLANATION } from "@/lib/metrics";

export const dynamic = "force-dynamic";

// P2 工作台首页（V2.0-T09 经营视图，PRD 模块七 / UIUX §5.6）：
// 顶部四卡（今日应跟进/软件半年内到期/画像待完善/已逾期任务，整卡点击跳转）
// + 五个主列表 Tab（今日优先/月度必跟/画像待完善/四象限重点/长期培育，
// GET 链接切换，禁 JS 可用）+ 右栏四象限分布与最近沟通记录（沿用）。
// 每行 = PRD 模块七字段全集：名称/城市行业/当前系统/象限/到期/最近联系/
// 本次联系原因（规则文案必显）/推荐沟通内容（规则模板）/下一步动作。
// 本周概览与原「建议优先联系」卡被本视图取代（D4：6 个月到期理由取代
// 30 天规则，理由文案随 T10 规则引擎输出）。惰性任务生成随首屏执行，
// 批量生成时顶部一次性 info 条（UIUX §4.9）。

const CARD_LINK_CLASS =
  "block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm";

const TAB_HREFS: Record<string, string> = {
  today: "/?tab=today",
  monthly: "/?tab=monthly",
  gap: "/?tab=gap",
  focus: "/?tab=focus",
  nurture: "/?tab=nurture",
};

function WorkbenchCard({
  label,
  count,
  href,
  danger,
}: {
  label: string;
  count: number;
  href: string;
  danger?: boolean;
}) {
  return (
    <Link href={href} className={CARD_LINK_CLASS}>
      <div className="text-sm text-gray-500">{label}</div>
      <div
        className={`mt-1 text-3xl font-semibold ${
          danger && count > 0 ? "text-red-600" : "text-gray-900"
        }`}
      >
        {count}
      </div>
      <div className="mt-1 text-xs text-blue-600">去处理 →</div>
    </Link>
  );
}

function WorkbenchLeadRowItem({ row }: { row: WorkbenchRow }) {
  return (
    <li className="rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/leads/${row.leadId}`}
          className="text-base font-medium text-gray-900 hover:text-blue-700"
        >
          {row.name}
        </Link>
        <QuadrantBadge code={row.quadrant ?? "pending"} />
        {row.expiryDisplay && (
          <span className="text-xs text-gray-500" title="软件到期（月粒度口径）">
            到期 {row.expiryDisplay}
          </span>
        )}
        {row.lastContactDisplay && (
          <span className="ml-auto text-xs text-gray-400">
            最近联系 {row.lastContactDisplay}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {[
          row.cityIndustry,
          row.currentSystem ? `当前系统：${row.currentSystem}` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—"}
      </p>
      <p className="mt-1.5 text-sm text-amber-700">原因：{row.reason}</p>
      <p className="mt-1 line-clamp-2 text-sm text-gray-600" title={row.talkTrack}>
        推荐：{row.talkTrack}
      </p>
      <p className="mt-1 text-xs text-gray-500">
        下一步：
        {row.nextAction
          ? `${row.nextAction.sourceLabel ? `【${row.nextAction.sourceLabel}】` : ""}${row.nextAction.title}（${row.nextAction.dueDisplay}）`
          : "暂无待处理任务"}
      </p>
      <div className="mt-2 flex gap-2">
        <Link
          href={`/leads/${row.leadId}`}
          className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600 transition hover:bg-gray-50"
        >
          详情→
        </Link>
        <Link
          href={`/leads/${row.leadId}#interactions`}
          className="rounded-md bg-blue-600 px-2 py-1 text-xs text-white transition hover:bg-blue-700"
        >
          记录沟通
        </Link>
      </div>
    </li>
  );
}

export default async function WorkbenchPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const params = await searchParams;
  const tabParam = Array.isArray(params.tab) ? params.tab[0] : params.tab;

  // 惰性任务生成（D3）：首屏即完成当日生成；批量生成给一次性 info 条
  const generationStats = await runTaskGenerationLazy(user);
  const now = new Date();
  const [view, recent] = await Promise.all([
    getOperationsWorkbench(user, { now, tab: tabParam }),
    listRecentInteractions(user, 10),
  ]);

  // V2.0-T04：四象限分布（与列表筛选同一数据范围口径）
  const quadrantGroups = await prisma.lead.groupBy({
    by: ["quadrantCode"],
    _count: { _all: true },
    where: { ...leadReadScope(user), deletedAt: null },
  });
  const quadrantCounts = new Map<string, number>(
    quadrantGroups.map((group) => [group.quadrantCode ?? "pending", group._count._all]),
  );
  const quadrantOrder: (LeadQuadrantCode | "pending")[] = ["a", "b", "c", "d", "pending"];

  const rows = view.tabs[view.activeTab];
  const emptyTexts: Record<string, string> = {
    today: "今日没有优先客户；完成画像核实后系统会自动安排",
    monthly: "暂无半年内到期客户",
    gap: "所有客户的核心画像都已完善",
    focus: "暂无应跟进的 A/C 类客户；完成画像核实后系统会自动安排",
    nurture: "暂无应跟进的 B/D 类客户；完成画像核实后系统会自动安排",
  };

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">客户经营工作台</h1>
        <span className="text-sm text-gray-500">
          {toShanghaiDateString(now)} {shanghaiWeekdayLabel(now)}
        </span>
      </div>

      {generationStats && generationStats.createdTasks > 0 && (
        <p className="rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700">
          已为你生成 {generationStats.createdTasks} 条跟进任务
          （重复执行不会产生重复任务；可在任务中心查看）。
        </p>
      )}

      {/* 四顶卡（PRD 模块七；整卡点击跳对应视图） */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <WorkbenchCard
          label="今日应跟进"
          count={view.cards.followToday}
          href="/tasks?view=today&status=pending"
        />
        <WorkbenchCard
          label="软件半年内到期"
          count={view.cards.expiringSoon}
          href="/leads?expiryView=within_6m"
        />
        <WorkbenchCard
          label="画像待完善"
          count={view.cards.profileGap}
          href="/leads?quadrant=pending"
        />
        <WorkbenchCard
          label="已逾期任务"
          count={view.cards.overdueTasks}
          href="/tasks?view=overdue&status=pending"
          danger
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* 五列表（Tab 链接切换；仅渲染当前 Tab，懒加载 UIUX §5.6/§9） */}
        <div className="lg:col-span-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {WORKBENCH_TABS.map((tab) => (
              <Link
                key={tab.key}
                href={TAB_HREFS[tab.key]!}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  view.activeTab === tab.key
                    ? "bg-blue-600 font-medium text-white"
                    : "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {tab.label}
              </Link>
            ))}
          </div>
          {rows.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
              {emptyTexts[view.activeTab]}
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map((row) => (
                <WorkbenchLeadRowItem key={row.leadId} row={row} />
              ))}
            </ul>
          )}
        </div>

        {/* 右栏：四象限分布 + 最近沟通记录（沿用） */}
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">四象限分布</span>
              <span title="点击跳转线索池对应筛选" className="cursor-help text-xs text-gray-400">
                ⓘ
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {quadrantOrder.map((code) => (
                <Link
                  key={code}
                  href={`/leads?quadrant=${code}`}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 transition hover:bg-gray-50"
                >
                  <QuadrantBadge code={code} />
                  <span className="text-sm font-semibold text-gray-800">
                    {quadrantCounts.get(code) ?? 0}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          <div>
            <h2 className="mb-2 text-base font-semibold">最近沟通记录</h2>
            {recent.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
                完成首次沟通后，这里会显示记录
              </div>
            ) : (
              <ul className="flex flex-col divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {recent.map((row) => (
                  <li key={row.id} className="p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <Link
                        href={`/leads/${row.leadId}`}
                        className="truncate text-sm font-medium text-gray-900 hover:text-blue-700"
                      >
                        {row.leadName}
                      </Link>
                      <span className="shrink-0 text-xs text-gray-400">
                        {formatRelativeShanghai(row.occurredAt, now)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                      <span>
                        {CHANNEL_LABELS[row.channel]}·{DIRECTION_LABELS[row.direction]}
                        {row.connected ? "·已接通" : "·未接通"}
                      </span>
                      {row.effective ? (
                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                          有效
                        </span>
                      ) : (
                        <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-400">
                          无效
                        </span>
                      )}
                    </div>
                    {row.feedback ? (
                      <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                        {oneLineSnippet(row.feedback, 48)}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-400" title={PRIORITY_RULE_EXPLANATION}>
        ⓘ 今日优先与各列表联系原因由固定规则生成并附理由；AI 不参与优先级计算。
      </p>
    </section>
  );
}
