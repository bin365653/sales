import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { taskCompleteSchema } from "@/lib/schemas/task";
import { completeTaskWithInteraction } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/:id/complete-with-interaction：完成任务弹窗（UIUX P6，单事务）：
 * 任务标记 done（记 completed_at）+ 沟通记录（last_contact_at / 本次确认 /
 * K4 阶段联动）+ 可选下一任务——任一步失败整体回滚。
 * 完成必须留下沟通记录：任务行回填 interaction_id，不提供"静默完成"。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = taskCompleteSchema.parse(await request.json());
    const result = await completeTaskWithInteraction(user, id, input);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
