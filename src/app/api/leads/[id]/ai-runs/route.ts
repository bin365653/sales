import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { listLeadAiRuns } from "@/server/ai/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 历史（T08，实施计划 §6 AI 分组 / UIUX §4.7 历史区：点击展开只读查看）。

/** GET /api/leads/:id/ai-runs：该客户的 AI 调用历史（倒序，越权一律 404） */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const runs = await listLeadAiRuns(user, id);
    return NextResponse.json({ runs });
  } catch (error) {
    return errorResponse(error);
  }
}
