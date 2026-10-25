import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { importRowsQuerySchema } from "@/lib/schemas/import";
import { getImportPreview } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 预览行（T05，实施计划 §6：GET /api/imports/:id/rows 预览/错误/重复）。
// tab=all/valid/error/dup 分桶互斥（错误 > 重复 > 有效），分页按行号升序。

/** GET /api/imports/:id/rows?tab=&page=&pageSize=：分桶预览 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const query = importRowsQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const preview = await getImportPreview(user, id, query);
    return NextResponse.json(preview);
  } catch (error) {
    return errorResponse(error);
  }
}
