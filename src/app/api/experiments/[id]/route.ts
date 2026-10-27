import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { experimentUpdateSchema } from "@/lib/schemas/experiment";
import {
  getExperimentDetailView,
  updateExperiment,
} from "@/server/services/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/experiments/:id：实验详情。所有登录用户可读；
 * 两组名单（assignments）仅管理员返回（销售只读查看结果=对比数据）。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const detail = await getExperimentDetailView(user, id);
    return NextResponse.json(detail);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PATCH /api/experiments/:id：编辑草稿配置或关闭实验（status=closed，
 * 禁止与其他字段混提——Schema 层拒绝）。仅管理员；
 * 分组执行后配置固定不可修改（409 experiment_locked，C04）；
 * 已关闭实验不可再修改（409 experiment_closed）。
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = experimentUpdateSchema.parse(await request.json());
    const experiment = await updateExperiment(user, id, input);
    return NextResponse.json({ experiment });
  } catch (error) {
    return errorResponse(error);
  }
}
