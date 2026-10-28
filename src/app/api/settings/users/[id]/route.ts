import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { userStatusUpdateSchema } from "@/lib/schemas/settings";
import { setUserStatus } from "@/server/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 账号状态（T15，UIUX P9）：仅停用/启用（无删除、无姓名角色编辑）。
// 停用立即撤销全部会话（UIUX §4.8"该账号会话将立即失效"）；
// 不能操作自己；停用兜底"至少保留一个启用中的管理员"。

/** PATCH /api/settings/users/:id：停用/启用账号（仅管理员） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const actor = await requireUser(request);
    const { id } = await params;
    const input = userStatusUpdateSchema.parse(await request.json());
    const user = await setUserStatus(actor, id, input);
    return NextResponse.json({ user });
  } catch (error) {
    return errorResponse(error);
  }
}
