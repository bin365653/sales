import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { taskUpdateSchema } from "@/lib/schemas/task";
import { updateTask } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/tasks/:id：编辑待处理任务（标题/类型/截止时间/备注）或取消
 * （status=canceled，禁止与其他字段混提；C11 任务只可取消不可删）。
 * 已完成/已取消的任务 400 拒绝；完成必须走 complete-with-interaction。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = taskUpdateSchema.parse(await request.json());
    const task = await updateTask(user, id, input);
    return NextResponse.json({ task });
  } catch (error) {
    return errorResponse(error);
  }
}
