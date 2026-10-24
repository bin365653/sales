import "dotenv/config";
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import { PRESET_STAGES } from "../src/lib/stages";

// Algorithm.Argon2id 的值（库的 ambient const enum 在 isolatedModules 下不可引用成员）
const ARGON2ID = 2;

/**
 * 基础数据 seed（T01）：13 个预置阶段 + 初始管理员账号。
 *
 * 幂等策略：只做"缺则补建"，绝不覆盖已有数据——
 * 容器每次启动都会执行本脚本，管理员此后对阶段的改名/改码/排序/启停
 * 与对账号的修改必须原样保留（实施计划 K2、M5）。
 */
const prisma = new PrismaClient();

async function seedStages(): Promise<void> {
  let created = 0;
  for (const stage of PRESET_STAGES) {
    const existing = await prisma.leadStage.findUnique({
      where: { semanticKey: stage.semanticKey },
      select: { id: true, code: true, name: true },
    });
    if (existing) {
      continue;
    }
    try {
      await prisma.leadStage.create({
        data: {
          semanticKey: stage.semanticKey,
          code: stage.code,
          name: stage.name,
          sortOrder: stage.sortOrder,
          isActive: true,
        },
      });
      created += 1;
    } catch (error) {
      // 编码与预置阶段撞名（管理员此前建过同 code 的自定义阶段）时不阻断启动，
      // 记录告警，人工在阶段配置里处理。
      console.warn(
        `[seed] 预置阶段创建跳过（code 冲突？）: ${stage.code} / ${stage.name}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  console.log(
    `[seed] 预置阶段就绪：共 ${PRESET_STAGES.length} 个，本次新建 ${created} 个。`,
  );
}

async function seedAdmin(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim() || "admin";
  const password = process.env.ADMIN_PASSWORD;

  const existing = await prisma.user.findUnique({
    where: { username },
    select: { id: true },
  });
  if (existing) {
    console.log(`[seed] 管理员账号已存在，跳过：${username}`);
    return;
  }

  if (!password || password.length < 8) {
    throw new Error(
      "[seed] 缺少初始管理员密码：请设置环境变量 ADMIN_PASSWORD（至少 8 位）。",
    );
  }

  const passwordHash = await hash(password, { algorithm: ARGON2ID });
  await prisma.user.create({
    data: {
      username,
      passwordHash,
      name: process.env.ADMIN_NAME?.trim() || "管理员",
      role: "admin",
      status: "active",
    },
  });
  console.log(`[seed] 初始管理员已创建：${username}（Argon2id）`);
}

async function main(): Promise<void> {
  await seedStages();
  await seedAdmin();
}

main()
  .catch((error) => {
    console.error("[seed] 执行失败：", error);
    process.exitCode = 1;
    throw error;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
