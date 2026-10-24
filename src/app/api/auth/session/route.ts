import { NextRequest, NextResponse } from "next/server";
import { requireUser, errorResponse } from "@/server/http/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/session：返回当前用户；无有效会话 401（前端用它判定会话状态） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    return NextResponse.json({ user });
  } catch (error) {
    return errorResponse(error);
  }
}
