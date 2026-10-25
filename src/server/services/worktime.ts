import type { Prisma } from "@prisma/client";
import { AuthUser } from "@/lib/auth";
import { toUtcDateString } from "@/lib/format";
import { workweekDays, workweekStart } from "@/lib/worktime";
import { prisma } from "@/server/db";

// 每日工时服务（T11，实施计划 §4.2 work_time_entries / §6 工时 API / K5、C03）。
//
// 数据范围：工时是"每人每日一条"的个人数据，恒以当前登录用户读写；
// 他人（含管理员）不可见，也无跨人代填（看板聚合由指标引擎按数据范围另行实现，T12/T13）。
//
// 重复提交覆盖不报错（T11 验收项）：upsert 生成 INSERT … ON CONFLICT DO UPDATE，
// 原子覆盖；unique(user_id, work_date) 数据库约束兜底，并发提交也不会产生第二行。
//
// "未填报"与"当天未工作"区分：无行 → hours=null（看板"—"的数据前提，C03），
// hours=0 为已填报的零工时，看板同为"—"但语义可区分（审计留痕）。

export interface WorktimeEntryView {
  /** 上海日历日 YYYY-MM-DD（C13） */
  date: string;
  /** 未填报为 null（看板该项显示"—"，C03）；0 为已填报的零工时 */
  hours: number | null;
}

/** 纯日期字符串 → UTC 零点 Date（@db.Date 落库口径，同 leads.contract_expiry） */
function toDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toView(entry: {
  workDate: Date;
  hours: Prisma.Decimal;
}): WorktimeEntryView {
  return { date: toUtcDateString(entry.workDate), hours: entry.hours.toNumber() };
}

/** 单日查询：未填报返回 { date, hours: null }（不视为错误，看板显示"—"） */
export async function getWorktimeEntry(
  user: AuthUser,
  date: string,
): Promise<WorktimeEntryView> {
  const entry = await prisma.workTimeEntry.findUnique({
    where: {
      userId_workDate: { userId: user.id, workDate: toDateOnly(date) },
    },
  });
  return entry ? toView(entry) : { date, hours: null };
}

/**
 * 周历查询：以 dateInWeek 所在周的周一为起点返回 7 天（未填报天 hours=null）。
 * 周历填报 UI（P9"每日工时"）与后续周维度看板聚合共用同一实现。
 */
export async function getWorktimeWeek(
  user: AuthUser,
  dateInWeek: string,
): Promise<{ weekStart: string; days: WorktimeEntryView[] }> {
  const days = workweekDays(workweekStart(dateInWeek));
  const entries = await prisma.workTimeEntry.findMany({
    where: {
      userId: user.id,
      workDate: { gte: toDateOnly(days[0]), lte: toDateOnly(days[6]) },
    },
  });
  const byDate = new Map(entries.map((entry) => [toUtcDateString(entry.workDate), entry]));
  return {
    weekStart: days[0],
    days: days.map((date) => {
      const entry = byDate.get(date);
      return entry ? toView(entry) : { date, hours: null };
    }),
  };
}

/** 录入/修改当天工时（每人每日一条：存在即覆盖，不存在则创建） */
export async function upsertWorktime(
  user: AuthUser,
  date: string,
  hours: number,
): Promise<WorktimeEntryView> {
  const entry = await prisma.workTimeEntry.upsert({
    where: {
      userId_workDate: { userId: user.id, workDate: toDateOnly(date) },
    },
    create: { userId: user.id, workDate: toDateOnly(date), hours },
    update: { hours },
  });
  return toView(entry);
}
