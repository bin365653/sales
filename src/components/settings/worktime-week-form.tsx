"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { worktimeHoursSchema } from "@/lib/schemas/worktime";
import { shiftDateString, workweekStart, WORKWEEK_DAY_LABELS } from "@/lib/worktime";

// 周历工时填报（T11，UIUX P9"每日工时"页签；设置中心完整页随 T15）：
// - 周一~周日 7 格输入，0–24、0.5 步进（UIUX §4.9）；默认本周，可切上一周/下一周；
// - [保存本周] 只提交有改动的日期（PUT /api/worktime?date=…，upsert 覆盖不报错）；
//   输入留空 = 未填报（不提交该天）；切周时若有未保存修改先确认（防误丢）；
// - 校验复用与后端同一份 Zod Schema（错误文案一字不差，实施计划 §2.1），
//   服务端仍是唯一事实源（本地校验只为提前反馈）。

interface DayValue {
  date: string;
  hours: number | null;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

const WEEK_NAV_LINK_CLASS =
  "rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50";

export function WorktimeWeekForm({
  weekStart,
  initialDays,
  today,
}: {
  weekStart: string;
  initialDays: DayValue[];
  today: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialDays.map((day) => [day.date, day.hours === null ? "" : String(day.hours)]),
    ),
  );
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [invalidDates, setInvalidDates] = useState<Record<string, string>>({});
  const baseline = useRef(values);

  const dirtyDates = useMemo(
    () =>
      initialDays
        .map((day) => day.date)
        .filter(
          (date) =>
            (values[date] ?? "").trim() !== (baseline.current[date] ?? "").trim(),
        ),
    [initialDays, values],
  );
  const filledCount = initialDays.filter((day) => day.hours !== null).length;
  const currentWeekStart = workweekStart(today);

  function validateOne(date: string): string | null {
    const raw = (values[date] ?? "").trim();
    if (raw === "") {
      return null;
    }
    const parsed = worktimeHoursSchema.safeParse(Number(raw));
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "工时不合法");
  }

  function handleChange(date: string, value: string) {
    setValues((prev) => ({ ...prev, [date]: value }));
    setInvalidDates((prev) => {
      if (!prev[date]) {
        return prev;
      }
      const next = { ...prev };
      delete next[date];
      return next;
    });
  }

  async function handleSave() {
    if (status.kind === "saving") {
      return;
    }
    const errors: Record<string, string> = {};
    for (const day of initialDays) {
      const message = validateOne(day.date);
      if (message) {
        errors[day.date] = message;
      }
    }
    if (Object.keys(errors).length > 0) {
      setInvalidDates(errors);
      setStatus({
        kind: "error",
        message: "有未填对的工时（0–24、0.5 步进），请修正标红的日期后再保存",
      });
      return;
    }
    setInvalidDates({});
    const changed = dirtyDates;
    if (changed.length === 0) {
      return;
    }
    setStatus({ kind: "saving" });
    const results = await Promise.allSettled(
      changed.map(async (date) => {
        const hours = Number((values[date] ?? "").trim());
        const response = await fetch(`/api/worktime?date=${date}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hours }),
        });
        if (!response.ok) {
          const payload = (await response
            .json()
            .catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(payload?.error?.message ?? `保存失败（${date}）`);
        }
      }),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      const message =
        failed.reason instanceof Error ? failed.reason.message : "保存失败，请重试";
      setStatus({
        kind: "error",
        message: `部分日期保存失败：${message}（未成功的修改仍保留在输入框中，可重试）`,
      });
      return;
    }
    baseline.current = { ...values };
    setStatus({ kind: "saved", message: `已保存 ${changed.length} 天` });
    router.refresh();
  }

  function handleNavClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (dirtyDates.length === 0) {
      return;
    }
    if (!window.confirm("本周有未保存的修改，切换后将丢弃。确定切换？")) {
      event.preventDefault();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 周切换：链接承载 GET 语义（禁 JS 仍可切周查看，仅保存需 JS） */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/settings/worktime?week=${shiftDateString(weekStart, -7)}`}
          onClick={handleNavClick}
          className={WEEK_NAV_LINK_CLASS}
        >
          ← 上一周
        </Link>
        {weekStart !== currentWeekStart && (
          <Link href="/settings/worktime" onClick={handleNavClick} className={WEEK_NAV_LINK_CLASS}>
            回到本周
          </Link>
        )}
        <Link
          href={`/settings/worktime?week=${shiftDateString(weekStart, 7)}`}
          onClick={handleNavClick}
          className={WEEK_NAV_LINK_CLASS}
        >
          下一周 →
        </Link>
        <span className="ml-auto text-xs text-gray-500">
          {weekStart} ~ {shiftDateString(weekStart, 6)}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {initialDays.map((day, index) => {
          const invalid = invalidDates[day.date];
          return (
            <li
              key={day.date}
              className={`rounded-lg border bg-white px-3 py-2.5 ${
                invalid ? "border-red-300" : "border-gray-200"
              } ${day.date === today ? "ring-1 ring-blue-200" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-20 shrink-0">
                  <div className="text-sm font-medium text-gray-800">
                    {WORKWEEK_DAY_LABELS[index]}
                    {day.date === today && (
                      <span className="ml-1.5 rounded bg-blue-50 px-1 py-0.5 text-[10px] text-blue-700">
                        今天
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-400">{day.date.slice(5)}</div>
                </div>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={24}
                  step={0.5}
                  placeholder="未填报"
                  aria-label={`${day.date} 工时（小时）`}
                  value={values[day.date] ?? ""}
                  onChange={(event) => handleChange(day.date, event.target.value)}
                  className={`w-24 rounded-md border px-2.5 py-1.5 text-sm tabular-nums outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 ${
                    invalid ? "border-red-400" : "border-gray-300"
                  }`}
                />
                <span className="text-xs text-gray-400">小时</span>
              </div>
              {invalid && (
                <p className="mt-1 pl-[5.75rem] text-xs text-red-600">{invalid}</p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={status.kind === "saving" || dirtyDates.length === 0}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.kind === "saving"
            ? "保存中…"
            : dirtyDates.length > 0
              ? `保存本周（${dirtyDates.length} 天有修改）`
              : "保存本周"}
        </button>
        <span className="text-xs text-gray-500">
          本周已填 {filledCount}/7 天 · 未填报的日期，看板「每小时有效沟通」将显示 —
        </span>
        {status.kind === "saved" && (
          <span className="text-xs text-emerald-600">{status.message}</span>
        )}
        {status.kind === "error" && (
          <span className="text-xs text-red-600">{status.message}</span>
        )}
      </div>
    </div>
  );
}
