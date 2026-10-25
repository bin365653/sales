import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { taskCreateSchema, taskListQuerySchema } from "@/lib/schemas/task";
import { createTask, listTasks } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tasks：任务中心列表（今日/逾期/全部）。
 * 今日 = 待处理且截止日早于明日 00:00（上海日界，含逾期置顶）；
 * 逾期 = 待处理且截止日早于今日 00:00（跨日才算逾期，验收口径）。
 * 可见性经线索归属判定（销售仅本人客户的任务，管理员全量）。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = request.nextUrl.searchParams;
    const query = taskListQuerySchema.parse({
      view: params.get("view") ?? undefined,
      status: params.get("status") ?? undefined,
      page: params.get("page") ?? undefined,
      pageSize: params.get("pageSize") ?? undefined,
    });
    const result = await listTasks(user, query);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/tasks：新建任务（必须关联客户；assignee = 线索负责人快照）。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = taskCreateSchema.parse(await request.json());
    const task = await createTask(user, input);
    return NextResponse.json({ task }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
