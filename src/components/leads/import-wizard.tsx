"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";

// P4 导入向导（T05）：上传 → 字段映射 → 预览（有效/错误/重复分栏）→ 逐行决定 → 确认 → 结果汇总。
// 两阶段语义：确认前只写导入批次表，正式客户数据在"确认导入"时才入库。

const BTN_PRIMARY =
  "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60";
const BTN_PLAIN =
  "rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60";
const SELECT_CLASS =
  "h-9 rounded-md border border-gray-300 bg-white px-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

interface UploadResult {
  batchId: string;
  filename: string;
  headers: string[];
  mapping: Record<string, string | null>;
  counts: { total: number; valid: number; error: number; dup: number };
}

interface PreviewRow {
  id: string;
  rowNo: number;
  name: string;
  contactPhone: string;
  city: string;
  errors: { key: string; label: string; message: string }[];
  dupType: "none" | "exact" | "fuzzy";
  dupLeadId: string | null;
  dupLeadName: string | null;
  dupRowNo: number | null;
  decision: "skip" | "create_new";
}

interface PreviewData {
  counts: { total: number; valid: number; error: number; dup: number } | null;
  rows: PreviewRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface ConfirmResult {
  total: number;
  created: number;
  skipped: number;
  recheckFailed: number;
}

type Tab = "all" | "valid" | "error" | "dup";

function dupText(row: PreviewRow): string {
  if (row.dupType === "none") {
    return "";
  }
  const kind = row.dupType === "exact" ? "手机号与已有客户相同（确认重复）" : "名称+城市与已有客户相似（疑似重复）";
  const target = row.dupLeadName
    ? `「${row.dupLeadName}」`
    : row.dupRowNo
      ? `文件内第 ${row.dupRowNo} 行`
      : "";
  return `${kind}${target ? `：${target}` : ""}`;
}

export function ImportWizard({
  targets,
}: {
  targets: { key: string; label: string }[];
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [tab, setTab] = useState<Tab>("all");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [decisions, setDecisions] = useState<Map<string, "skip" | "create_new">>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const labelByKey = useMemo(
    () => new Map(targets.map((target) => [target.key, target.label])),
    [targets],
  );

  const loadPreview = useCallback(
    async (batchId: string, nextTab: Tab, nextPage: number) => {
      setLoadingPreview(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          tab: nextTab,
          page: String(nextPage),
          pageSize: "50",
        });
        const response = await fetch(
          `/api/imports/${batchId}/rows?${params.toString()}`,
        );
        const payload = (await response.json().catch(() => null)) as
          | PreviewData
          | { error?: { message?: string } }
          | null;
        if (!response.ok || !payload || !("rows" in payload)) {
          setError(
            (payload as { error?: { message?: string } })?.error?.message ??
              "加载预览失败，请稍后再试",
          );
          return;
        }
        setPreview(payload);
      } catch {
        setError("网络异常，请稍后再试");
      } finally {
        setLoadingPreview(false);
      }
    },
    [],
  );

  async function handleUpload(file: File): Promise<void> {
    setUploading(true);
    setError(null);
    setMessage(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/imports", { method: "POST", body: form });
      const payload = (await response.json().catch(() => null)) as
        | UploadResult
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !payload || !("batchId" in payload)) {
        setError(
          (payload as { error?: { message?: string } })?.error?.message ??
            "上传失败，请检查文件后重试",
        );
        return;
      }
      setUpload(payload);
      setMapping(payload.mapping);
      setDecisions(new Map());
      setPreview(null);
      setTab("all");
      setMessage("文件解析完成，请确认字段映射");
      await loadPreview(payload.batchId, "all", 1);
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleSaveMapping(): Promise<void> {
    if (!upload) {
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const response = await fetch(`/api/imports/${upload.batchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { counts?: UploadResult["counts"]; error?: { message?: string } }
        | null;
      if (!response.ok || !payload?.counts) {
        setError(payload?.error?.message ?? "保存映射失败，请稍后再试");
        return;
      }
      setUpload({ ...upload, counts: payload.counts, mapping });
      setDecisions(new Map());
      setTab("all");
      await loadPreview(upload.batchId, "all", 1);
      setMessage("映射已保存，预览已更新");
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setConfirming(false);
    }
  }

  function switchTab(nextTab: Tab): void {
    if (!upload) {
      return;
    }
    setTab(nextTab);
    void loadPreview(upload.batchId, nextTab, 1);
  }

  function switchPage(nextPage: number): void {
    if (!upload) {
      return;
    }
    void loadPreview(upload.batchId, tab, nextPage);
  }

  function setDecision(rowId: string, decision: "skip" | "create_new"): void {
    setDecisions((prev) => {
      const next = new Map(prev);
      next.set(rowId, decision);
      return next;
    });
  }

  async function handleConfirm(): Promise<void> {
    if (!upload) {
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const response = await fetch(`/api/imports/${upload.batchId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: [...decisions.entries()].map(([rowId, decision]) => ({
            rowId,
            decision,
          })),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | ConfirmResult
        | { error?: { message?: string } }
        | null;
      if (!response.ok || !payload || !("created" in payload)) {
        setError(
          (payload as { error?: { message?: string } })?.error?.message ??
            "确认导入失败，请稍后再试",
        );
        return;
      }
      setResult(payload);
      setMessage(null);
      setPreview(null);
    } catch {
      setError("网络异常，请稍后再试");
    } finally {
      setConfirming(false);
    }
  }

  const totalPages = preview ? Math.max(1, Math.ceil(preview.total / preview.pageSize)) : 1;
  const counts = upload?.counts;

  return (
    <div className="flex flex-col gap-4">
      {/* 步骤指示 */}
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {[
          { step: 1, label: "① 上传文件" },
          { step: 2, label: "② 字段映射" },
          { step: 3, label: "③ 预览与决定" },
          { step: 4, label: "④ 确认导入" },
        ].map((item) => {
          const active =
            (item.step === 1 && !upload) ||
            (item.step === 2 && upload && !result) ||
            (item.step === 3 && upload && !result) ||
            (item.step === 4 && !!result);
          return (
            <li
              key={item.step}
              className={`rounded-full px-3 py-1 ${
                active ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500"
              }`}
            >
              {item.label}
            </li>
          );
        })}
      </ol>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {message && !result && <p className="text-sm text-emerald-700">{message}</p>}

      {/* 步骤 1：上传 */}
      {!result && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv"
              aria-label="选择要导入的文件"
              className="text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleUpload(file);
                }
              }}
            />
            {uploading && <span className="text-sm text-gray-500">解析中…</span>}
            {/* 文件下载端点（Content-Disposition 附件），非页面导航，不用 Link */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/api/imports/template"
              className="text-sm text-blue-700 hover:underline"
            >
              下载导入模板（XLSX）
            </a>
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/api/imports/template?format=csv"
              className="text-sm text-blue-700 hover:underline"
            >
              CSV 模板
            </a>
          </div>
          <p className="mt-2 text-xs text-gray-500">
            支持 .xlsx / .csv，单次最多 5000 行、文件不超过 10MB；确认导入前不会写入客户数据。
          </p>
          {upload && (
            <p className="mt-1 text-sm text-gray-600">
              当前文件：{upload.filename}
            </p>
          )}
        </section>
      )}

      {/* 步骤 2：映射 */}
      {upload && !result && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <h2 className="mb-3 text-sm font-semibold">字段映射</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">文件列</th>
                  <th className="px-3 py-2 font-medium">导入到系统字段</th>
                </tr>
              </thead>
              <tbody>
                {upload.headers.map((header, index) => {
                  const value = mapping[String(index)] ?? null;
                  return (
                    <tr key={index} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-3 py-2 font-medium text-gray-700">{header}</td>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`映射文件列 ${header}`}
                          className={SELECT_CLASS}
                          value={value ?? ""}
                          onChange={(event) =>
                            setMapping((prev) => ({
                              ...prev,
                              [String(index)]: event.target.value || null,
                            }))
                          }
                        >
                          <option value="">（不导入）</option>
                          {targets.map((target) => (
                            <option key={target.key} value={target.key}>
                              {target.label}
                              {target.key === "name" ? "（必填）" : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={handleSaveMapping} disabled={confirming || uploading}>
              {confirming ? "保存中…" : "保存映射并更新预览"}
            </button>
          </div>
        </section>
      )}

      {/* 步骤 3：预览 */}
      {upload && !result && preview && counts && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">预览（共 {counts.total} 行）</h2>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["all", `全部 ${counts.total}`],
                  ["valid", `有效 ${counts.valid}`],
                  ["error", `错误 ${counts.error}`],
                  ["dup", `重复 ${counts.dup}`],
                ] as [Tab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchTab(key)}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${
                    tab === key
                      ? "bg-blue-600 text-white"
                      : "border border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-xs text-gray-500">
                  <th className="px-3 py-2 font-medium">行号</th>
                  <th className="px-3 py-2 font-medium">客户名称</th>
                  <th className="px-3 py-2 font-medium">联系方式</th>
                  <th className="px-3 py-2 font-medium">城市</th>
                  <th className="px-3 py-2 font-medium">错误 / 重复说明</th>
                  <th className="px-3 py-2 font-medium">本次导入决定</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const decision = decisions.get(row.id) ?? row.decision;
                  const issue = row.errors.length
                    ? row.errors.map((item) => `${item.label}：${item.message}`).join("；")
                    : dupText(row);
                  return (
                    <tr key={row.id} className="border-b border-gray-100 last:border-b-0 align-top">
                      <td className="px-3 py-2 text-gray-500">{row.rowNo}</td>
                      <td className="px-3 py-2 font-medium text-gray-700">{row.name || "—"}</td>
                      <td className="px-3 py-2 text-gray-600">{row.contactPhone || "—"}</td>
                      <td className="px-3 py-2 text-gray-600">{row.city || "—"}</td>
                      <td className="px-3 py-2">
                        {issue ? (
                          <span
                            className={
                              row.errors.length ? "text-red-600" : "text-amber-700"
                            }
                          >
                            {issue}
                          </span>
                        ) : (
                          <span className="text-emerald-700">可导入</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {row.errors.length > 0 ? (
                          <span className="text-xs text-gray-400">错误行不可导入</span>
                        ) : (
                          <div className="flex items-center gap-3 text-sm">
                            <label className="flex items-center gap-1">
                              <input
                                type="radio"
                                name={`decision-${row.id}`}
                                checked={decision === "create_new"}
                                onChange={() => setDecision(row.id, "create_new")}
                              />
                              新建
                            </label>
                            <label className="flex items-center gap-1">
                              <input
                                type="radio"
                                name={`decision-${row.id}`}
                                checked={decision === "skip"}
                                onChange={() => setDecision(row.id, "skip")}
                              />
                              跳过
                            </label>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {preview.rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                      {loadingPreview ? "加载中…" : "该分栏没有数据"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm text-gray-600">
              第 {preview.page} / {totalPages} 页 · 共 {preview.total} 行
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className={BTN_PLAIN}
                disabled={preview.page <= 1 || loadingPreview}
                onClick={() => switchPage(preview.page - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className={BTN_PLAIN}
                disabled={preview.page >= totalPages || loadingPreview}
                onClick={() => switchPage(preview.page + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        </section>
      )}

      {/* 步骤 4：确认 + 结果 */}
      {upload && !result && counts && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-sm text-gray-600">
            将导入有效行 {counts.valid} 条 + 你勾选「新建」的重复行；错误行与其余重复行自动跳过。
          </p>
          <button
            type="button"
            className={`mt-3 ${BTN_PRIMARY}`}
            onClick={handleConfirm}
            disabled={confirming || uploading}
          >
            {confirming ? "导入中…" : "确认导入"}
          </button>
        </section>
      )}

      {result && (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4">
          <h2 className="text-sm font-semibold text-emerald-800">导入完成</h2>
          <p className="mt-2 text-sm text-gray-700">
            共处理 {result.total} 行：新建 {result.created} 条，跳过 {result.skipped} 条
            {result.recheckFailed > 0
              ? `（其中 ${result.recheckFailed} 条因字段配置变化复检未通过）`
              : ""}
            。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/leads" className={BTN_PRIMARY}>
              前往线索池查看
            </Link>
            <button
              type="button"
              className={BTN_PLAIN}
              onClick={() => {
                setResult(null);
                setUpload(null);
                setMapping({});
                setPreview(null);
                setDecisions(new Map());
                setMessage(null);
                setError(null);
              }}
            >
              再导入一个文件
            </button>
          </div>
        </section>
      )}

      {upload && !result && counts && counts.error > 0 && (
        <p className="text-xs text-gray-500">
          错误行原因与表单校验完全一致（如“{labelByKey.get("contact_phone") ?? "联系方式"}
          ：联系方式仅支持数字及 + - ( ) 空格”）；修正源文件后重新上传即可。
        </p>
      )}
    </div>
  );
}
