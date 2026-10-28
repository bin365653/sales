import { defineConfig } from "@playwright/test";

// 端到端核心闭环（T18，实施计划 §9 T18）：登录→导入→详情→AI→记录→任务→看板。
// 类生产环境：独立数据库（每次重建）+ 生产构建 next start + 本地 Mock AI Provider。
// 前置：PostgreSQL 16 已启动（同单元/集成测试）；Chromium 由 `npx playwright
// install chromium` 安装；应用构建需先 `npm run build`。

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://qince@127.0.0.1:5432/qince_e2e";
const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "e2e-admin-2026";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/e2e/mock-ai-server.cjs",
      url: "http://127.0.0.1:4599/healthz",
      timeout: 30_000,
      reuseExistingServer: true,
    },
    {
      command: "node tests/e2e/prepare-db.cjs && npx next start -p 3100",
      url: `${E2E_BASE_URL}/api/health`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        E2E_ADMIN_PASSWORD: E2E_ADMIN_PASSWORD,
        NODE_ENV: "production",
      },
    },
  ],
});
