import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { experimentCreateSchema } from "@/lib/schemas/experiment";
import {
  createExperiment,
  listExperiments,
} from "@/server/services/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/experiments：实验列表（实施计划 §6 实验端点）。
 * 所有登录用户可读（UIUX 权限矩阵：销售只读查看结果）；
 * 行含两组样本量与状态（草稿/进行中/已关闭）。
 */
export async function GET(request: NextRequest) {
  try {
    await requireUser(request);
    const experiments = await listExperiments();
    return NextResponse.json({ experiments });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/experiments：创建实验（保存为草稿，UIUX P8）。
 * 仅管理员（403 forbidden）；入参 = experimentCreateSchema
 * （名称 + 圈选条件 + 分组比例 10–90 默认 50 + 最小样本阈值默认 50）。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = experimentCreateSchema.parse(await request.json());
    const experiment = await createExperiment(user, input);
    return NextResponse.json({ experiment }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
