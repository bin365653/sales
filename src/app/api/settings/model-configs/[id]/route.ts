import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { modelConfigUpdateSchema } from "@/lib/schemas/ai";
import { updateModelConfig } from "@/server/ai/model-configs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 模型配置更新（T08）：改 base_url/模型名/超时/重试/激活 = "换 provider 仅改配置"（C05）；
// apiKey 提交即替换重加密，不提交则保持不变；密钥永不回显。

/** PATCH /api/settings/model-configs/:id：更新配置（isActive=true 时单激活互斥） */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const { id } = await params;
    const input = modelConfigUpdateSchema.parse(await request.json());
    const config = await updateModelConfig(user, id, input);
    return NextResponse.json({ config });
  } catch (error) {
    return errorResponse(error);
  }
}
