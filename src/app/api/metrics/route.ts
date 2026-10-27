import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getAnalyticsDashboard } from "@/server/metrics/analytics";
import { analyticsQuerySchema } from "@/lib/schemas/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/metrics：销售数据看板（实施计划 §6 看板端点，含筛选）。
 * 入参 = analyticsQuerySchema（period=今日/本周/本月/自定义 + from/to、
 * 来源/行业/阶段/负责人圈选，非法入参 400 validation_error）；
 * 指标一律来自 computeMetricsSnapshot（server/metrics 唯一口径），
 * 与 /analytics 页 SSR 共用 getAnalyticsDashboard。
 * 数据范围经 permissions 层（销售=本人，管理员=全量 + 按负责人筛选）。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const query = analyticsQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const dashboard = await getAnalyticsDashboard(user, query);
    return NextResponse.json(dashboard);
  } catch (error) {
    return errorResponse(error);
  }
}
