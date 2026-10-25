import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { listLeadAiRuns } from "@/server/ai/runner";
import { getTodayUsage } from "@/server/ai/rate-limit";
import { resolveActivePromptVersion } from "@/server/ai/prompt-registry";
import { RUN_TYPES, type RunTypeValue } from "@/lib/schemas/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// AI 历史（T08 起交付，T09 扩展，实施计划 §6 AI 分组 / UIUX §4.7 历史区）。
// T09 面板一次请求取齐：runs（含模型名/提示词版本号）+ 当日用量 + 各 run 类型
// 当前启用提示词版本号（历史区顶部展示）；提示词缺失只降级为 null，不影响历史可读。

/** GET /api/leads/:id/ai-runs：该客户的 AI 调用历史（倒序，越权一律 404） */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const runs = await listLeadAiRuns(user, id);
    const [usage, activePromptVersions] = await Promise.all([
      getTodayUsage(user.id),
      Promise.all(
        RUN_TYPES.map(async (runType) => {
          try {
            return [
              runType,
              (await resolveActivePromptVersion(runType)).version,
            ] as const;
          } catch {
            return [runType, null] as const;
          }
        }),
      ).then((entries) =>
        Object.fromEntries(entries) as Record<RunTypeValue, number | null>,
      ),
    ]);
    return NextResponse.json({ runs, usage, activePromptVersions });
  } catch (error) {
    return errorResponse(error);
  }
}
