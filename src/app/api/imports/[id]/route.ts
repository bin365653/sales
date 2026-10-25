import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { importMappingSchema } from "@/lib/schemas/import";
import { saveImportMapping } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 保存字段映射（T05，实施计划 §6：PATCH /api/imports/:id 保存映射）。
// 保存即对全部行重跑归一化/校验/重复检测（预览数据随之刷新）。

/** PATCH /api/imports/:id：保存映射并重算预览 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = importMappingSchema.parse(await request.json());
    const counts = await saveImportMapping(user, id, input);
    return NextResponse.json({ counts });
  } catch (error) {
    return errorResponse(error);
  }
}
