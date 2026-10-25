import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/server/permissions";
import { errorResponse, requireUser } from "@/server/http/api";
import { prisma } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 提示词模板（T08 建表 + 只读 API；版本管理 UI/写端点随 T15 交付）。
// 版本只增不改（不可变、可追溯）：ai_runs.prompt_version_id 记录具体版本，历史可复现。

/** GET /api/settings/prompts：模板 + 版本列表（含内容与输出 Schema，仅管理员） */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    const templates = await prisma.promptTemplate.findMany({
      orderBy: { runType: "asc" },
      include: {
        versions: {
          orderBy: { version: "desc" },
          select: {
            id: true,
            version: true,
            content: true,
            outputSchema: true,
            createdBy: true,
            createdAt: true,
          },
        },
      },
    });
    return NextResponse.json({ templates });
  } catch (error) {
    return errorResponse(error);
  }
}
