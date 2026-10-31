import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { listStages } from "@/server/services/stages";
import { listTasks } from "@/server/services/tasks";
import { runTaskGenerationLazy } from "@/server/services/task-generation";
import { taskListQuerySchema, TASK_LIST_VIEWS, VIEW_LABELS } from "@/lib/schemas/task";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/tasks";
import { toTaskView } from "@/components/tasks/task-view";
import { TaskCenterList } from "@/components/tasks/task-center-list";

export const dynamic = "force-dynamic";

// P6 任务中心（T07，PRD §5.7 / UIUX P6）：
// 视图 = 今日（含逾期置顶，dueAt 升序）/ 逾期（跨日才算逾期）/ 全部（状态可筛选）。
// 查询直接走服务层 listTasks（与 GET /api/tasks 同一实现，口径必然一致）；
// Tab 与状态筛选渲染为链接（GET 语义，禁 JS 可用，条件随 URL 保留可分享）。

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

function buildTabHref(view: string, status: string): string {
  const params = new URLSearchParams({ view, status, pageSize: "20" });
  return `/tasks?${params.toString()}`;
}

export default async function TasksPage({
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
  const parsed = taskListQuerySchema.safeParse(flat);
  const query = parsed.success ? parsed.data : taskListQuerySchema.parse({});

  const [result, stages] = await Promise.all([
    (async () => {
      // V2.0-T06：页面加载即完成当日生成（惰性触发，与 GET /api/tasks 同口径；
      // 失败只记审计不阻塞页面）
      await runTaskGenerationLazy(user);
      return listTasks(user, query);
    })(),
    listStages({ activeOnly: true }),
  ]);

  const now = new Date();
  const rows = result.items.map((task) =>
    toTaskView(
      {
        ...task,
        lead: {
          id: task.lead.id,
          name: task.lead.name,
          stageName: task.lead.stage.name,
          stageSortOrder: task.lead.stage.sortOrder,
        },
      },
      now,
    ),
  );
  const stageOptions = stages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    sortOrder: stage.sortOrder,
    semanticKey: stage.semanticKey,
  }));

  const tabs: { view: string; label: string; badge?: number }[] = TASK_LIST_VIEWS.map(
    (view) => ({
      view,
      label: VIEW_LABELS[view],
      ...(view === "overdue" && result.counts.overdue > 0
        ? { badge: result.counts.overdue }
        : {}),
    }),
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">任务中心</h1>
        <p className="mt-1 text-sm text-gray-500">
          今日待办 {result.counts.today} 条 · 逾期 {result.counts.overdue} 条
          （逾期按自然日判定：截止日早于今天即逾期）
        </p>
      </div>

      {/* 视图 Tab + 状态筛选（全部视图生效） */}
      <div className="flex flex-wrap items-center gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.view}
            href={buildTabHref(tab.view, query.status)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              query.view === tab.view
                ? "bg-blue-600 text-white"
                : "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span
                className={`ml-1.5 rounded px-1.5 py-0.5 text-xs ${
                  query.view === tab.view ? "bg-white/20 text-white" : "bg-red-50 text-red-600"
                }`}
              >
                {tab.badge}
              </span>
            )}
          </Link>
        ))}
        {query.view === "all" && (
          <span className="ml-2 flex flex-wrap items-center gap-1.5 border-l border-gray-200 pl-3">
            <span className="text-xs text-gray-400">状态：</span>
            {[{ value: "all", label: "全部" }, ...TASK_STATUSES.map((value) => ({ value, label: TASK_STATUS_LABELS[value] }))].map(
              (option) => (
                <Link
                  key={option.value}
                  href={buildTabHref("all", option.value)}
                  className={`rounded px-2 py-1 text-xs transition ${
                    query.status === option.value
                      ? "bg-gray-800 text-white"
                      : "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {option.label}
                </Link>
              ),
            )}
          </span>
        )}
      </div>

      <TaskCenterList
        rows={rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        view={query.view}
        status={query.status}
        counts={result.counts}
        stages={stageOptions}
      />
    </div>
  );
}
