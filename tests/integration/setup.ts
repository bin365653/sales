import "dotenv/config";

// 集成测试前置：需要真实 PostgreSQL（CI 提供 service 容器；
// 本地先 `docker compose up -d postgres` 或便携版 PG，见 README「本地验证数据库」）。
if (!process.env.DATABASE_URL) {
  throw new Error(
    "集成测试需要 DATABASE_URL：请先启动本地 PostgreSQL 并复制 .env.example 为 .env",
  );
}
