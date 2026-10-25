import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { leadBatchUpdateSchema } from "@/lib/schemas/lead";
import { batchUpdateLeads } from "@/server/services/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 批量修改（T04，实施计划 §6「PATCH /api/leads/batch 限定可批量字段」）。
// 静态段 batch 优先于 [id] 动态段，不会与单条端点冲突。
// 白名单（priority/stageId/source/nextContactAt）由 Schema 强制，
// 未知字段直接 400（不静默忽略）；混入他人线索整体拒绝（服务层 404）。

/** PATCH /api/leads/batch：批量修改白名单字段 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = leadBatchUpdateSchema.parse(await request.json());
    const result = await batchUpdateLeads(user, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
