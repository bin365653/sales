import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { leadsExportCreateSchema } from "@/lib/schemas/import";
import { createLeadsExport } from "@/server/services/exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 客户列表导出（T05，实施计划 §6：POST /api/exports/leads 按当前筛选）。
// filters 与线索列表同一 Schema → 同一 where 构造器（导出范围正确由代码同源保证）；
// 生成物落 export_files（24h 过期），下载走 GET /api/exports/:id/download。

/** POST /api/exports/leads：按当前筛选生成 XLSX/CSV 导出 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = leadsExportCreateSchema.parse(await request.json());
    const result = await createLeadsExport(user, input);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
