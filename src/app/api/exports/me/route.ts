import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { createMyDataExport } from "@/server/services/exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 个人全量数据导出（T05，实施计划 §6：POST /api/exports/me）。
// 恒为本人名下全部客户（与管理员身份无关，§5.11 个人数据管理）；
// ZIP 内含客户 XLSX+CSV，沟通/任务/AI 记录随 T06/T07/T08 落表后并入。

/** POST /api/exports/me：生成个人全量数据 ZIP */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const result = await createMyDataExport(user);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
