import { NextRequest, NextResponse } from "next/server";
import { ApiError, assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { workDateStringSchema, worktimeQuerySchema, worktimeUpsertSchema } from "@/lib/schemas/worktime";
import { getWorktimeEntry, getWorktimeWeek, upsertWorktime } from "@/server/services/worktime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/worktime：每日工时查询（个人数据，恒为当前登录用户）。
 * - ?date=YYYY-MM-DD：单日（实施计划 §6 工时 API 契约）→ { date, hours }；
 * - ?week=YYYY-MM-DD：该日所在周（周一为起点，C13）→ { weekStart, days: [7 天] }。
 * 未填报日期 hours=null（不视为错误——看板该项显示"—"而非 0，C03/K5 验收口径）。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = request.nextUrl.searchParams;
    const query = worktimeQuerySchema.parse({
      date: params.get("date") ?? undefined,
      week: params.get("week") ?? undefined,
    });
    const result =
      query.date !== undefined
        ? await getWorktimeEntry(user, query.date)
        : await getWorktimeWeek(user, query.week as string);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PUT /api/worktime?date=YYYY-MM-DD，body { hours }：录入/修改当天工时。
 * upsert 覆盖（每人每日一条）——重复提交覆盖不报错（T11 验收项）；
 * hours 0–24、0.5 步进（UIUX §4.9），范围/步进以后端为唯一事实源。
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const rawDate = request.nextUrl.searchParams.get("date");
    if (rawDate === null) {
      throw new ApiError(400, "validation_error", "缺少 date 查询参数");
    }
    const date = workDateStringSchema.parse(rawDate);
    const input = worktimeUpsertSchema.parse(await request.json());
    const entry = await upsertWorktime(user, date, input.hours);
    return NextResponse.json(entry);
  } catch (error) {
    return errorResponse(error);
  }
}
