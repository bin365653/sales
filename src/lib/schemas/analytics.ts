import { z } from "zod";
import { workDateStringSchema } from "@/lib/schemas/worktime";

// 看板查询入参 Schema（T13，PRD §5.9 / UIUX P7）：API 与 /analytics 页共用。
//
// - period 预设：today / week / month（上海日历日，C13，周一起算）或 custom
//   自定义闭区间 [from, to]；custom 时 from/to 必填、from ≤ to、跨度 ≤ 366 天；
// - 非 custom 预设携带 from/to 一律拒绝（不静默忽略——与批量修改白名单同一哲学），
//   页面快速链接只携带 period 与 cohort 筛选，不会出现多余参数；
// - source / industry 为精确匹配（与线索池筛选同语义）；stageId 为线索当前
//   阶段（快照）圈定同批线索；ownerId 仅管理员生效（销售强制本人，服务层兜底）。

export const ANALYTIC_PERIODS = ["today", "week", "month", "custom"] as const;

export type AnalyticsPeriodPreset = (typeof ANALYTIC_PERIODS)[number];

/** 自定义范围最大跨度（天）：看板按周期复盘，超长区间无业务意义且拖慢聚合 */
export const ANALYTIC_MAX_RANGE_DAYS = 366;

const optionalCohortFilter = (label: string) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().trim().min(1, `${label}筛选条件不合法`).max(128).optional(),
  );

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID 格式不合法",
  );

function calendarDayDiff(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

export const analyticsQuerySchema = z
  .object({
    period: z.enum(ANALYTIC_PERIODS).default("week"),
    from: workDateStringSchema.optional(),
    to: workDateStringSchema.optional(),
    source: optionalCohortFilter("客户来源"),
    industry: optionalCohortFilter("行业"),
    stageId: uuidSchema.optional(),
    ownerId: uuidSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.period !== "custom") {
      if (value.from !== undefined || value.to !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["from"],
          message: "仅自定义范围（period=custom）接受 from/to 参数",
        });
      }
      return;
    }
    if (value.from === undefined || value.to === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "自定义范围须提供 from 与 to",
      });
      return;
    }
    if (value.from > value.to) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: "开始日期不能晚于结束日期",
      });
      return;
    }
    if (calendarDayDiff(value.from, value.to) > ANALYTIC_MAX_RANGE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["to"],
        message: `自定义范围最长 ${ANALYTIC_MAX_RANGE_DAYS} 天`,
      });
    }
  });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
