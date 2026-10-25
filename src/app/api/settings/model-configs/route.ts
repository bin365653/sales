import { NextRequest, NextResponse } from "next/server";
import {
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { modelConfigCreateSchema } from "@/lib/schemas/ai";
import {
  createModelConfig,
  listModelConfigs,
} from "@/server/ai/model-configs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 模型配置（T08，实施计划 §6 设置分组 / §8.3）：
// 密钥接口只写不读——列表/详情只含 key_last4 与 hasKey，绝不回显明文（验收项）。
// UI（P9 AI 服务页）随 T15 交付；本任务先交付 API + 测试。

/** GET /api/settings/model-configs：配置列表（无密钥，仅管理员） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const configs = await listModelConfigs(user);
    return NextResponse.json({ configs });
  } catch (error) {
    return errorResponse(error);
  }
}

/** POST /api/settings/model-configs：新增配置（密钥仅此一次提交，AES-256-GCM 落库） */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    const input = modelConfigCreateSchema.parse(await request.json());
    const config = await createModelConfig(user, input);
    return NextResponse.json({ config }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
