import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import {
  assignExperiment,
  previewAssignment,
} from "@/server/services/experiments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/experiments/:id/assign：执行随机分组（实施计划 §6 实验端点）。
 * 仅管理员；仅草稿可执行（409 experiment_not_draft）；
 * 圈选排除已分组线索（同一线索不可重复分组——全局唯一约束兜底，并发冲突 409）；
 * 随机 = Fisher-Yates 洗牌 + 按 AI 辅助组占比切分（n≥2 两侧各至少 1 条）；
 * 分组结果固定不可改（C04）：执行后实验 draft→running，配置冻结。
 * 强确认文案由前端承担（M3），服务端直接执行。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const result = await assignExperiment(user, id);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/experiments/:id/assign：执行前预览（UIUX P8：
 * "按当前条件圈选出 N 条线索，将随机分为常规组 A 条 / AI 辅助组 B 条"）。
 * 仅管理员；仅草稿可预览。alreadyGrouped = 圈选范围内已被其他实验占用的线索数。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const preview = await previewAssignment(user, id);
    return NextResponse.json(preview);
  } catch (error) {
    return errorResponse(error);
  }
}
