import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { leadStageTransitionSchema } from "@/lib/schemas/lead";
import { transitionStage } from "@/server/services/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/leads/:id/stage：阶段流转（§6 线索组单一入口）。
 * 服务端校验目标阶段存在且启用（停用阶段不可选为新流转目标，T03 验收项），
 * 写 lead_events（前后阶段 UUID + 当时编码/名称快照，PRD §5.8）。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = leadStageTransitionSchema.parse(await request.json());
    const result = await transitionStage(user, id, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
