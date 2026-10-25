import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getExportFile } from "@/server/services/exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 导出下载（T05，实施计划 §6：GET /api/exports/:id/download）。
// 仅创建者本人可下载；不存在/他人/已过期统一 404（不区分暴露存在性）。

/** GET /api/exports/:id/download：流式返回导出文件 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const file = await getExportFile(user, id);
    const asciiName = file.filename.replace(/[^\x20-\x7e]/g, "_");
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${
          encodeURIComponent(file.filename)
        }`,
        // 导出物按需即时生成，代理无需缓存
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
