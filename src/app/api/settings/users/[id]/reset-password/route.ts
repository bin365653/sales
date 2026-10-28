import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { resetUserPassword } from "@/server/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 管理员重置他人密码（T15，UIUX P9）：生成新初始密码（响应一次性返回）
// 并撤销该账号全部会话；本人改密走 PATCH /api/auth/password（需旧密码），
// 此处对自己操作 400 user_self_action 拒绝。

/** POST /api/settings/users/:id/reset-password：重置密码（仅管理员） */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireUser(request);
    const { id } = await params;
    const result = await resetUserPassword(actor, id);
    return NextResponse.json({ user: result });
  } catch (error) {
    return errorResponse(error);
  }
}
