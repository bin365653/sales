import { NextRequest, NextResponse } from "next/server";
import { assertAdmin, isAdmin } from "@/server/permissions";
import {
  errorResponse,
  requireUser,
  assertSameOrigin,
} from "@/server/http/api";
import { stageCreateSchema } from "@/lib/schemas/settings";
import { createStage, listStages } from "@/server/services/stages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 阶段配置（T03）：查询对所有登录用户开放（表单需要启用中的阶段，
// 销售只见启用阶段；管理员见全量用于配置页）；写操作仅管理员（K2/C02）。

/** GET /api/settings/stages：阶段列表（销售=启用中；管理员=全部） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const stages = await listStages({ activeOnly: !isAdmin(user) });
    return NextResponse.json({ stages });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/settings/stages：新增自定义阶段（无语义锚点） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const input = stageCreateSchema.parse(await request.json());
    const stage = await createStage(user, input);
    return NextResponse.json({ stage }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
