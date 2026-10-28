import { redirect } from "next/navigation";

// T11 临时入口 → T15 起并入设置中心（/settings?tab=worktime）。
// 保留本路由仅作旧链接重定向；WorktimeWeekForm 组件在设置中心直接复用。

export const dynamic = "force-dynamic";

export default function WorktimePage() {
  redirect("/settings?tab=worktime");
}
