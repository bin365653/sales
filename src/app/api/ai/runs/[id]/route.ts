import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getAiRun } from "@/server/ai/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 轮询（T08，实施计划 §6 AI 分组 / §7.2：前端 2s 轮询，可离开页面）。
// 响应不含模型配置密钥相关字段（run 里本就无密钥列）。

/** GET /api/ai/runs/:id：查询单次 AI 调用状态与输出（越权一律 404） */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const run = await getAiRun(user, id);
    return NextResponse.json({ run });
  } catch (error) {
    return errorResponse(error);
  }
}
