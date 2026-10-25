import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getImportTemplateFields } from "@/server/services/imports";
import { buildImportTemplateCsv, buildImportTemplateXlsx } from "@/lib/import/template";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 导入模板下载（T05，实施计划 §6：GET /api/imports/template）。
// 动态生成：始终包含当前启用中的自定义字段列（静态 templates/ 文件只覆盖内置字段）。

/** GET /api/imports/template?format=xlsx|csv：生成导入模板文件 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const isCsv = request.nextUrl.searchParams.get("format") === "csv";
    const format = isCsv ? "csv" : "xlsx";
    const fields = await getImportTemplateFields();
    const body = isCsv
      ? Buffer.from(buildImportTemplateCsv(fields), "utf8")
      : await buildImportTemplateXlsx(fields);
    const contentType = isCsv
      ? "text/csv; charset=utf-8"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return new NextResponse(new Uint8Array(body), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="import-template.${format}"; filename*=UTF-8''${
          encodeURIComponent(`客户导入模板.${format}`)
        }`,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
