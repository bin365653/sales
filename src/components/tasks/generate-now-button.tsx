"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// [立即生成]（V2.0-T07，UIUX §5.4）：管理员手动全量触发任务生成。
// 幂等说明 tooltip：「重复执行不会产生重复任务」；完成后 Toast 统计
// 「生成完成:新建 N 条,跳过 M 条」。

export function GenerateNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function generate(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/tasks/generate", { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | {
            createdTasks?: number;
            skippedTasks?: number;
            error?: { message?: string };
          }
        | null;
      if (!response.ok) {
        setError(payload?.error?.message ?? "任务生成遇到问题，请稍后重试");
        return;
      }
      setNotice(
        `生成完成：新建 ${payload?.createdTasks ?? 0} 条，跳过 ${payload?.skippedTasks ?? 0} 条（已存在不重复生成）`,
      );
      router.refresh();
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void generate()}
        disabled={busy}
        title="手动执行一轮任务生成；重复执行不会产生重复任务"
        className="h-9 rounded-md border border-blue-200 bg-blue-50 px-4 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-60"
      >
        {busy ? "生成中…" : "⚡ 立即生成"}
      </button>
      {notice && (
        <span className="text-xs text-emerald-700" role="status">
          {notice}
        </span>
      )}
      {error && (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
