import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { leadCreateSchema, leadListQuerySchema } from "@/lib/schemas/lead";
import { createLead, listLeads } from "@/server/services/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 线索列表与新建（T03；组合筛选 UI 随 T04 交付）。
// 数据范围由服务层 leadReadScope 强制注入（销售=本人，管理员=全量）。

/** GET /api/leads：关键词搜索 + 组合筛选 + 分页 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const query = leadListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const result = await listLeads(user, query);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/leads：新建线索（owner = 当前用户；阶段缺省 new_lead） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = leadCreateSchema.parse(await request.json());
    const lead = await createLead(user, input);
    return NextResponse.json({ lead }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
