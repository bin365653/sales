// E2E 数据准备（T18）：每次运行重建独立类生产数据库（drop → create →
// migrate deploy → seed）。目标库与账号经环境变量注入（见 playwright.config.ts）。
// 用法：node tests/e2e/prepare-db.cjs（由 Playwright webServer 链调用）
/* eslint-disable @typescript-eslint/no-require-imports -- Node 端 .cjs 准备脚本，CommonJS 有意为之 */
const { spawnSync } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL || "postgresql://qince@127.0.0.1:5432/qince_e2e";
const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e-admin-2026";

function run(cmd, args, env) {
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true,
    cwd: __dirname + "/../..",
    env,
  });
  if (result.status !== 0) {
    console.error(`[e2e-prepare] 命令失败: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
}

(async () => {
  // 数据库名从 URL 末段解析（仅允许字母数字下划线，杜绝注入拼接）
  const dbName = (E2E_DATABASE_URL.split("/").pop() || "").split("?")[0];
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    console.error("[e2e-prepare] E2E_DATABASE_URL 库名不合法: " + dbName);
    process.exit(1);
  }
  const adminUrl = E2E_DATABASE_URL.replace(/\/[A-Za-z0-9_]+(\?|$)/, "/postgres$1");
  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    console.log("[e2e-prepare] 已重建数据库 " + dbName);
  } finally {
    await admin.$disconnect();
  }

  run("npx", ["prisma", "migrate", "deploy"], {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
  });
  run("npx", ["prisma", "db", "seed"], {
    ...process.env,
    DATABASE_URL: E2E_DATABASE_URL,
    ADMIN_USERNAME: "admin",
    ADMIN_NAME: "管理员",
    ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
  });
  console.log("[e2e-prepare] done");
})().catch((error) => {
  console.error("[e2e-prepare] " + (error?.message ?? error));
  process.exit(1);
});
