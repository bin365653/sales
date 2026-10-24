import { NextRequest, NextResponse } from "next/server";
import { loginSchema } from "@/lib/schemas/auth";
import { login } from "@/server/auth/service";
import { setSessionCookie } from "@/server/auth/session";
import { assertSameOrigin, clientIp, errorResponse } from "@/server/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/login：登录（限流 5 次/15 分钟/IP+账号；§6 认证组） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const body = loginSchema.parse(await request.json());
    const result = await login(body, {
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    const response = NextResponse.json({ user: result.user });
    setSessionCookie(response, result.token, result.expiresAt);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
