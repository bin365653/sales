import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { followupPoliciesUpdateSchema } from "@/lib/schemas/settings";
import {
  listFollowUpPolicies,
  updateFollowUpPolicies,
} from "@/server/services/followup-policies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 跟进策略（V2.0-T05，实施计划 §6）：GET/PUT 均仅管理员——策略只服务
// 设置中心配置块与生成引擎，销售侧不读取（任务原因文案由服务端生成）。

/** GET /api/settings/followup-policies：策略列表（象限行 a/b/c/d + 系统行殿后） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    const policies = await listFollowUpPolicies();
    return NextResponse.json({ policies });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PUT /api/settings/followup-policies：批量保存象限策略（[保存全部]）。
 * 系统月度策略行只读（P6）；保存后命中客户取消 pending 周期任务，
 * 新计划由生成引擎按新周期补齐（策略修改只影响之后生成的任务）。
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    const input = followupPoliciesUpdateSchema.parse(await request.json());
    const result = await updateFollowUpPolicies(user, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
