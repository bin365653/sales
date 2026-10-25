import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { stageUpdateSchema } from "@/lib/schemas/settings";
import { updateStage } from "@/server/services/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/settings/stages/:id：改名 / 改码 / 排序 / 启停（仅管理员；semanticKey 不可改） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const { id } = await params;
    const input = stageUpdateSchema.parse(await request.json());
    const stage = await updateStage(user, id, input);
    return NextResponse.json({ stage });
  } catch (error) {
    return errorResponse(error);
  }
}
