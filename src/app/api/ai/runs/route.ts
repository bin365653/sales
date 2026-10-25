import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { aiRunCreateSchema } from "@/lib/schemas/ai";
import { createAiRun } from "@/server/ai/runner";
import { getTodayUsage } from "@/server/ai/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 发起（T08，实施计划 §6 AI 分组 / §7.2 执行模型）：
// 创建 ai_runs(pending) 立即返回 run_id，后端异步执行，前端轮询。
// 常规组拦截（guard①）随 T14 实验分组交付；频控在本服务层强制（429）。

/** POST /api/ai/runs：发起 AI 调用（lead_id + run_type） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = aiRunCreateSchema.parse(await request.json());
    const run = await createAiRun(user, input);
    const usage = await getTodayUsage(user.id);
    return NextResponse.json({ run, usage }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
