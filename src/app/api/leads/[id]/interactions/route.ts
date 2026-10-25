import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { interactionCreateSchema } from "@/lib/schemas/interaction";
import {
  createInteraction,
  listInteractions,
} from "@/server/services/interactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/leads/:id/interactions：沟通记录列表（最新在前）。
 * 可见性经线索归属判定（销售仅本人，管理员全量，越权 404）。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const items = await listInteractions(user, id);
    return NextResponse.json({ items });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/leads/:id/interactions：保存沟通记录（单事务，实施计划 §6）：
 * 记录 + 刷新 last_contact_at + （可选）next_contact_at + "本次确认"核实状态 +
 * 条件推进阶段（K4，勾选合格/预约且当前阶段更早时自动流转并写 stage_changed 事件）。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = interactionCreateSchema.parse(await request.json());
    const result = await createInteraction(user, id, input);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
