import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { logout } from "@/server/auth/service";
import { clearSessionCookie, resolveSession } from "@/server/auth/session";
import { assertSameOrigin, clientIp, errorResponse } from "@/server/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout：登出（撤销会话 + 清 Cookie；对未登录调用幂等） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    // 仅用于审计归属；会话无效时照常清理 Cookie
    let userIdForAudit: string | undefined;
    try {
      userIdForAudit = (await resolveSession(token))?.id;
    } catch {
      // 审计归属识别失败不阻断登出
    }
    await logout(token, { ip: clientIp(request) }, userIdForAudit);
    const response = NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
