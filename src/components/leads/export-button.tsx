"use client";

import { useState } from "react";
import type { LeadListQuery } from "@/lib/schemas/lead";

// 导出按钮（T05，P3 线索池工具栏）：按当前筛选导出 XLSX / CSV。
// POST /api/exports/leads 创建导出（限流 5 次/小时）→ 拿到 id 后走下载端点。

export function ExportButton({ query }: { query: LeadListQuery }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function exportAs(format: "xlsx" | "csv"): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/exports/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, filters: query }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { downloadPath?: string; filename?: string }
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !payload || !("downloadPath" in payload) || !payload.downloadPath) {
        setError(
          (payload as { error?: { message?: string } })?.error?.message ??
            "导出失败，请稍后再试",
        );
        return;
      }
      window.location.href = payload.downloadPath;
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void exportAs("xlsx")}
          disabled={busy}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "导出中…" : "导出 XLSX"}
        </button>
        <button
          type="button"
          onClick={() => void exportAs("csv")}
          disabled={busy}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "导出中…" : "导出 CSV"}
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
