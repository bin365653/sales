import { NextRequest, NextResponse } from "next/server";
import { assertAdmin, isAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { fieldDefCreateSchema } from "@/lib/schemas/settings";
import { createFieldDef, listFieldDefs } from "@/server/services/lead-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 线索字段定义（T03，M4/C12）：查询开放（表单渲染需要启用中的字段；
// 销售只见启用字段，管理员见全量）；写操作仅管理员。

/** GET /api/settings/fields：字段定义列表 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const fields = await listFieldDefs({ activeOnly: !isAdmin(user) });
    return NextResponse.json({ fields });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/settings/fields：新增自定义字段（key/type 此后不可变） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const input = fieldDefCreateSchema.parse(await request.json());
    const field = await createFieldDef(user, input);
    return NextResponse.json({ field }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
