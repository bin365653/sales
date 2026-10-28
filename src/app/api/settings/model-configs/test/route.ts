import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { modelConnectionTestSchema } from "@/lib/schemas/ai";
import { testModelConnection } from "@/server/ai/model-configs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 测试连接（T15，UIUX P9 AI 服务页）：发起最小请求回显成功/失败原因。
// 支持两种形态：{configId}（测试已保存配置）或
// {baseUrl, modelName, apiKey}（测试表单新值）；失败原因按五分类映射，
// 绝不回显密钥。测试不写审计、不改任何数据。

/** POST /api/settings/model-configs/test：连通性测试（仅管理员） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = modelConnectionTestSchema.parse(await request.json());
    const result = await testModelConnection(user, input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
