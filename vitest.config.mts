import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 单元测试：不依赖数据库，保持秒级反馈。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
