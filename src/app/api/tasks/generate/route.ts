import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { assertAdmin } from "@/server/permissions";
import {
  ApiError,
  assertSameOrigin,
  errorResponse,
  requireUser,
} from "@/server/http/api";
import { prisma } from "@/server/db";
import { describeError } from "@/server/http/redact";
import { runTaskGeneration } from "@/server/services/task-generation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tasks/generate：管理员手动全量生成（V2.0-T06，决策 D3 手动兜底，
 * 也是失败重试入口）。幂等：重复执行不会产生重复任务（有效行部分唯一索引 +
 * 冲突捕获）；返回生成/跳过统计。失败写审计并返回中文文案（UIUX §7.3）。
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser(request);
    assertAdmin(user);
    try {
      const stats = await runTaskGeneration({
        actorId: user.id,
        trigger: "manual",
      });
      await prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "task_generation_manual",
          objectType: "task_generation",
          detail: {
            createdTasks: stats.createdTasks,
            skippedTasks: stats.skippedTasks,
            bySource: stats.bySource,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return NextResponse.json(stats);
    } catch (generationError) {
      await prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "task_generation_failed",
            objectType: "task_generation",
            detail: {
              trigger: "manual",
              error: describeError(generationError),
            } as unknown as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      throw new ApiError(
        500,
        "task_generation_failed",
        "任务生成遇到问题，已记录日志；可稍后重试，重复执行不会产生重复任务",
      );
    }
  } catch (error) {
    return errorResponse(error);
  }
}
