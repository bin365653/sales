import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 集成测试（T02 越权/会话框架）：需要真实 PostgreSQL。
// 运行前置：本地 `docker compose up -d postgres` 或便携版 PG（见 README「本地验证数据库」），
// 或由 CI 提供 DATABASE_URL。串行执行避免共享库内相互干扰。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
