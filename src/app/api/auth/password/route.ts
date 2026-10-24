import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { changePasswordSchema } from "@/lib/schemas/auth";
import { changePassword } from "@/server/auth/service";
import { assertSameOrigin, clientIp, errorResponse, requireUser } from "@/server/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/auth/password：本人修改密码（§6 认证组）。
 * 校验当前密码后重哈希，并撤销除当前会话外的全部会话。
 * 管理员重置他人密码属账号管理（T15 交付）。
 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const body = changePasswordSchema.parse(await request.json());
    const token = request.cookies.get(SESSION_COOKIE)?.value ?? "";
    await changePassword(token, user, body, { ip: clientIp(request) });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
