import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { userCreateSchema } from "@/lib/schemas/settings";
import { createUser, listUsers } from "@/server/services/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 账号管理（T15，UIUX P9）：管理员建号——不开放自助注册（M5）。
// 初始密码服务端生成，仅在 POST 响应中一次性返回（前端弹窗展示+复制，
// 关闭后不再显示）；审计只记用户名/角色，绝不明文记录密码。

/** GET /api/settings/users：用户列表（仅管理员） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const users = await listUsers(user);
    return NextResponse.json({ users });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/settings/users：新建账号（返回一次性初始密码） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = userCreateSchema.parse(await request.json());
    const created = await createUser(user, input);
    return NextResponse.json({ user: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
