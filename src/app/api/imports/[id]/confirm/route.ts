import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, errorResponse, requireUser } from "@/server/http/api";
import { importConfirmSchema } from "@/lib/schemas/import";
import { confirmImport } from "@/server/services/imports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 确认导入（T05，实施计划 §6：POST /api/imports/:id/confirm）。
// 确认才写 leads（两阶段第二阶段）；整体事务，写 imported 事件与审计；
// decisions 可逐行覆盖（skip/create_new），错误行固定跳过，重复行默认跳过可仍新建。

/** POST /api/imports/:id/confirm：按决策入库 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const raw = await request.json().catch(() => ({}));
    const input = importConfirmSchema.parse(raw);
    const result = await confirmImport(user, id, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
