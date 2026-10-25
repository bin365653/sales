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

### 方式三：本机无 Docker 时（Windows 便携版 PostgreSQL）

本仓库 `.verify/`（已 gitignore）可放一份便携版 PostgreSQL 二进制，
数据目录须放在**纯 ASCII 路径**（中文路径会导致 initdb/postgres 编码错误）：

```bash
# 一次性准备（版本与 compose 的 postgres:16 对齐）
npm pack @embedded-postgres/windows-x64@16.4.0-beta.14
tar -xzf embedded-postgres-windows-x64-16.4.0-beta.14.tgz
package\native\bin\initdb.exe -D C:\Users\PC\qince-verify-pgdata -U qince -A trust -E UTF8 --locale=C

# 启停
package\native\bin\pg_ctl.exe -D C:\Users\PC\qince-verify-pgdata -l C:\Users\PC\qince-verify-pg.log -o "-p 5432" start
package\native\bin\pg_ctl.exe -D C:\Users\PC\qince-verify-pgdata stop
```

然后按"方式二"完成迁移、seed 与开发启动（trust 认证仅限本机回环）。

## 认证与数据范围（T02 交付）

- 登录页 `/login`，不开放自助注册（管理员建号，M5）；Argon2id 密码哈希。
- 数据库会话：Cookie 只存随机 token（HttpOnly + SameSite=Lax，生产 Secure），
  库存 SHA-256 哈希；30 天滑动续期；登出/停用账号立即失效。
- 登录限流 5 次/15 分钟（IP+账号，内存滑动窗口）；登录成功/失败、登出、改密写 `audit_logs`。
- 权限唯一出口 `src/server/permissions`：销售仅见本人线索（越权一律 404），
  管理员全量 + 配置写；middleware（防线 1）+ 布局/API 守卫（防线 2）。
- 本人改密 `PATCH /api/auth/password`；管理员重置他人密码随 T15 交付。

## 线索模型与配置（T03 交付）

- **数据模型**（`leads` / `lead_field_defs` / `lead_events`，迁移 `*_t03_leads_field_defs_events`）：
  - `leads`：PRD §5.3 全字段独立列 + 四个关键事实字段的核实状态列
    （`current_system_status` 等，unknown/unverified/confirmed）；
    `custom_values` JSONB 存自定义字段值；`data_version` 乐观并发；
    `deleted_at` 软删除（历史表永不物理删除）。
  - `lead_field_defs`：内置字段（23 个，seed 生成，key = 物理列名）与自定义字段
    统一定义；key/type 不可变；已被使用的字段只能停用（归档）。
  - `lead_events`：created/imported/updated/stage_changed/deleted 事件流，
    阶段变更保存前后阶段 UUID + 当时编码/名称快照（`stage_snapshot`）。
- **阶段全配置**（K2/C02）：`/api/settings/stages` 新增/改名/改码/排序/启停；
  语义锚点（semanticKey）只随 seed 预置阶段生成，任何 API 无法写入或修改，
  指标口径锚定语义锚点，改名改码不破坏历史与统计。
  停用阶段不可作为新流转目标（`stage_inactive`），已处于该阶段的线索不受影响。
- **自定义字段**（C12）：text/number/date/single_select 四类，值校验引擎
  `src/lib/lead-field-validation.ts` 前后端共用（必填/长度/范围/正则/选项）；
  V1.0 不参与筛选与统计。停用的内置/自定义字段出现在提交中会被拒绝，不静默丢弃。
- **线索 API**：`GET/POST /api/leads`（关键词搜索+组合筛选+分页）、
  `GET/PATCH/DELETE /api/leads/:id`（详情/局部编辑/软删除）、
  `PATCH /api/leads/:id/stage`（阶段流转，写 lead_events）。
  编辑与流转必须携带 `dataVersion`，冲突返回 409 `version_conflict`。
- **时间口径**：纯日期列（合同到期）按 UTC 日期存储；本地日期时间（下次联系）
  统一按 Asia/Shanghai（+08:00）解释（决策 C13）。
- 线索池/详情页 UI 随 T04 交付；本任务交付 API 与服务层（含测试）。

## 线索池与客户详情 UI（T04 交付）

- **P3 线索池**（`/leads`）：关键词搜索（名称/联系人/电话，电话精确、其余不区分大小写）
  + 组合筛选（城市/行业/来源/销售模式/在用系统为精确匹配，阶段/优先级/负责人（仅管理员）为下拉）
  + 分页（筛选条件随 URL 保留）；筛选器为 GET 表单，禁 JS 也可用。
  页面数据直接走服务层 `listLeads`，与 `GET /api/leads` 同一实现，口径必然一致。
- **批量修改**（`PATCH /api/leads/batch`）：白名单仅 4 个管理性字段——
  优先级 / 客户阶段 / 客户来源 / 下次联系时间；白名单外字段 400 拒绝（不静默忽略）。
  ids 混入他人线索或不存在/已删除 id 一律**整体拒绝**（404，零部分成功）；
  批量不做逐条乐观锁，统一 `data_version +1`，留 `updated`（带 `batch: true` 标记）/
  `stage_changed` 事件与审计；已处于目标阶段的线索跳过（不写事件不升版）。
- **P5 客户详情**（`/leads/:id`）：画像全字段按组展示 + 四个关键事实字段核实状态徽标，
  自定义字段（停用但仍有值的也展示并标注）、阶段时间线（`lead_events`，最新在前，
  阶段流转按当时快照显示"从 → 到"，修改资料显示字段名）、
  编辑（与新建共用 `LeadForm`，前后端同一份 Schema 与校验引擎）、
  阶段流转（带 dataVersion，409 提示刷新）、软删除（确认后）。
- **新建客户**（`/leads/new`）：全字段表单，除客户名称外均可留空；新建成功跳详情页。
- **移动端**：列表隐藏次要列 + 表格横向滚动，筛选两列网格，详情单列堆叠；
  核心路径（搜索、筛选、查看、编辑）手机端可用。
- **越权**：页面与批量全部经 permissions 层（销售仅本人，管理员全量）；
  他人线索详情页 404。
- 验收锚点：组合筛选/分页与手写 SQL 逐项一致的集成测试
  （`tests/integration/leads-list.test.ts`）、批量白名单与整体拒绝语义
  （`tests/unit/lead-batch-schema.test.ts` + `tests/integration/leads-batch.test.ts`）。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发服务器 |
| `npm run build` / `npm run start` | 生产构建 / 启动 |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript 检查 |
| `npm run test` | Vitest 单元测试（无需数据库） |
| `npm run test:integration` | 集成测试（需先启动 PostgreSQL，见上） |
| `npm run test:all` | 单元 + 集成 |
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
- 线索字段：内置字段定义由 seed 幂等生成（key = `leads` 物理列名，可启停/排序）；
  自定义字段值存 `leads.custom_values`（键为字段稳定 key）；字段校验规则以后端为唯一事实源。
