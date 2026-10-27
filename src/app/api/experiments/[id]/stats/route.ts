import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getExperimentStats } from "@/server/services/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/experiments/:id/stats：实验效果对比（实施计划 §6 实验端点，
 * PRD §5.10 四要素：样本量/比例/绝对差异/统计周期）。
 * 所有登录用户可读；统计周期 = 分组日 → 关闭日/今日；
 * 尚未执行分组 409 experiment_not_assigned；
 * 样本量 < 阈值 → 对比行带 insufficient 标志（前端渲染黄色横幅，不给结论）。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser(request);
    const { id } = await params;
    const stats = await getExperimentStats(id);
    return NextResponse.json(stats);
  } catch (error) {
    return errorResponse(error);
  }
}
