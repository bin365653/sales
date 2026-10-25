import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { interactionUpdateSchema } from "@/lib/schemas/interaction";
import { updateInteraction } from "@/server/services/interactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/interactions/:id：修正沟通记录（M11）。
 * - 不提供删除（M1）；修正不改写历史值，edit_audit 追加修改审计
 *   （谁、何时、改了什么——from/to）；
 * - K4 阶段联动同样适用于修正后记录的最终勾选状态（只进不退）；
 * - 权限经线索归属判定：销售仅本人客户的记录，管理员全量，越权 404。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = interactionUpdateSchema.parse(await request.json());
    const result = await updateInteraction(user, id, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
