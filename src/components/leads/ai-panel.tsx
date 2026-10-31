"use client";

import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AI_ERROR_MESSAGES,
  RUN_STATUS_BADGE_CLASS,
  RUN_STATUS_LABELS,
  RUN_TYPE_LABELS,
  type RunStatusValue,
  type RunTypeValue,
} from "@/lib/schemas/ai";
import { toAiRunView, type AiRunView } from "@/lib/ai-run-view";
import { formatAiRunCopy } from "@/lib/ai-copy";
import { toShanghaiDateTimeString } from "@/lib/format";
import { analysisSchema, callPrepSchema, interactionSummarySchema, followupAdviceSchema, type AnalysisOutput, type CallPrepOutput, type InteractionSummaryOutput, type FollowupAdviceOutput } from "@/server/ai/validator";

// 详情页 AI 面板（T09/T10，UIUX §4.7/§6.2 全产品唯一 AI 交互模板）：
// - 触发：入口按钮常驻用量行；同一客户已有 pending run 时按钮禁用（防并发重复调用，
//   与沟通表单的「AI 生成摘要」经 externalPending/onPendingChange 双向互斥）；
//   达到每日上限时禁用并提示（文案见 §7.2）。
// - 运行：创建 run(pending) 后 2s 轮询，运行卡提示可离开页面；再次进入详情页时
//   经初始 runs 续接 pending 轮询（§4.7）；轮询上限 90 次（约 3 分钟），超时停止
//   自动刷新并提示到历史查看（服务端执行不受影响）。
// - 成功：按 PRD §5.4 八项 / §5.5 六项 / T10 摘要草稿两项结构化分区渲染（经与后端
//   同一份 Zod Schema 校验，结构异常降级为"无法解析"，不整面板崩溃）；事实绿、
//   推断琥珀、信息不足灰底；末项"需要避免的表述"红色警示块；常驻"不自动拨打/发送"边界。
//   摘要草稿仅展示原始输出；回填与确认保存在沟通表单完成（§7.1 摘要审核流）。
// - 失败：按 error_type 映射文案 + [重试]（= 新 run，原记录留痕，T08 retry API）。
// - 复制：§4.10 纯文本分节格式（src/lib/ai-copy.ts 单测固化）。
// - 历史：折叠列表，展开只读查看当时输出（渲染同成功态只读版）。
// - 隔离：面板包在错误边界内，任何渲染/请求异常只影响本面板（验收项：
//   AI 失败不影响页面其他功能）。

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 90;

export interface AiQuotaView {
  used: number;
  limit: number;
}

export interface AiPanelProps {
  leadId: string;
  leadName: string;
  initialRuns: AiRunView[];
  initialUsage: AiQuotaView;
  activePromptVersions: Partial<Record<RunTypeValue, number | null>>;
  /** 沟通表单等其他入口有 pending run 时禁用本面板发起（§4.7 防并发重复调用） */
  externalPending?: boolean;
  /** 本面板 pending 状态变化时通知父级（与表单互斥） */
  onPendingChange?: (pending: boolean) => void;
}

// ---------- 输出的宽容解析（渲染前校验，结构异常降级展示） ----------

function asAnalysis(output: unknown): AnalysisOutput | null {
  const verdict = analysisSchema.safeParse(output);
  return verdict.success ? verdict.data : null;
}

function asCallPrep(output: unknown): CallPrepOutput | null {
  const verdict = callPrepSchema.safeParse(output);
  return verdict.success ? verdict.data : null;
}

function asInteractionSummary(output: unknown): InteractionSummaryOutput | null {
  const verdict = interactionSummarySchema.safeParse(output);
  return verdict.success ? verdict.data : null;
}

function asFollowupAdvice(output: unknown): FollowupAdviceOutput | null {
  const verdict = followupAdviceSchema.safeParse(output);
  return verdict.success ? verdict.data : null;
}

// ---------- 结果渲染（PRD §5.4 八项；事实绿 / 推断琥珀 / 信息不足灰底） ----------

const FIT_LEVEL_BADGE: Record<string, string> = {
  high: "bg-emerald-50 text-emerald-700",
  mid: "bg-blue-50 text-blue-700",
  low: "bg-gray-100 text-gray-600",
  insufficient: "bg-gray-100 text-gray-500",
};

const FIT_LEVEL_LABEL: Record<string, string> = {
  high: "高",
  mid: "中",
  low: "低",
  insufficient: "信息不足",
};

function Section({
  title,
  tone = "normal",
  children,
}: {
  title: string;
  tone?: "normal" | "muted" | "warning";
  children: ReactNode;
}) {
  const titleClass =
    tone === "warning"
      ? "text-sm font-semibold text-red-600"
      : "text-sm font-semibold text-gray-900";
  const bodyClass =
    tone === "warning"
      ? "mt-1.5 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
      : "mt-1.5 text-sm text-gray-800";
  return (
    <div>
      <h4 className={titleClass}>{title}</h4>
      <div className={bodyClass}>{children}</div>
    </div>
  );
}

function BulletList({
  items,
  tone,
}: {
  items: string[];
  tone: "fact" | "inference";
}) {
  if (items.length === 0) {
    return <p className="text-sm text-gray-400">—</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2 text-sm text-gray-800">
          <span
            className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
              tone === "fact" ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function AnalysisResultView({ output }: { output: AnalysisOutput }) {
  const known = output.facts
    .filter((fact) => fact.status === "confirmed")
    .map((fact) => `${fact.topic}：${fact.detail}`);
  const unverified = output.facts
    .filter((fact) => fact.status === "unverified")
    .map((fact) => `${fact.topic}：${fact.detail}`);
  return (
    <div className="flex flex-col gap-4">
      <div
        className={`rounded-md px-3 py-2 ${
          output.fit.level === "insufficient" ? "bg-gray-100" : "bg-gray-50"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-900">客户匹配度</span>
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              FIT_LEVEL_BADGE[output.fit.level] ?? "bg-gray-100 text-gray-500"
            }`}
          >
            {FIT_LEVEL_LABEL[output.fit.level] ?? output.fit.level}
          </span>
        </div>
        <p className="mt-1.5 text-sm text-gray-800">{output.fit.reason}</p>
      </div>
      <Section title="已知事实">
        <BulletList items={known} tone="fact" />
      </Section>
      <Section title="待核实信息">
        <BulletList items={unverified} tone="inference" />
      </Section>
      <Section title="经营痛点（含推断依据，最多 3 项）">
        {output.pains.length === 0 ? (
          <p className="text-sm text-gray-400">—</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {output.pains.map((pain, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                <span className="text-gray-800">
                  {pain.pain}
                  <span className="mt-0.5 block text-xs text-amber-700">
                    推断依据：{pain.evidence}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="沟通切入点">
        <BulletList items={output.angles} tone="fact" />
      </Section>
      <Section title="推荐的下一步动作">
        <p>{output.next_action}</p>
      </Section>
      <Section title="信息不足时需向客户核实的问题">
        <BulletList items={output.verify_questions} tone="inference" />
      </Section>
      {/* V2.0-T11 analysis v2：缺失信息（琥珀）与信息矛盾（红描边） */}
      {output.gaps && output.gaps.length > 0 && (
        <Section title="缺失信息（建议本次核实）">
          <ul className="flex flex-col gap-1">
            {output.gaps.map((gap, index) => (
              <li key={index} className="flex items-start gap-2 text-sm text-gray-800">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-500" />
                <span>
                  {gap.field}
                  <span className="mt-0.5 block text-xs text-amber-700">{gap.question}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {output.contradictions && output.contradictions.length > 0 && (
        <Section title="信息矛盾（建议核实澄清）">
          <ul className="flex flex-col gap-2">
            {output.contradictions.map((item, index) => (
              <li
                key={index}
                className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-sm text-red-700"
              >
                冲突：{item.conflict}
                <span className="mt-0.5 block text-xs text-red-600/90">
                  建议：{item.suggestion}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function CallPrepResultView({ output }: { output: CallPrepOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <Section title="本次沟通目标">
        <p>{output.goal}</p>
      </Section>
      <Section title="开场建议（15–30 秒）">
        <p>{output.opening}</p>
      </Section>
      <Section title="需求诊断问题（3 个）">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-800">
          {output.diag_questions.map((question, index) => (
            <li key={index}>{question}</li>
          ))}
        </ol>
      </Section>
      <Section title="可能的异议与建议回应（2 个）">
        <ol className="flex flex-col gap-2">
          {output.objections.map((item, index) => (
            <li key={index} className="text-sm text-gray-800">
              <span className="font-medium text-gray-900">异议：</span>
              {item.objection}
              <span className="mt-0.5 block text-gray-700">
                <span className="font-medium text-gray-900">建议回应：</span>
                {item.response}
              </span>
            </li>
          ))}
        </ol>
      </Section>
      <Section title="希望确认的下一步">
        <p>{output.confirm_next}</p>
      </Section>
      <Section title="需要避免的未经核实表述" tone="warning">
        {output.avoid.length === 0 ? (
          <p>—</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {output.avoid.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        )}
      </Section>
      <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">
        以下表述未经核实，请勿在电话中使用；系统不会自动拨打电话或发送消息。
      </p>
    </div>
  );
}

/** T10 摘要草稿（§7.1 摘要审核流）：面板只读展示原始输出；
 * 回填与确认保存在沟通表单完成，正式记录以沟通时间线为准 */
function InteractionSummaryResultView({ output }: { output: InteractionSummaryOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <Section title="客户实际反馈（草稿）">
        <p>{output.summary}</p>
      </Section>
      <Section title="下一步动作（草稿）">
        <p>{output.next_action}</p>
      </Section>
      <p className="rounded-md border border-dashed border-violet-300 bg-violet-50/60 px-3 py-2 text-xs text-violet-700">
        以上为 AI 草稿：在沟通表单点击「AI 生成摘要」可回填并核对修改，确认保存后才形成正式沟通记录。
      </p>
    </div>
  );
}

/** V2.0-T11 跟进策略助手（UIUX §5.7）：原因解释 + 沟通建议；
 * 原因部分由服务端快照（任务来源/策略）约束，AI 只做解释 */
function FollowupAdviceResultView({ output }: { output: FollowupAdviceOutput }) {
  return (
    <div className="flex flex-col gap-4">
      <Section title="为什么现在联系这位客户">
        <p>{output.reason_explanation}</p>
      </Section>
      <Section title="沟通建议">
        <p>{output.communication_advice}</p>
      </Section>
      <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">
        ⓘ AI 建议不会自动修改客户画像、分类、到期时间或销售阶段；采纳需人工确认。
      </p>
    </div>
  );
}

function RunOutputView({ run }: { run: AiRunView }) {
  if (run.status === "pending") {
    return null;
  }
  if (run.status === "success") {
    if (run.runType === "analysis") {
      const output = asAnalysis(run.output);
      return output ? (
        <AnalysisResultView output={output} />
      ) : (
        <p className="text-sm text-gray-500">输出内容无法解析，可在历史中重试。</p>
      );
    }
    if (run.runType === "call_prep") {
      const output = asCallPrep(run.output);
      return output ? (
        <CallPrepResultView output={output} />
      ) : (
        <p className="text-sm text-gray-500">输出内容无法解析，可在历史中重试。</p>
      );
    }
    if (run.runType === "interaction_summary") {
      const output = asInteractionSummary(run.output);
      return output ? (
        <InteractionSummaryResultView output={output} />
      ) : (
        <p className="text-sm text-gray-500">输出内容无法解析，可在历史中重试。</p>
      );
    }
    if (run.runType === "followup_advice") {
      const output = asFollowupAdvice(run.output);
      return output ? (
        <FollowupAdviceResultView output={output} />
      ) : (
        <p className="text-sm text-gray-500">输出内容无法解析，可在历史中重试。</p>
      );
    }
    return <p className="text-sm text-gray-500">该任务类型的输出随对应功能交付。</p>;
  }
  // 失败/超时/格式异常：按 error_type 映射文案（UIUX §7.3）
  return (
    <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
      <p>{AI_ERROR_MESSAGES[run.errorType ?? ""] ?? "AI 调用失败，请重试"}</p>
      {run.errorMessage && (
        <p className="mt-1 break-all text-xs text-red-500/90">{run.errorMessage}</p>
      )}
    </div>
  );
}

// ---------- 面板主体 ----------

function statusBadge(status: RunStatusValue): ReactNode {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${RUN_STATUS_BADGE_CLASS[status]}`}>
      {RUN_STATUS_LABELS[status]}
    </span>
  );
}

export function AiPanel({
  leadId,
  leadName,
  initialRuns,
  initialUsage,
  activePromptVersions,
  externalPending = false,
  onPendingChange,
}: AiPanelProps) {
  const [runs, setRuns] = useState<AiRunView[]>(initialRuns);
  const [usage, setUsage] = useState<AiQuotaView>(initialUsage);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyExpandedId, setHistoryExpandedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pendingRun = runs.find((run) => run.status === "pending") ?? null;
  const quotaExhausted = usage.used >= usage.limit;
  const launchDisabled = busy || pendingRun !== null || quotaExhausted || externalPending;
  const displayRun =
    (selectedRunId ? runs.find((run) => run.id === selectedRunId) : undefined) ??
    runs[0] ??
    null;

  // 本面板 pending 状态变化时通知父级（与沟通表单的摘要发起互斥，§4.7）
  const pendingChangeRef = useRef(onPendingChange);
  pendingChangeRef.current = onPendingChange;
  useEffect(() => {
    pendingChangeRef.current?.(pendingRun !== null);
    return () => pendingChangeRef.current?.(false);
  }, [pendingRun]);

  /** 全量刷新历史 + 用量 + 提示词版本（发起失败/终态后调用） */
  const refreshHistory = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/leads/${leadId}/ai-runs`);
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as {
        runs?: unknown[];
        usage?: AiQuotaView;
        activePromptVersions?: Partial<Record<RunTypeValue, number | null>>;
      };
      if (Array.isArray(payload.runs)) {
        setRuns(payload.runs.map((run) => toAiRunView(run as Parameters<typeof toAiRunView>[0])));
      }
      if (payload.usage) {
        setUsage(payload.usage);
      }
    } catch {
      // 刷新失败不打扰用户：下一次轮询/操作会再触发
    }
  }, [leadId]);

  // pending run 轮询（2s，§4.7）；初始 runs 含 pending 时自动续接
  useEffect(() => {
    if (!pendingRun) {
      return;
    }
    const runId = pendingRun.id;
    let cancelled = false;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        if (!cancelled) {
          setActionError("生成耗时较长，已停止自动刷新；完成后可在「AI 历史」中查看结果");
        }
        return;
      }
      void (async () => {
        try {
          const response = await fetch(`/api/ai/runs/${runId}`);
          if (cancelled) {
            return;
          }
          if (response.status === 404) {
            clearInterval(timer);
            setActionError("该 AI 调用记录已不存在");
            void refreshHistory();
            return;
          }
          if (!response.ok) {
            return; // 瞬时错误：继续轮询
          }
          const payload = (await response.json()) as { run?: unknown };
          if (!payload.run) {
            return;
          }
          const view = toAiRunView(payload.run as Parameters<typeof toAiRunView>[0]);
          setRuns((prev) =>
            prev.some((run) => run.id === view.id)
              ? prev.map((run) => (run.id === view.id ? view : run))
              : [view, ...prev],
          );
          if (view.status !== "pending") {
            clearInterval(timer);
            void refreshHistory();
          }
        } catch {
          // 网络抖动：继续轮询
        }
      })();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingRun, refreshHistory]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  /** 发起（新类型或重新生成）与重试共用：拿到 run 即选中并交给轮询 effect */
  async function launch(request: () => Promise<Response>): Promise<void> {
    if (launchDisabled) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const response = await request();
      const payload = (await response.json().catch(() => null)) as
        | {
            run?: unknown;
            usage?: AiQuotaView;
            error?: { code?: string; message?: string };
          }
        | null;
      if (response.ok && payload?.run) {
        const view = toAiRunView(payload.run as Parameters<typeof toAiRunView>[0]);
        setRuns((prev) =>
          prev.some((run) => run.id === view.id) ? prev : [view, ...prev],
        );
        setSelectedRunId(view.id);
        if (payload.usage) {
          setUsage(payload.usage);
        }
        return;
      }
      const code = payload?.error?.code ?? "";
      // 429 时服务端是权威口径，重拉一次用量
      if (code === "ai_daily_limit") {
        void refreshHistory();
      }
      setActionError(
        payload?.error?.message ?? "AI 调用发起失败，请稍后再试",
      );
    } catch {
      setActionError("网络异常，请检查连接后重试");
    } finally {
      setBusy(false);
    }
  }

  function startRun(runType: RunTypeValue): Promise<void> {
    return launch(() =>
      fetch("/api/ai/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId, runType }),
      }),
    );
  }

  function retryRun(runId: string): Promise<void> {
    return launch(() => fetch(`/api/ai/runs/${runId}/retry`, { method: "POST" }));
  }

  async function copyRun(run: AiRunView): Promise<void> {
    const text = formatAiRunCopy(
      run.runType,
      leadName,
      toShanghaiDateTimeString(new Date(run.createdAt)),
      run.output,
    );
    if (text === null) {
      setCopyState("fail");
      scheduleCopyReset();
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("ok");
    } catch {
      setCopyState("fail");
    }
    scheduleCopyReset();
  }

  function scheduleCopyReset(): void {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  return (
    <section id="ai-panel" className="rounded-lg border border-violet-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-gray-900">AI 助手</h2>
        <span className="text-xs text-gray-400">
          今日 AI 已用 {usage.used}/{usage.limit}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void startRun("analysis")}
          disabled={launchDisabled}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          ✦ AI 客户分析
        </button>
        <button
          type="button"
          onClick={() => void startRun("call_prep")}
          disabled={launchDisabled}
          className="rounded-md border border-violet-300 bg-white px-3 py-1.5 text-sm font-medium text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          ✦ AI 电话准备卡
        </button>
        {/* V2.0-T11：第三入口——跟进策略助手（解释系统任务产生原因 + 沟通建议） */}
        <button
          type="button"
          onClick={() => void startRun("followup_advice")}
          disabled={launchDisabled}
          className="rounded-md border border-violet-300 bg-white px-3 py-1.5 text-sm font-medium text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          ✦ AI 跟进策略助手
        </button>
        <span className="text-xs text-gray-400">
          AI 只使用本客户已填写的信息，生成内容仅供参考
        </span>
      </div>

      {quotaExhausted && (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">
          今日 AI 调用已达上限（{usage.limit} 次），明日自动恢复；上限可在设置中调整。
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {actionError}
        </p>
      )}

      {/* 运行卡（可离开页面；再次进入自动续接） */}
      {pendingRun && (
        <div className="mt-3 flex items-center gap-3 rounded-md border border-violet-100 bg-violet-50/60 px-3 py-3">
          <span className="inline-block h-4 w-4 animate-pulse rounded-full bg-violet-500" />
          <div className="text-sm text-violet-800">
            <p className="font-medium">
              正在生成{RUN_TYPE_LABELS[pendingRun.runType]}… 预计需要 10–60 秒
            </p>
            <p className="mt-0.5 text-xs text-violet-600">
              可离开本页，完成后可在「AI 历史」中查看
            </p>
          </div>
        </div>
      )}

      {/* 主结果卡：选中 run（新发起/重试自动选中），否则最新一条 */}
      {!pendingRun && displayRun && (
        <div className="mt-3 rounded-md border border-gray-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-900">
              {RUN_TYPE_LABELS[displayRun.runType]}
            </span>
            {statusBadge(displayRun.status)}
            {displayRun.status === "success" && (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-700">
                AI 生成，仅供参考，请核对后使用
              </span>
            )}
            <span className="text-xs text-gray-400">
              {toShanghaiDateTimeString(new Date(displayRun.createdAt))}
              {displayRun.modelName ? ` · ${displayRun.modelName}` : ""}
              {displayRun.promptVersion ? ` · 提示词 v${displayRun.promptVersion}` : ""}
            </span>
          </div>
          <div className="mt-3">
            <RunOutputView run={displayRun} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {displayRun.status === "success" && (
              <button
                type="button"
                onClick={() => void copyRun(displayRun)}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
              >
                {copyState === "ok" ? "已复制" : copyState === "fail" ? "复制失败，请手动复制" : "复制"}
              </button>
            )}
            {(displayRun.status === "failed" ||
              displayRun.status === "timeout" ||
              displayRun.status === "invalid_output") && (
              <button
                type="button"
                onClick={() => void retryRun(displayRun.id)}
                disabled={launchDisabled}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                重试（生成新记录）
              </button>
            )}
            {/* 摘要草稿不提供面板侧"重新生成"：需携带原始沟通内容，统一从沟通表单发起（T10） */}
            {displayRun.runType !== "interaction_summary" && (
              <button
                type="button"
                onClick={() => void startRun(displayRun.runType)}
                disabled={launchDisabled}
                className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                重新生成
              </button>
            )}
            <button
              type="button"
              onClick={() => setHistoryOpen((prev) => !prev)}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
            >
              {historyOpen ? "收起历史" : "查看历史"}
            </button>
          </div>
        </div>
      )}

      {/* 空状态（无任何 run 且无 pending） */}
      {!pendingRun && !displayRun && (
        <p className="mt-3 rounded-md bg-gray-50 px-3 py-3 text-sm text-gray-500">
          尚未生成过 AI 分析。AI 只使用本客户已填写的信息，信息越完整，结果越可靠。
        </p>
      )}

      {/* 历史：折叠列表，展开只读查看当时输出 */}
      {historyOpen && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
            <span className="text-sm font-semibold text-gray-900">
              AI 历史（{runs.length} 条）
            </span>
            {(["analysis", "call_prep", "interaction_summary"] as RunTypeValue[]).map((runType) =>
              activePromptVersions[runType] ? (
                <span key={runType}>
                  {RUN_TYPE_LABELS[runType]}当前提示词 v{activePromptVersions[runType]}
                </span>
              ) : null,
            )}
          </div>
          {runs.length === 0 ? (
            <p className="text-sm text-gray-400">暂无历史记录</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {runs.map((run) => (
                <li key={run.id} className="rounded-md border border-gray-100">
                  <button
                    type="button"
                    onClick={() =>
                      setHistoryExpandedId((prev) => (prev === run.id ? null : run.id))
                    }
                    className="flex w-full flex-wrap items-center gap-2 px-2.5 py-2 text-left text-xs text-gray-500 hover:bg-gray-50"
                  >
                    <span className="text-gray-700">
                      {toShanghaiDateTimeString(new Date(run.createdAt))}
                    </span>
                    <span>{RUN_TYPE_LABELS[run.runType]}</span>
                    {statusBadge(run.status)}
                    {run.modelName && <span>{run.modelName}</span>}
                    {run.promptVersion && <span>提示词 v{run.promptVersion}</span>}
                    <span>数据版本 v{run.inputDataVersion}</span>
                  </button>
                  {historyExpandedId === run.id && (
                    <div className="border-t border-gray-100 px-2.5 py-3">
                      <RunOutputView run={run} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- 错误边界（验收项：AI 失败不影响页面其他功能） ----------

interface AiPanelBoundaryState {
  failed: boolean;
}

export class AiPanelErrorBoundary extends Component<
  { children: ReactNode },
  AiPanelBoundaryState
> {
  state: AiPanelBoundaryState = { failed: false };

  static getDerivedStateFromError(): AiPanelBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // 只记消息不记堆栈/数据内容（§8.3 日志脱敏精神）
    console.error(
      "[ai-panel] 面板渲染异常：",
      error instanceof Error ? error.message : error,
    );
  }

  render() {
    if (this.state.failed) {
      return (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-900">AI 助手</h2>
          <p className="mt-2 text-sm text-gray-500">
            AI 面板暂时无法显示，页面其他功能不受影响。
          </p>
          <button
            type="button"
            onClick={() => this.setState({ failed: false })}
            className="mt-2 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
          >
            重试
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

/** 详情页引用入口：边界 + 面板（页面无需感知边界实现） */
export function AiPanelSection(props: AiPanelProps): ReactNode {
  return (
    <AiPanelErrorBoundary>
      <AiPanel {...props} />
    </AiPanelErrorBoundary>
  );
}
