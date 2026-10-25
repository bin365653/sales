import { z } from "zod";

// 工时填报入参 Schema（T11）：API 入参与前端表单共用（实施计划 §2.1）。
//
// - 日期为纯日期 YYYY-MM-DD（上海日历日，C13；落库按 UTC 日期存储，
//   同 leads.contract_expiry 口径）：格式严格 + 真实日历日（2026-02-30 拒绝）；
// - hours 0–24、0.5 步进（UIUX §4.9）：0.5 的倍数在二进制浮点下均精确可表示，
//   Number.isInteger(v * 2) 判定安全；范围/步进以后端为唯一事实源；
//   hours=0 合法（"当天未工作"），与"未填报"（无行）区分，看板两者都显示"—"（C03）；
// - 查询参数 date / week 二选一：date 查单日（实施计划 §6 工时 API 契约），
//   week 查该日所在周（周一为起点）7 天，供周历填报 UI 使用。

export const workDateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日期不真实存在");

export const worktimeHoursSchema = z
  .number({ message: "工时应为数字" })
  .min(0, "工时不能小于 0")
  .max(24, "工时不能超过 24")
  .refine((value) => Number.isInteger(value * 2), "工时需为 0.5 的整数倍");

export const worktimeUpsertSchema = z.object({
  hours: worktimeHoursSchema,
});

export type WorktimeUpsertInput = z.infer<typeof worktimeUpsertSchema>;

export const worktimeQuerySchema = z
  .object({
    date: workDateStringSchema.optional(),
    week: workDateStringSchema.optional(),
  })
  .refine(
    (value) => (value.date === undefined) !== (value.week === undefined),
    { message: "date 与 week 查询参数必须二选一" },
  );

export type WorktimeQuery = z.infer<typeof worktimeQuerySchema>;
