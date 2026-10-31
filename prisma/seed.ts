import "dotenv/config";
import { hash } from "@node-rs/argon2";
import { PrismaClient } from "@prisma/client";
import { PRESET_STAGES } from "../src/lib/stages";
import { BUILTIN_LEAD_FIELDS } from "../src/lib/lead-fields";
import { PROMPT_TEMPLATE_SEEDS } from "../src/server/ai/prompts";

// Algorithm.Argon2id 的值（库的 ambient const enum 在 isolatedModules 下不可引用成员）
const ARGON2ID = 2;

/**
 * 基础数据 seed（T01：阶段 + 管理员；T03：内置字段定义）。
 *
 * 幂等策略：只做"缺则补建"，绝不覆盖已有数据——
 * 容器每次启动都会执行本脚本，管理员此后对阶段的改名/改码/排序/启停、
 * 对字段定义的启停/改名以及对账号的修改必须原样保留（实施计划 K2、M4、M5）。
 */
const prisma = new PrismaClient();

async function seedBuiltinFieldDefs(): Promise<void> {
  let created = 0;
  for (const [index, field] of BUILTIN_LEAD_FIELDS.entries()) {
    const existing = await prisma.leadFieldDef.findUnique({
      where: { key: field.key },
      select: { id: true, label: true },
    });
    if (existing) {
      continue;
    }
    await prisma.leadFieldDef.create({
      data: {
        key: field.key,
        label: field.label,
        type: field.type,
        isBuiltin: true,
        isActive: true,
        sortOrder: index + 1,
      },
    });
    created += 1;
  }
  console.log(
    `[seed] 内置字段定义就绪：共 ${BUILTIN_LEAD_FIELDS.length} 个，本次新建 ${created} 个。`,
  );
}

/**
 * V2.0 内置字段展示名口径更新（仅当标签仍为 V1.0 默认值时同步，
 * 管理员改名过的一律保留——seed 幂等原则「不覆盖已有数据」的边界内）。
 */
const BUILTIN_LABEL_MIGRATIONS: Record<string, { from: string; to: string }> = {
  contract_expiry: { from: "合同/到期时间", to: "软件到期时间" },
};

async function migrateBuiltinFieldLabels(): Promise<void> {
  for (const [key, migration] of Object.entries(BUILTIN_LABEL_MIGRATIONS)) {
    const def = await prisma.leadFieldDef.findUnique({
      where: { key },
      select: { id: true, label: true },
    });
    if (def && def.label === migration.from) {
      await prisma.leadFieldDef.update({
        where: { id: def.id },
        data: { label: migration.to },
      });
      console.log(`[seed] 内置字段展示名同步：${key}「${migration.from}」→「${migration.to}」`);
    }
  }
}

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

/**
 * AI 提示词模板 seed（T08，实施计划 §7.3 交付物）：
 * 每个 run_type 一个模板 + v1 基线版本，源自 src/server/ai/prompts/ 注册表。
 * 幂等：模板缺则建；已有模板绝不改动（版本只增不改，管理员此后新建的版本原样保留）。
 */
async function seedPromptTemplates(): Promise<void> {
  const admin = await prisma.user.findFirst({
    where: { role: "admin" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) {
    console.warn("[seed] 无管理员账号，跳过提示词模板 seed。");
    return;
  }
  let created = 0;
  for (const seedItem of PROMPT_TEMPLATE_SEEDS) {
    const template = await prisma.promptTemplate.findUnique({
      where: { runType: seedItem.runType },
      select: { id: true },
    });
    if (template) {
      continue;
    }
    await prisma.promptTemplate.create({
      data: {
        name: seedItem.name,
        runType: seedItem.runType,
        isActive: true,
        versions: {
          create: {
            version: 1,
            content: seedItem.content,
            outputSchema: seedItem.outputSchema as object,
            createdBy: admin.id,
          },
        },
      },
    });
    created += 1;
  }
  console.log(
    `[seed] AI 提示词模板就绪：共 ${PROMPT_TEMPLATE_SEEDS.length} 类，本次新建 ${created} 个。`,
  );
}

/**
 * 数据字典 seed（V2.0-T02，决策 D1）：current_system 预置新一代手机开单系统
 * （舟谱/爱快消/商圈云，meta.isNextGen=true）+ 常见传统系统占位（isNextGen=false）。
 * 幂等：缺则建；管理员此后的增删改/停用/排序原样保留。
 * 其余 11 个字典字段初始为空，管理员在设置中心维护（实施计划 §3.1）。
 */
const CURRENT_SYSTEM_DICT_SEED: { value: string; isNextGen: boolean }[] = [
  { value: "舟谱", isNextGen: true },
  { value: "爱快消", isNextGen: true },
  { value: "商圈云", isNextGen: true },
  { value: "管家婆", isNextGen: false },
  { value: "金蝶精斗云", isNextGen: false },
  { value: "用友畅捷通", isNextGen: false },
  { value: "秦丝进销存", isNextGen: false },
  { value: "手工台账（Excel/纸质）", isNextGen: false },
];

async function seedCurrentSystemDict(): Promise<void> {
  const admin = await prisma.user.findFirst({
    where: { role: "admin" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!admin) {
    console.warn("[seed] 无管理员账号，跳过数据字典 seed。");
    return;
  }
  let created = 0;
  for (const [index, item] of CURRENT_SYSTEM_DICT_SEED.entries()) {
    const existing = await prisma.dictEntry.findUnique({
      where: { fieldKey_value: { fieldKey: "current_system", value: item.value } },
      select: { id: true },
    });
    if (existing) {
      continue;
    }
    await prisma.dictEntry.create({
      data: {
        fieldKey: "current_system",
        value: item.value,
        meta: { isNextGen: item.isNextGen },
        sortOrder: index + 1,
        createdBy: admin.id,
      },
    });
    created += 1;
  }
  // 字典启用旗标同步（存在 ≥1 启用值即启用，与字典服务同口径）
  const activeCount = await prisma.dictEntry.count({
    where: { fieldKey: "current_system", isActive: true },
  });
  await prisma.leadFieldDef.updateMany({
    where: { key: "current_system" },
    data: { dictEnabled: activeCount > 0 },
  });
  console.log(
    `[seed] current_system 数据字典就绪：共 ${CURRENT_SYSTEM_DICT_SEED.length} 项，本次新建 ${created} 项（dictEnabled=${activeCount > 0}）。`,
  );
}

async function main(): Promise<void> {
  await seedStages();
  await seedBuiltinFieldDefs();
  await migrateBuiltinFieldLabels();
  await seedAdmin();
  await seedPromptTemplates();
  await seedCurrentSystemDict();
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
