import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { fieldDefUpdateSchema } from "@/lib/schemas/settings";
import { updateFieldDef } from "@/server/services/lead-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** PATCH /api/settings/fields/:id：改展示名/选项/校验/排序/启停（key/type 不可改，仅管理员） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const { id } = await params;
    const input = fieldDefUpdateSchema.parse(await request.json());
    const field = await updateFieldDef(user, id, input);
    return NextResponse.json({ field });
  } catch (error) {
    return errorResponse(error);
  }
}
