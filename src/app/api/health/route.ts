import { NextResponse } from "next/server";
import { prisma } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 容器/负载均衡探活端点（T01 验收：/api/health 返回 200）。
 * 数据库不可达时返回 503，供编排层判定实例不健康。
 */
export async function GET() {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      status: "ok",
      checks: { db: "up" },
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "[health] 数据库不可达：",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      {
        status: "error",
        checks: { db: "down" },
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
