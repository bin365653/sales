import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { auditLogQuerySchema } from "@/lib/schemas/settings";
import { listAuditLogs } from "@/server/services/audit-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 操作日志查询（T15，UIUX P9）：仅管理员；筛选=动作/操作人/时间范围 + 分页。
// 只读端点（GET），无写副作用；detail 为写入时的结构化 JSON 原样返回
// （写入侧已保证不含密码/密钥等敏感明文）。

/** GET /api/settings/audit-logs?action=&userId=&from=&to=&page= */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const params = request.nextUrl.searchParams;
    const nonEmpty = (key: string): string | undefined => {
      const value = params.get(key)?.trim();
      return value ? value : undefined;
    };
    const query = auditLogQuerySchema.parse({
      ...(nonEmpty("action") !== undefined ? { action: nonEmpty("action") } : {}),
      ...(nonEmpty("userId") !== undefined ? { userId: nonEmpty("userId") } : {}),
      ...(nonEmpty("from") !== undefined ? { from: nonEmpty("from") } : {}),
      ...(nonEmpty("to") !== undefined ? { to: nonEmpty("to") } : {}),
      ...(nonEmpty("page") !== undefined ? { page: nonEmpty("page") } : {}),
    });
    const result = await listAuditLogs(user, query);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
