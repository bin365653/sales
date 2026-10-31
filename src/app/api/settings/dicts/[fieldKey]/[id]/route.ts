import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { dictEntryUpdateSchema } from "@/lib/schemas/settings";
import {
  deactivateDictEntry,
  updateDictEntry,
} from "@/server/services/dicts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 字典条目维护（V2.0-T02，仅管理员）：PATCH 改值/标记/排序/启停；
// DELETE = 停用（无物理删除，UIUX §5.3「历史数据不受影响」）。

/** PATCH /api/settings/dicts/:fieldKey/:id：修改字典值（管理员） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ fieldKey: string; id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const { fieldKey, id } = await params;
    const input = dictEntryUpdateSchema.parse(await request.json());
    const entry = await updateDictEntry(user, fieldKey, id, input);
    return NextResponse.json({ entry });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/settings/dicts/:fieldKey/:id：停用字典值（管理员，非物理删除） */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ fieldKey: string; id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const { fieldKey, id } = await params;
    await deactivateDictEntry(user, fieldKey, id);
    return NextResponse.json({ deactivated: true });
  } catch (error) {
    return errorResponse(error);
  }
}
