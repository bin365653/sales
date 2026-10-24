# 勤策 AI 销售作战台 V1.0

轻量级 AI 销售工作台。技术栈与工程决策见《V1.0工程实施计划-Z.md》。

## 技术栈

Next.js 15（App Router，TypeScript 严格模式）· PostgreSQL 16 · Prisma · Tailwind CSS 4 · Vitest · Docker Compose

## 快速开始

### 方式一：Docker 一键启动（演示 / 验收）

```bash
docker compose up -d --build
# 打开 http://localhost:3000（健康检查：http://localhost:3000/api/health）
```

容器启动时自动执行 `prisma migrate deploy`（幂等）与基础数据 seed
（13 个预置阶段 + 初始管理员，缺则补建、不覆盖既有配置）。

生产部署前务必复制 `.env.example` 为 `.env` 并覆盖全部默认口令。

### 方式二：本地开发

```bash
docker compose up -d postgres   # 只启动 PostgreSQL
cp .env.example .env            # 修改 DATABASE_URL 与 ADMIN_PASSWORD
npm install
npx prisma migrate deploy       # 或 npm run db:migrate（开发模式建迁移）
npm run db:seed
npm run dev                     # http://localhost:3000
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发服务器 |
| `npm run build` / `npm run start` | 生产构建 / 启动 |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript 检查 |
| `npm run test` | Vitest 单元测试 |
| `npm run db:migrate` | 创建并应用开发迁移（prisma migrate dev） |
| `npm run db:deploy` | 应用已版本化的迁移（部署用，幂等） |
| `npm run db:seed` | 基础数据 seed（幂等） |

## 目录结构

与《V1.0工程实施计划-Z》§3 一致：

- `prisma/` —— schema、版本化迁移、seed
- `src/app/` —— 页面与 Route Handler（HTTP 层，薄）
- `src/server/` —— 业务服务、权限、指标引擎、AI 适配层
- `src/lib/` —— 前后端共享常量与工具（阶段语义锚点等）
- `tests/` —— 单元 / 集成 / E2E 测试
- `docker-compose.yml` —— app + PostgreSQL 本地与云端同一套

## 数据库约定（节选）

- 主键统一 UUID v7，物理列名 snake_case。
- 客户阶段：业务关联只引用不可变 UUID；预置 13 阶段绑定语义锚点
  （`qualified` / `booked_demo` / `quoted` / `won` / `closed` 等），
  指标口径锚定语义而非名称，改名改码不破坏历史（见 `src/lib/stages.ts`）。
