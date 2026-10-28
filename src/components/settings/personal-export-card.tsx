"use client";

import { useState } from "react";

// 个人数据导出（T15，UIUX P9）：说明卡 + [导出我的全部数据]。
// POST /api/exports/me（T05–T08 交付：ZIP=客户 XLSX/CSV+沟通+任务+AI 记录，
// 每小时限 5 次，创建与下载分离）→ 成功后自动触发下载并注明"已记录审计日志"。

export function PersonalExportCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ filename: string; rowCount: number } | null>(
    null,
  );

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/exports/me", { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | {
            id?: string;
            filename?: string;
            rowCount?: number;
            downloadPath?: string;
            error?: { message?: string };
          }
        | null;
      if (!response.ok || !payload?.downloadPath) {
        setError(payload?.error?.message ?? "导出失败，请稍后再试");
        return;
      }
      // 创建与下载分离（§6 导出契约）：拿到下载路径后触发浏览器下载
      const anchor = document.createElement("a");
      anchor.href = payload.downloadPath;
      anchor.download = payload.filename ?? "";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setResult({
        filename: payload.filename ?? "导出文件",
        rowCount: payload.rowCount ?? 0,
      });
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold text-gray-900">个人数据导出</h2>
      <p className="text-sm text-gray-600">
        导出范围：本人名下全部客户（含已删除）及其沟通记录、任务、AI 调用记录，
        打包为 ZIP 下载。导出会记录操作日志；文件 24 小时后过期。
      </p>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="mt-3 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? "生成中…" : "导出我的全部数据"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
      {result && (
        <p className="mt-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          已生成 {result.filename}（{result.rowCount} 个客户）并开始下载；本次导出已记录审计日志。
        </p>
      )}
    </div>
  );
}
