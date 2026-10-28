import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { promptVersionCreateSchema } from "@/lib/schemas/settings";
import { createPromptVersion } from "@/server/services/prompts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 提示词新版本（T15，UIUX P9）：版本只增不改、保存即生效
// （T08 Registry：version 最高者启用）；前端提交前强确认
// "启用后所有新的 AI 调用将使用该版本"（UIUX §4.8）。
// 不提供修改/删除端点——版本不可变是验收项，回滚=再建新版本。

/** POST /api/settings/prompts/:templateId/versions：新建版本（仅管理员） */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = promptVersionCreateSchema.parse(await request.json());
    const version = await createPromptVersion(user, id, input);
    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
