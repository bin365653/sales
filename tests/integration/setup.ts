import "dotenv/config";

// 集成测试前置：需要真实 PostgreSQL（CI 提供 service 容器；
// 本地先 `docker compose up -d postgres` 或便携版 PG，见 README「本地验证数据库」）。
if (!process.env.DATABASE_URL) {
  throw new Error(
    "集成测试需要 DATABASE_URL：请先启动本地 PostgreSQL 并复制 .env.example 为 .env",
  );
}

// T08：模型密钥加密需要主密钥；缺省时注入确定性测试密钥（64 hex = 32 字节）。
// 已配置环境（本机 .env / CI secrets）原样使用，验证真实配置链路。
process.env.APP_ENCRYPTION_KEY ??=
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
