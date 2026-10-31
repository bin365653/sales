import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { dictEntryCreateSchema } from "@/lib/schemas/settings";
import {
  createDictEntry,
  listDictEntries,
} from "@/server/services/dicts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 数据字典（V2.0-T02）：GET 开放（表单 DictSelect 渲染需要）；
// POST 仅管理员（改动审计 dict.entry_created）。

/** GET /api/settings/dicts/:fieldKey：字典条目列表（含停用，管理界面用） */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fieldKey: string }> },
) {
  try {
    await requireUser(request);
    const { fieldKey } = await params;
    const result = await listDictEntries(fieldKey);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/settings/dicts/:fieldKey：新增字典值（管理员） */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ fieldKey: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const { fieldKey } = await params;
    const input = dictEntryCreateSchema.parse(await request.json());
    const entry = await createDictEntry(user, fieldKey, input);
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
