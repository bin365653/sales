import { NextRequest, NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/server/http/api";
import { getWorkbenchSummary } from "@/server/metrics/engine";
import { runTaskGenerationLazy } from "@/server/services/task-generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/summary：工作台汇总（实施计划 §6 看板端点）。
 * 今日三卡（待联系/今日任务/逾期任务）+ 本周概览（呼出/有效/合格/预约与比率）+
 * 建议优先联系（规则引擎，附理由）+ 最近沟通记录。
 * 与工作台首页 SSR 共用 getWorkbenchSummary 同一实现；数据范围经
 * permissions 层（销售=本人，管理员=全量汇总，K1/P2 权限口径）。
 * V2.0-T06：处理前对当前用户范围惰性执行任务生成（决策 D3）。
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    await runTaskGenerationLazy(user);
    const summary = await getWorkbenchSummary(user);
    return NextResponse.json(summary);
  } catch (error) {
    return errorResponse(error);
  }
}
