"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { ExperimentListItem } from "@/server/services/experiments";
import type { ExperimentStatsView } from "@/server/services/experiments";
import {
  ASSIGN_CONFIRM_TEXT,
  EXPERIMENT_GROUP_BADGE_CLASS,
  EXPERIMENT_GROUP_LABELS,
  EXPERIMENT_STATUS_BADGE_CLASS,
  EXPERIMENT_STATUS_LABELS,
  EXPERIMENT_COMPARISON_METRICS,
  type ExperimentGroupValue,
  type ExperimentStatusValue,
} from "@/lib/experiments";
import { EXPERIMENT_MAX_RATIO, EXPERIMENT_MIN_RATIO } from "@/lib/schemas/experiment";
import { SAMPLE_INSUFFICIENT_NOTICE } from "@/lib/analytics";

// 实验管理页交互（P8，T14）：列表（状态徽章/两组样本量）→ 创建（抽屉表单，
// 比例 10–90 默认 50、最小样本阈值默认 50）→ 预览圈选 → 强确认（M3）→
// 执行分组（409 冲突原样呈现）→ 效果对比（复用 P7 对比表四要素 +
// 样本不足横幅；无"提升 X%"类结论文案）→ 关闭（确认后禁 AI 规则解除）。

const INPUT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

function GroupBadgeInline({ group }: { group: ExperimentGroupValue }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${EXPERIMENT_GROUP_BADGE_CLASS[group]}`}
    >
      {EXPERIMENT_GROUP_LABELS[group]}
    </span>
  );
}

export function ExperimentsClient({
  initialExperiments,
  stages,
  owners,
  isAdmin,
}: {
  initialExperiments: ExperimentListItem[];
  stages: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [experiments, setExperiments] = useState(initialExperiments);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 详情抽屉：当前展开的实验 id；对比数据按需拉取（展开时）
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<
    { id: string; leadId: string; leadName: string; group: ExperimentGroupValue; assignedAt: string }[] | null
  >(null);
  const [stats, setStats] = useState<ExperimentStatsView | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/experiments");
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { experiments?: ExperimentListItem[] };
    if (Array.isArray(payload.experiments)) {
      setExperiments(payload.experiments);
    }
  }, []);

  async function loadDetail(id: string): Promise<void> {
    setAssignments(null);
    setStats(null);
    const [detailRes, statsRes] = await Promise.all([
      fetch(`/api/experiments/${id}`),
      fetch(`/api/experiments/${id}/stats`).catch(() => null),
    ]);
    if (detailRes.ok) {
      const payload = (await detailRes.json()) as {
        assignments?: { id: string; leadId: string; leadName: string; group: ExperimentGroupValue; assignedAt: string }[] | null;
      };
      setAssignments(payload.assignments ?? []);
    }
    if (statsRes && statsRes.ok) {
      setStats((await statsRes.json()) as ExperimentStatsView);
    }
  }

  function toggleExpand(id: string): void {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    setError(null);
    void loadDetail(id);
  }

  async function submitAssign(id: string): Promise<void> {
    // 强确认（M3，UIUX P8）
    if (!window.confirm(ASSIGN_CONFIRM_TEXT)) {
      return;
    }
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/experiments/${id}/assign`, { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | { assigned?: number; control?: number; assisted?: number; error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "执行分组失败，请稍后再试");
        return;
      }
      setNotice(
        `分组完成：共 ${payload?.assigned ?? 0} 条，常规组 ${payload?.control ?? 0} 条 / ` +
          `AI 辅助组 ${payload?.assisted ?? 0} 条（分组结果固定不可修改）`,
      );
      await refreshList();
      await loadDetail(id);
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusyId(null);
    }
  }

  async function closeExperiment(id: string): Promise<void> {
    if (
      !window.confirm(
        "确定关闭该实验吗？关闭后停止分组效果（常规组恢复 AI 可用），历史与统计保留可查。",
      )
    ) {
      return;
    }
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/experiments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "关闭实验失败，请稍后再试");
        return;
      }
      setNotice("实验已关闭；该实验线索的常规组禁 AI 规则已解除，统计保留可查。");
      await refreshList();
      await loadDetail(id);
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">实验管理</h1>
          <p className="mt-1 text-sm text-gray-500">
            圈选线索随机分为常规组 / AI 辅助组，对比 AI 辅助效果；分组结果固定不可修改。
          </p>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setCreating((prev) => !prev)}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700"
          >
            {creating ? "收起创建表单" : "＋ 新建实验"}
          </button>
        )}
      </div>

      {creating && isAdmin && (
        <CreateExperimentForm
          stages={stages}
          owners={owners}
          onCreated={async () => {
            setCreating(false);
            setNotice("实验已创建为草稿，可执行分组");
            await refreshList();
          }}
        />
      )}

      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}

      {/* 实验列表（UIUX P8：名称/状态徽章/两组样本量） */}
      {experiments.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center text-sm text-gray-500">
          还没有实验。创建一个实验，对比 AI 辅助与常规方式的效果。
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {experiments.map((experiment) => (
            <li key={experiment.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => toggleExpand(experiment.id)}
                  className="flex flex-wrap items-center gap-2 text-left"
                >
                  <span className="font-medium text-gray-900">{experiment.name}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      EXPERIMENT_STATUS_BADGE_CLASS[experiment.status as ExperimentStatusValue]
                    }`}
                  >
                    {EXPERIMENT_STATUS_LABELS[experiment.status as ExperimentStatusValue]}
                  </span>
                  <span className="text-xs text-gray-400">
                    常规组 {experiment.controlCount} · AI 辅助组 {experiment.assistedCount}
                    {experiment.assignedAt ? ` · 分组于 ${experiment.assignedAt.slice(0, 10)}` : ""}
                  </span>
                </button>
                <div className="flex gap-2">
                  {isAdmin && experiment.status === "draft" && (
                    <button
                      type="button"
                      onClick={() => void submitAssign(experiment.id)}
                      disabled={busyId === experiment.id}
                      className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-60"
                    >
                      {busyId === experiment.id ? "执行中…" : "执行分组"}
                    </button>
                  )}
                  {isAdmin && experiment.status === "running" && (
                    <button
                      type="button"
                      onClick={() => void closeExperiment(experiment.id)}
                      disabled={busyId === experiment.id}
                      className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:opacity-60"
                    >
                      关闭实验
                    </button>
                  )}
                </div>
              </div>

              {expandedId === experiment.id && (
                <div className="mt-4 border-t border-gray-100 pt-3">
                  {/* 圈选条件 */}
                  <p className="text-xs text-gray-500">
                    圈选条件：
                    {[
                      experiment.source ? `来源=${experiment.source}` : null,
                      experiment.industry ? `行业=${experiment.industry}` : null,
                      experiment.stageId
                        ? `阶段=${stages.find((stage) => stage.id === experiment.stageId)?.name ?? "未知"}`
                        : null,
                      experiment.ownerId
                        ? `负责人=${owners.find((owner) => owner.id === experiment.ownerId)?.name ?? "未知"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "全部客户"}
                    ；AI 辅助组占比 {experiment.assistedRatio}%；最小样本阈值{" "}
                    {experiment.minSampleSize}
                  </p>

                  {/* 对比（复用 P7 表：样本量/比例/绝对差异/周期 + 样本不足横幅） */}
                  {stats ? (
                    <div className="mt-3">
                      <div className="overflow-x-auto rounded-md border border-gray-100">
                        <table className="w-full min-w-100 text-sm">
                          <thead>
                            <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                              <th className="px-2 py-2 font-medium">指标</th>
                              <th className="px-2 py-2 font-medium">
                                常规组（{stats.controlSampleSize}）
                              </th>
                              <th className="px-2 py-2 font-medium">
                                AI 辅助组（{stats.assistedSampleSize}）
                              </th>
                              <th className="px-2 py-2 font-medium">绝对差异</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stats.rows.map((row) => (
                              <tr key={row.metricKey} className="border-b border-gray-50">
                                <td className="px-2 py-1.5 text-gray-700">{row.metricLabel}</td>
                                <td className="px-2 py-1.5 tabular-nums">
                                  {row.comparison.controlRatio === null
                                    ? "—"
                                    : `${row.comparison.controlRatio}%`}
                                </td>
                                <td className="px-2 py-1.5 tabular-nums">
                                  {row.comparison.assistedRatio === null
                                    ? "—"
                                    : `${row.comparison.assistedRatio}%`}
                                </td>
                                <td className="px-2 py-1.5 tabular-nums">
                                  {row.comparison.diffPp === null
                                    ? "—"
                                    : `${row.comparison.diffPp > 0 ? "+" : ""}${row.comparison.diffPp}pp`}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {stats.rows.some((row) => row.comparison.insufficient) && (
                        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                          ⚠ {SAMPLE_INSUFFICIENT_NOTICE}（阈值 {stats.minSampleSize}）
                        </p>
                      )}
                      <p className="mt-1.5 text-xs text-gray-400">
                        统计周期：{stats.periodLabel} ·{" "}
                        {EXPERIMENT_COMPARISON_METRICS.map((metric) => metric.label).join(" / ")}
                        为周期内达成该指标的线索占组内样本比例；本表只呈现数值，
                        不构成 AI 造成提升的因果结论（PRD §5.10）。
                      </p>
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-gray-400">统计加载中…</p>
                  )}

                  {/* 两组名单（仅管理员） */}
                  {assignments !== null && (
                    <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {(["control", "assisted"] as ExperimentGroupValue[]).map((group) => (
                        <div key={group} className="rounded-md border border-gray-100 p-3">
                          <div className="mb-2 flex items-center gap-2">
                            <GroupBadgeInline group={group} />
                            <span className="text-xs text-gray-400">
                              {assignments.filter((item) => item.group === group).length} 条
                            </span>
                          </div>
                          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                            {assignments
                              .filter((item) => item.group === group)
                              .map((item) => (
                                <li key={item.id} className="truncate text-sm text-gray-700">
                                  {item.leadName}
                                </li>
                              ))}
                            {assignments.filter((item) => item.group === group).length === 0 && (
                              <li className="text-sm text-gray-400">—</li>
                            )}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- 创建表单（草稿；UIUX P8：圈选条件 + 比例 + 阈值） ----------

function CreateExperimentForm({
  stages,
  owners,
  onCreated,
}: {
  stages: { id: string; name: string }[];
  owners: { id: string; name: string }[];
  onCreated: () => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [industry, setIndustry] = useState("");
  const [stageId, setStageId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [assistedRatio, setAssistedRatio] = useState(50);
  const [minSampleSize, setMinSampleSize] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        assistedRatio,
        minSampleSize,
      };
      if (source.trim()) {
        body.source = source.trim();
      }
      if (industry.trim()) {
        body.industry = industry.trim();
      }
      if (stageId) {
        body.stageId = stageId;
      }
      if (ownerId) {
        body.ownerId = ownerId;
      }
      const response = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { message?: string } }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "创建实验失败，请稍后再试");
        return;
      }
      await onCreated();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-blue-100 bg-blue-50/40 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="mb-3 text-sm font-semibold text-gray-900">新建实验（保存为草稿）</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">实验名称 *</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={64}
            required
            className={INPUT_CLASS}
            placeholder="如：AI 效果验证"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">客户来源（圈选，精确匹配）</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className={INPUT_CLASS}
            placeholder="留空 = 不限"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">行业（圈选，精确匹配）</span>
          <input
            value={industry}
            onChange={(event) => setIndustry(event.target.value)}
            className={INPUT_CLASS}
            placeholder="留空 = 不限"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">阶段（圈选，当前阶段）</span>
          <select
            value={stageId}
            onChange={(event) => setStageId(event.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">不限</option>
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">负责人（圈选）</span>
          <select
            value={ownerId}
            onChange={(event) => setOwnerId(event.target.value)}
            className={INPUT_CLASS}
          >
            <option value="">不限</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">
            AI 辅助组占比（{EXPERIMENT_MIN_RATIO}–{EXPERIMENT_MAX_RATIO}%）
          </span>
          <input
            type="number"
            min={EXPERIMENT_MIN_RATIO}
            max={EXPERIMENT_MAX_RATIO}
            value={assistedRatio}
            onChange={(event) => setAssistedRatio(Number(event.target.value))}
            className={INPUT_CLASS}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-600">最小样本阈值（默认 50）</span>
          <input
            type="number"
            min={1}
            value={minSampleSize}
            onChange={(event) => setMinSampleSize(Number(event.target.value))}
            className={INPUT_CLASS}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-gray-400">
        已被其他实验分组的线索不会参与本次分组（同一线索不可重复分组）。
      </p>
      <button
        type="submit"
        disabled={busy || name.trim() === ""}
        className="mt-3 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "保存中…" : "保存草稿"}
      </button>
    </form>
  );
}
