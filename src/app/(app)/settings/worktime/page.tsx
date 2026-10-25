import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/current-user";
import { getWorktimeWeek } from "@/server/services/worktime";
import { workDateStringSchema } from "@/lib/schemas/worktime";
import { toShanghaiDateString } from "@/lib/format";
import { WorktimeWeekForm } from "@/components/settings/worktime-week-form";

export const dynamic = "force-dynamic";

// P9·个人设置：每日工时填报（T11，UIUX P9"每日工时"页签；K5/C03）。
// 周历视图（周一~周日 7 格，0–24、0.5 步进，UIUX §4.9），默认本周、可切上周/下周；
// 数据经服务层 getWorktimeWeek（与 GET /api/worktime?week= 同一实现，口径必然一致）。
// 设置中心完整页签结构随 T15 交付，本页届时并入 /settings（组件可直接复用）。

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

export default async function WorktimePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }

  const raw = await searchParams;
  const weekParam = Array.isArray(raw.week) ? raw.week[0] : raw.week;
  const parsedWeek = weekParam ? workDateStringSchema.safeParse(weekParam) : null;
  // 非法/缺省 week 参数一律回落到本周（上海日历日，C13），不报错
  const anchor = parsedWeek?.success ? parsedWeek.data : toShanghaiDateString(new Date());
  const today = toShanghaiDateString(new Date());

  const week = await getWorktimeWeek(user, anchor);

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">每日工时填报</h1>
        <p className="mt-1 text-sm text-gray-500">
          每人每日一条，重复保存会覆盖当天数值、不会报错；未填报的日期，
          看板「每小时有效沟通」将显示 — 而非 0（C03）。
        </p>
      </header>
      <WorktimeWeekForm weekStart={week.weekStart} initialDays={week.days} today={today} />
    </section>
  );
}
