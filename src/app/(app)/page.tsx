import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { PRIORITY_RULE_EXPLANATION } from "@/lib/metrics";
import { PRIORITY_BADGE_CLASS, PRIORITY_LABELS } from "@/lib/format";
import { getWorkbenchSummary } from "@/server/metrics/engine";
import { CopyPhoneButton } from "@/components/dashboard/copy-phone-button";

export const dynamic = "force-dynamic";

// P2 工作台首页（T12，PRD §5.1 / UIUX P2）：优先呈现可执行动作而非图表。
// 数据一律经 getWorkbenchSummary（与 GET /api/dashboard/summary 同一实现）：
// 今日三卡 → /leads?nextContact=today 与任务中心；本周概览（C13 周一起算，
// 看板随 T13 交付暂不跳转）；建议优先联系（K6 规则引擎，理由必显）；
// 最近沟通记录（10 条，时间倒序）。

const CARD_LINK_CLASS =
  "block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm";

function CountCard({
  label,
  count,
  href,
  accent,
}: {
  label: string;
  count: number;
  href: string;
  accent?: "danger";
}) {
  return (
    <Link href={href} className={CARD_LINK_CLASS}>
      <div className="text-sm text-gray-500">{label}</div>
      <div
        className={`mt-1 text-3xl font-semibold ${
          accent === "danger" && count > 0 ? "text-red-600" : "text-gray-900"
        }`}
      >
        {count}
      </div>
      <div className="mt-1 text-xs text-blue-600">去处理 →</div>
    </Link>
  );
}

function MetricCell({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | null;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-gray-400">{label}</span>
      <span className="text-lg font-semibold text-gray-900">
        {value === null ? "—" : value}
        {value !== null && suffix ? (
          <span className="ml-0.5 text-xs font-normal text-gray-400">{suffix}</span>
        ) : null}
      </span>
    </div>
  );
}

export default async function WorkbenchPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const summary = await getWorkbenchSummary(user);
  const { today, week } = summary;

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">工作台</h1>
        <span className="text-sm text-gray-500">
          {today.date} {today.weekday}
        </span>
      </div>

      {/* 今日三卡 + 本周概览（UIUX P2 桌面布局） */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CountCard
          label="今日待联系（客户）"
          count={today.dueTodayLeads}
          href="/leads?nextContact=today"
        />
        <CountCard
          label="今日任务"
          count={today.tasksToday}
          href="/tasks?view=today&status=pending"
        />
        <CountCard
          label="逾期任务"
          count={today.tasksOverdue}
          href="/tasks?view=overdue&status=pending"
          accent="danger"
        />
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-baseline justify-between">
            <div className="text-sm text-gray-500">本周概览</div>
            <span className="text-xs text-gray-400" title="周一起算（C13）">
              {week.from.slice(5)} ~ {week.to.slice(5)}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2">
            <MetricCell label="呼出" value={week.counts.outboundCalls} />
            <MetricCell label="有效沟通" value={week.counts.effectiveCommunications} />
            <MetricCell label="合格" value={week.counts.qualifiedLeads} />
            <MetricCell label="预约" value={week.counts.demoBookings} />
          </div>
          <div className="mt-1 text-right text-xs text-gray-400">
            数据看板随 T13 交付
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* 建议优先联系（K6 规则引擎输出，AI 不参与） */}
        <div className="lg:col-span-3">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-base font-semibold">建议优先联系</h2>
            <span
              title={PRIORITY_RULE_EXPLANATION}
              className="inline-flex h-5 w-5 cursor-help items-center justify-center rounded-full border border-gray-300 text-xs text-gray-400"
              aria-label="规则说明"
            >
              ⓘ
            </span>
          </div>
          {summary.priorities.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
              当前没有需要优先联系的客户
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {summary.priorities.map((item) => (
                <li key={item.leadId}>
                  <Link
                    href={`/leads/${item.leadId}`}
                    className="block rounded-lg border border-gray-200 bg-white p-4 transition hover:border-blue-300 hover:shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-gray-900">
                        {item.name}
                      </span>
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                        {item.stageName}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          PRIORITY_BADGE_CLASS[item.priority]
                        }`}
                      >
                        优先级：{PRIORITY_LABELS[item.priority]}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm text-amber-700">
                      理由：{item.reasons.join("；")}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-sm">
                      <CopyPhoneButton phone={item.contactPhone ?? ""} />
                      {item.contactName ? (
                        <span className="text-gray-500">
                          联系人：{item.contactName}
                        </span>
                      ) : null}
                      <span className="ml-auto flex gap-2">
                        <span className="rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-600">
                          去准备
                        </span>
                        <span className="rounded-md bg-blue-600 px-2 py-1 text-xs text-white">
                          记录沟通
                        </span>
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 最近沟通记录 */}
        <div className="lg:col-span-2">
          <h2 className="mb-2 text-base font-semibold">最近沟通记录</h2>
          {summary.recentInteractions.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
              完成首次沟通后，这里会显示记录
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
              {summary.recentInteractions.map((row) => (
                <li key={row.id} className="p-3">
                  <div className="flex items-baseline justify-between gap-2">
                    <Link
                      href={`/leads/${row.leadId}`}
                      className="truncate text-sm font-medium text-gray-900 hover:text-blue-700"
                    >
                      {row.leadName}
                    </Link>
                    <span className="shrink-0 text-xs text-gray-400">
                      {row.relativeTime}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                    <span>
                      {row.channelLabel}·{row.directionLabel}
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
                  {row.feedbackSnippet ? (
                    <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                      {row.feedbackSnippet}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
