import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { leadUpdateSchema } from "@/lib/schemas/lead";
import { getLeadDetail, softDeleteLead, updateLead } from "@/server/services/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/leads/:id：详情（画像 + 阶段 + 事件时间线；T04 详情页消费） */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const detail = await getLeadDetail(user, id);
    return NextResponse.json(detail);
  } catch (error) {
    return errorResponse(error);
  }
}

/** PATCH /api/leads/:id：局部编辑（需 dataVersion；阶段变更走 /stage 端点） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = leadUpdateSchema.parse(await request.json());
    const lead = await updateLead(user, id, input);
    return NextResponse.json({ lead });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/leads/:id：软删除（M1/C11：历史表保留，不级联清除） */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    await softDeleteLead(user, id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
