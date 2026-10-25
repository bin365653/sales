import { NextRequest, NextResponse } from "next/server";
import { ApiError, assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { uploadImport } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 导入上传（T05，实施计划 §6：POST /api/imports 上传解析）。
// multipart 表单字段 file：.xlsx/.csv、≤10MB、≤5000 行（M8，解析层统一校验）。
// 上传即完成自动映射猜测 + 预览计算，但不写任何正式业务表（两阶段语义）。

/** POST /api/imports：上传并解析文件，返回批次与自动映射结果 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "invalid_request", "请选择要上传的文件（字段名 file）");
    }
    const result = await uploadImport(user, {
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
