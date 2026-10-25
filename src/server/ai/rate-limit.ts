import { prisma } from "@/server/db";
import { startOfShanghaiDay } from "@/lib/tasks";

// 每日频控（T08，实施计划 §7.1 Guard② / §8.1 / C05 / R9）：
// 每用户每日调用上限，默认 50 次，可经环境变量 AI_DAILY_LIMIT 配置（T15 设置页接管）。
// 计数口径：当日（上海日界 C13）创建的全部 ai_runs——发起即计数，
// 失败/重试同样占用额度，避免用失败重试刷量；查询接口供 UI 用量行展示（UIUX §4.7）。

export const DEFAULT_DAILY_AI_LIMIT = 50;

export function dailyAiLimit(): number {
  const raw = Number(process.env.AI_DAILY_LIMIT);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_DAILY_AI_LIMIT;
  }
  return Math.floor(raw);
}

/** 当日已用次数（上海日界起算，含全部状态） */
export async function countRunsToday(userId: string, now: Date = new Date()): Promise<number> {
  return prisma.aiRun.count({
    where: {
      userId,
      createdAt: { gte: startOfShanghaiDay(0, now) },
    },
  });
}

export interface AiQuotaSnapshot {
  used: number;
  limit: number;
}

export async function getTodayUsage(userId: string, now: Date = new Date()): Promise<AiQuotaSnapshot> {
  return { used: await countRunsToday(userId, now), limit: dailyAiLimit() };
}
