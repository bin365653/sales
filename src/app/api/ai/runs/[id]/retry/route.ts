import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { retryAiRun } from "@/server/ai/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 重试（T08，实施计划 §6 AI 分组 / §7.2"重新生成=新 run，历史保留"）：
// 仅 failed/timeout/invalid_output 可重试；新 run 记 retry_of_id。

/** POST /api/ai/runs/:id/retry：重试一次 AI 调用（新 run） */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const run = await retryAiRun(user, id);
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
