import { NextRequest, NextResponse } from "next/server";
import { ApiError, assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { IMPORT_MAX_FILE_BYTES } from "@/lib/import/parse";
import { uploadImport } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 导入上传（T05，实施计划 §6：POST /api/imports 上传解析）。
// multipart 表单字段 file：.xlsx/.csv、≤10MB、≤5000 行（M8，解析层统一校验）。
// 上传即完成自动映射猜测 + 预览计算，但不写任何正式业务表（两阶段语义）。
// T16 加固：解析前按 Content-Length 预检——超大请求体在缓冲前直接拒绝
// （multipart 总长略大于文件本身，放宽 64KB 表单开销；精确上限仍由
// 解析层按真实字节判定），避免无界请求体占用内存。

/** Content-Length 预检放宽量：multipart 表单结构与边界的开销余量 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** POST /api/imports：上传并解析文件，返回批次与自动映射结果 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    const nearLimit = (value: number): boolean =>
      Number.isFinite(value) && value >= IMPORT_MAX_FILE_BYTES - MULTIPART_OVERHEAD_BYTES;
    if (nearLimit(declaredLength)) {
      // 预检（快路径）：接近/超过 10MB 的请求体在缓冲前直接拒绝。
      // 阈值取"上限减 multipart 开销"——Next.js 对经过 middleware 的请求体
      // 有 10MB 硬截断，超出后 formData 必然解析失败，早拒可获得确定性 400。
      throw new ApiError(400, "file_too_large", "文件不能超过 10MB");
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      // 请求体被截断/损坏导致 FormData 解析失败：接近上限按超大文件拒绝，
      // 否则按无效请求处理（不向上泄漏 500）
      if (nearLimit(declaredLength)) {
        throw new ApiError(400, "file_too_large", "文件不能超过 10MB");
      }
      throw new ApiError(400, "invalid_request", "上传解析失败，请重新选择文件");
    }
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
