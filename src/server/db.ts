import { PrismaClient } from "@prisma/client";

// Prisma client 全局单例：避免开发模式热重载反复实例化导致连接耗尽。
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
