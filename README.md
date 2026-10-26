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

## 导入与导出（T05 交付）

- **数据模型**（迁移 `*_t05_imports_exports`）：`import_batches` + `import_rows`
  （两阶段导入，预览只写批次表，确认才写 leads）与 `export_files`
  （导出物落库 bytea、24 小时过期，支撑"创建与下载分离"契约）。
- **导入模板**：动态端点 `GET /api/imports/template?format=xlsx|csv`
  （始终包含当前启用中的自定义字段列）；静态副本 `templates/客户导入模板.{xlsx,csv}`
  由 `npm run templates:generate` 生成（覆盖内置 23 列 + 填写说明页）。
- **导入向导 P4**（`/leads/import`）：上传 → 字段映射（表头自动按字段名猜测，
  手动可调；必须映射客户名称、目标不可重复、必填自定义字段必须在文件中有列）
  → 预览（全部/有效/错误/重复分栏，错误行按列序给出与表单完全同源的中文原因）
  → 逐行决定（跳过/新建，重复行默认跳过可仍新建）→ 确认导入 → 结果汇总。
- **限制与解析**（M8/C14）：.xlsx/.csv 白名单、≤10MB、≤5000 数据行；
  XLSX 富文本/公式/超链接单元格拍平、日期单元格转 `YYYY-MM-DD`；
  CSV 关闭数字推断（保护带前导零的号码）、UTF-8 BOM 剥离、
  无 BOM 时严格 UTF-8 失败回退 GB18030（Excel 中文默认编码）、引号不闭合整体拒绝。
- **行级校验**：与新建表单同一份 `leadCreateSchema` + 自定义字段校验引擎
  （`src/lib/import/normalize.ts` 矫正 是/否、日期；`src/server/services/imports.ts`
  的 `validateRowByMapping` 组装），错误文案与手工录入一字不差。
- **重复判定（M2）**：手机号标准化（去 +86/86/空格/横线/括号）精确匹配 = 确认重复；
  名称+城市（大小写/空白不敏感）= 疑似重复；均含库内与文件内（dupRowNo）两种来源；
  检测范围走权限层数据范围（销售=本人，不泄露他人客户存在性；管理员=全量）。
  只允许"跳过/仍新建"，绝不更新既有线索。
- **确认入库**：整体事务（任一行失败全部回滚）；每条线索写 `imported` 事件
  （detail 含批次 id/行号/文件名）+ `import.confirmed` 审计；批次终态 `confirmed`
  不可重复确认；确认时逐行复检（预览后字段配置变更 → recheckFailed 计数，不静默错导）。
- **导出**：`POST /api/exports/leads`（按当前筛选，XLSX/CSV）+
  `POST /api/exports/me`（个人全量 ZIP：客户 XLSX+CSV + 沟通记录.csv（T06 并入）；
  任务/AI 记录随 T07–T08 落表后并入）+ `GET /api/exports/:id/download`（仅创建者可下载）。
  行集合 = 线索池列表同一 where 构造器（`buildLeadListWhere`），导出范围与列表
  口径由同一段代码保证；自定义字段列仅当导出结果中存在值时输出（含已停用字段）。
- **导出安全**：`=` `+` `-` `@` 及制表符开头单元格统一加 `'` 前缀（公式注入转义，
  XLSX 与 CSV 同规则）；CSV 带 UTF-8 BOM；每用户 5 次/小时限流（429）+ 审计。
- **越权**：导入批次与导出文件均归属创建者，他人访问/下载一律 404
  （`tests/integration/imports-flow.test.ts` / `exports.test.ts` 固化）。

## 沟通记录（T06 交付）

- **数据模型**（迁移 `*_t06_interactions`）：`interactions` 表 = PRD §5.6 字段全集
  （渠道/方向/接通/有效 + 反馈、痛点、当前系统、采购时间、决策人、异议、
  下一步、下次联系时间 + 合格/预约标记）；不存归属冗余列，可见性一律经线索归属
  判定（§4.4，销售仅本人、管理员全量，越权 404）；`edit_audit` JSONB 承载修正审计。
- **P5 沟通区块**（详情页 `InteractionsPanel`，新建/修正共用 `InteractionForm`）：
  时间线列表（渠道·方向、有效/合格/预约徽章、"已修正 N 次"可展开审计）；
  表单常驻 effective 定义文案（"获得有价值业务信息或明确下一步动作，仅接通不算"）
  与方向字段（呼出/呼入，K5 呼出指标来源）。
- **保存事务**（`POST /api/leads/:id/interactions`）：单事务完成 沟通记录 +
  last_contact_at +（可选）next_contact_at + "本次确认"核实状态 + K4 条件推进阶段；
  任一步失败整体回滚（集成测试强制线索行更新失败对账：记录不落库、版本不变）。
- **K4 联动（C09）**：勾选合格/预约 → 自动推进至 qualified / booked_demo 锚点阶段。
  仅当目标存在、启用且排序晚于当前（只进不退）；双勾选取更远目标、单条
  stage_changed 事件（detail 记 `reason=interaction_advance` + triggers）；
  表单按同规则实时展示推进提示。
- **修正留痕（M11/M1）**：`PATCH /api/interactions/:id` 修正不改写历史，
  `edit_audit` 追加 `{at, by, changed:{field:{from,to}}}`；无变化提交幂等
  （不升版本、不追加审计）；不提供删除。
- **边界语义**（细节）：
  - `last_contact_at = max(既有, 本次)`：补录更早沟通不回退最近联系时间；
  - `next_contact_at`：未填不改动既有计划；修正时仅当该记录仍是最新一条才同步；
  - "本次确认"仅新建提供：单向把画像核实状态置为已确认（不改字段值），
    修正表单不含此项；
  - `occurred_at` 允许补录过去、拒绝未来（5 分钟容差）；effective 依赖 connected
    （Schema 交叉校验，zod v4 的 refine 须在 omit 之后叠加）。
- **个人全量导出并入**（M9 推进）：`POST /api/exports/me` ZIP 新增 `沟通记录.csv`
  （含软删除客户的沟通；公式转义与 T05 同规则）；任务/AI 记录随 T07/T08。
- **验收锚点**：`tests/unit/interaction-schemas.test.ts`（10 例）+
  `tests/integration/interactions.test.ts`（14 例：事务副作用、K4 四态、
  修正幂等、回滚对账、越权 404、列表排序）。

## 任务管理（T07 交付）

- **数据模型**（迁移 `*_t07_tasks`）：`tasks` = PRD §5.7 字段全集
  （7 种类型枚举 first_contact…revive + 标题/截止时间/状态/备注）+
  `assignee_id`（创建时线索负责人快照，不设改派）与 `created_by`（创建者）；
  每项任务必须关联客户，可见性一律经线索归属判定（§4.4，销售仅本人、
  管理员全量，越权 404）；`interaction_id` 引用完成时生成的沟通记录
  （UIUX P6"已完成任务显示完成时间与沟通记录链接"）。
- **状态语义（C11）**：pending/done/canceled 三态；任务只可取消、不可删除；
  状态不可手工置为 done——完成只经 `POST /api/tasks/:id/complete-with-interaction`
  （必须同时留下沟通记录，无"静默完成"）；已完成/已取消任务 400 拒绝再编辑。
- **完成事务（验收项）**：任务标记 done（记 `completed_at`，永不回写清空）+
  沟通记录 + 线索副作用（last_contact_at/本次确认/K4）+ 可选下一任务，
  单事务任一步失败整体回滚（集成测试强制 interaction.create 失败对账：
  任务仍待处理、无沟通记录、无下一任务、线索版本不变）。
  沟通写入核心抽至 `src/server/services/interaction-write.ts`，
  与沟通保存（T06）共用同一实现——K4 阶段联动规则天然一致。
- **今日/逾期视图（C13 逾期口径）**：逾期 = 待处理且截止日早于今天
  （Asia/Shanghai 日界而非当前时刻，截止日当天整天仍算今日任务，跨日才转逾期；
  单测固化 23:59→00:00、跨月、跨年边界）；今日视图含逾期置顶（dueAt 升序）；
  工作台卡片口径（今日任务/逾期任务计数）与任务中心同一实现（`counts`），
  供 T12 直接取用。`/tasks` = 今日/逾期(角标)/全部（状态可筛选）三视图，
  Tab 为链接（禁 JS 可用），分页随 URL 保留。
- **P6 任务中心**（`/tasks`）：任务卡（类型徽章+状态徽章+截止时间展示：
  今日"今天 HH:mm"、逾期红字"已逾期 X 天"+整卡左侧 3px 红条）；
  待处理任务可 完成（弹窗式表单）/编辑/取消（简单确认）；
  新建任务 = 线索搜索选择（防抖 300ms，`GET /api/leads` 同源）+ 类型/标题/截止/备注。
- **完成任务弹窗（UIUX P6）**：①沟通结果（与沟通保存同一 Schema，校验文案一字不差；
  effective 定义文案常驻）+ ②下一步（创建下一任务/暂不创建，标题自动
  "类型-客户名"）；K4 勾选合格/预约的阶段推进提示与服务端同规则
  （`src/lib/k4.ts` 单一来源，沟通表单共用）。
- **P5 任务区块**（详情页 `TasksPanel`，操作同 P6）：待处理在前（截止时间升序）、
  已完成/已取消殿后；沟通表单新增"同时创建任务"（T07/UIUX P5）：
  与沟通保存同事务，截止时间缺省联动下次联系时间，标题自动。
- **个人全量导出并入**（M9 推进）：`POST /api/exports/me` ZIP 新增 `任务.csv`
  （标题/客户/类型/截止/状态/完成时间/完成时沟通时间/备注；含软删除客户的任务，
  公式转义与 T05 同规则）；AI 记录随 T08 落表后继续并入。
- **验收锚点**：`tests/unit/task-overdue.test.ts`（11 例：逾期跨日判定）、
  `tests/unit/task-schemas.test.ts`（17 例）+
  `tests/integration/tasks.test.ts`（19 例：视图跨日、事务闭环、回滚对账、
  越权 404、沟通建任务同事务回滚）；生产构建冒烟 21 项全通过。

## AI 基础设施（T08 交付）

- **数据模型**（迁移 `*_t08_ai_infra`）：`model_configs`（provider/base_url/模型名/
  超时/重试/单激活）、`prompt_templates` + `prompt_versions`（版本只增不改，
  `ai_runs.prompt_version_id` 记录具体版本、历史可复现）、`ai_runs`（每次调用全量
  留痕：输入快照 + data_version + 状态/耗时/错误类型，PRD §5.5/§6.8）。
- **密钥安全（验收项：密钥不回显不入日志）**：API 密钥仅在设置接口提交一次，
  AES-256-GCM 加密落库（`model_configs.api_key_cipher`），主密钥来自环境变量
  `APP_ENCRYPTION_KEY`（64 位 hex，不进 Git/备份；丢失只影响密钥配置可重录）；
  任何接口只返回 `key_last4` 与 `hasKey`，明文/密文不出现在响应、审计
  （`ai.model_config_created/updated`）与错误信息中。解密仅存在于单次调用内存。
- **Provider Adapter（`src/server/ai/provider.ts`）**：OpenAI 兼容
  `/chat/completions` 单实现适配多服务商——换 provider 仅改配置（C05）。
  错误五分类 `timeout/auth/rate_limit/provider/invalid_output`：超时（AbortSignal）
  → timeout、401/403 → auth、429 → rate_limit、其余 HTTP/网络错误 → provider；
  网络类错误（timeout/provider）按 `max_retries`（默认 1）重试，auth/rate_limit 不重试。
- **Output Validator（`src/server/ai/validator.ts`）**：Zod 固化三种输出结构——
  `analysis`（PRD §5.4 八项：匹配度/事实(facts.status 区分已知与待核实)/痛点≤3+依据/
  切入点/下一步/待核实问题）、`call_prep`（PRD §5.5 六项：目标/开场/3 诊断问题/
  2 异议应对/确认动作/避免表述）、`interaction_summary`（T10 摘要草稿）。
  宽容解析（去 Markdown 围栏）；结构非法带纠错指令自动重试 1 次，仍失败落
  `invalid_output` 供重试入口（R2）。
- **Context Builder（`src/server/ai/context.ts`）**：白名单输入快照（画像+系统情况+
  采购情况+阶段+最近 5 条沟通+核实状态列），不含联系人电话（PRD §6.9 最小化
  敏感信息）；快照整体落 `ai_runs.input_snapshot`。
- **提示词基线（交付物，`src/server/ai/prompts/`）**：三份中文系统提示词
  （含反幻觉红线："仅使用输入资料；禁止推测营收/人数/在用系统/到期时间；
  事实与推断分离；信息不足输出 unknown"），经 seed 幂等建为模板 + v1 版本；
  运行时一律经 Prompt Registry 读库，业务代码零硬编码提示词（§5.11）。
- **执行模型（§7.2）**：`POST /api/ai/runs` 权限（线索写范围）→ 每日频控
  （发起即计数，`AI_DAILY_LIMIT` 默认 50 次/人，超限 429 `ai_daily_limit`）→
  配置/提示词就绪校验（无启用配置 409 `ai_not_configured`）→ 落
  `ai_runs(pending)` 立即返回 run_id，后端异步执行，前端轮询
  `GET /api/ai/runs/:id`；AI 输出只写 `ai_runs.output`，不触发任何业务表（K3）。
- **重试与历史**：`POST /api/ai/runs/:id/retry` 仅失败/超时/格式异常可重试，
  重试 = 新 run（`retry_of_id` 留痕，快照按当前数据重建）；历史
  `GET /api/leads/:id/ai-runs` 倒序全量留痕；越权一律 404。
- **个人全量导出并入**（M9）：ZIP 新增 `AI记录.csv`（发起时间/类型/服务商/模型/
  提示词版本/状态/错误/耗时/数据版本——只含状态元数据，快照与输出全文不进导出）。
- **真实服务商联调说明**：T08 验收（错误分类/invalid_output/换 provider/密钥安全）
  由自动化测试经注入 fetch 全覆盖；真实模型调用待 C15 首个服务商 base_url+key
  提供后经 T09 面板复核（面板已交付，换 provider 仅改配置，见下节）。
- **验收锚点**：`tests/unit/ai-crypto.test.ts`（6 例）、`ai-provider.test.ts`
  （9 例：错误分类与重试）、`ai-validator.test.ts`（15 例）、`ai-context.test.ts`
  （4 例：白名单无电话）、`ai-schemas.test.ts`（7 例）+
  `tests/integration/ai-model-configs.test.ts`（7 例：密钥不回显/单激活/审计）、
  `ai-runs.test.ts`（16 例：错误分类/自动纠错重试/invalid_output/换配置/频控 429/
  越权 404/retry 留痕/导出并入）；生产 HTTP 冒烟 19 项（401/密钥不回显/
  failed+provider 分类/轮询终态/重试/用量字段）全通过。

## 详情页 AI 面板（T09 交付）

- **范围口径**：两种 run 的提示词与输出 Schema 已随 T08 交付（`analysis` 8 项 /
  `call_prep` 6 项，Zod 固化 + seed 版本 v1）；本任务交付详情页 AI 面板
  （UIUX §4.7 全产品唯一 AI 交互模板的前两种入口）与常规组 guard 接入位，
  `interaction_summary`（AI 生成摘要）随 T10 以同一模板接入。
- **P5 AI 面板**（详情页 `AiPanel`，`src/components/leads/ai-panel.tsx`）：
  - **入口与用量**："AI 客户分析" / "AI 电话准备卡" 双按钮 + 常驻用量行
    "今日 AI 已用 x/50"；同一客户已有 pending run 时按钮禁用（防并发重复调用）；
    达到每日上限时禁用并展示 §7.2 文案（发起即计数，失败/重试同占额度，T08）。
  - **异步执行（§6.2）**：点击 → `POST /api/ai/runs` 创建 run(pending) → 运行卡
    （"正在生成… 预计需要 10–60 秒；可离开本页，完成后可在「AI 历史」中查看"）→
    前端 2s 轮询 `GET /api/ai/runs/:id`；再次进入详情页自动续接 pending 轮询
    （初始 runs 由服务端首屏整形传入，与轮询共用 `toAiRunView` 映射）；
    轮询上限 90 次（约 3 分钟），超限停止自动刷新并提示到历史查看
    （服务端执行与留痕不受影响）。
  - **成功展示（验收项：8+6 项齐全、事实/推断/未知视觉区分）**：渲染前用与后端
    同一份 Zod Schema（`analysisSchema`/`callPrepSchema`）校验，结构异常降级为
    "输出内容无法解析"，不整面板崩溃。分析按匹配度徽章（高/中/低/信息不足）→
    已知事实（绿点）→ 待核实信息（琥珀点）→ 经营痛点 ≤3（每项附"推断依据"）→
    沟通切入点 → 推荐下一步 → 待核实问题分区渲染，信息不足整段灰底；
    准备卡按目标 → 开场 → 3 诊断问题 → 2 异议应对 → 确认下一步 →
    "需要避免的未经核实表述"（红色警示块）渲染，常驻
    "系统不会自动拨打电话或发送消息"边界与"AI 生成，仅供参考，请核对后使用"徽标；
    卡头展示生成时间/模型名/提示词版本号。
  - **失败与重试**：按 `error_type` 映射文案（UIUX §7.3，`AI_ERROR_MESSAGES`）+
    [重试]（`POST /api/ai/runs/:id/retry` = 新 run、`retry_of_id` 留痕）；
    409 `ai_not_configured` / 429 `ai_daily_limit` 均以服务端 message 呈现。
  - **复制（§4.10）**：一律产出纯文本分节格式（`src/lib/ai-copy.ts` 纯函数，
    单测固化），末尾常驻"(AI 生成,仅供参考,请核对后使用)"；输出结构异常时提示
    "复制失败，请手动复制"。
  - **历史**：折叠列表（时间/类型/状态徽章/模型名/提示词版本/输入数据版本），
    展开只读查看当时输出；顶部展示两种 run 当前启用提示词版本号；
    空状态文案："尚未生成过 AI 分析。AI 只使用本客户已填写的信息，信息越完整，
    结果越可靠。"
- **AI 失败不影响页面其他功能（验收项）**：面板为独立客户端组件并包在
  `AiPanelErrorBoundary` 内——请求失败/渲染异常只降级面板自身
  （"AI 面板暂时无法显示"+ 重试按钮），详情页画像/时间线/沟通/任务/编辑流转
  不受影响；编辑模式下面板不挂载。
- **常规组 403（T14 接入位）**：`src/server/ai/guard.ts` 的
  `assertAiAllowedForLead` 在发起与重试的频控**之前**调用（常规组拒绝不消耗
  每日额度）；T09 阶段恒通过（无分组表），T14 替换为实现并抛
  `ApiError(403, "ai_control_group")`——服务层契约（403 + 不落 run + 不计数 +
  重试同拦）已由集成测试固化（`vi.mock` 模拟常规组命中）。
- **历史 API 扩展**：`GET /api/leads/:id/ai-runs` 响应新增 `usage`（当日
  used/limit）与 `activePromptVersions`（各 run 类型启用版本号，缺失降级 null）；
  run 行新增 `modelConfig.{provider,modelName}` 与 `promptVersion.version`
  （select 白名单，绝无密钥列）。
- **空线索实测（验收项）**：仅名称线索发起分析/准备卡走完整链路——冒烟经本地假
  Provider 返回 insufficient 风格输出，断言"匹配度=信息不足 + 空 facts（unknown
  呈现）+ 待核实问题非空"，结构校验落库成功；提示词红线（仅用输入资料、
  禁止推测营收/系统/到期时间）随 T08 提示词基线单测覆盖。
- **真实服务商联调说明**：冒烟的"模型"为脚本内启动的本地假 Provider（返回合规
  JSON）；接真实 base_url+key 后（C15 提供后）面板行为无需改动——换 provider
  仅改模型配置（C05），空线索不编造仍需用真实模型人工复核一次。
- **验收锚点**：`tests/unit/ai-copy.test.ts`（5 例：8+6 项纯文本格式/信息不足
  占位/结构损坏防御）、`ai-run-view.test.ts`（2 例：Date/ISO 双形态一致映射）+
  `tests/integration/ai-panel.test.ts`（5 例：常规组 403 不留 run 不计数/
  重试同拦/历史含模型名与版本号且无密钥/空线索 insufficient 链路/准备卡六项）；
  生产 HTTP 冒烟 29 项（`.verify/t09-smoke.cjs`：SSR 入口与用量行/空线索 8+6 项/
  insufficient/历史扩展字段/failed 后页面不受影响/重试留痕/409）全通过。

## AI 摘要草稿（T10 交付）

- **范围口径**：`interaction_summary` 的提示词与输出 Schema 已随 T08 交付（seed v1）；
  本任务交付沟通表单「AI 生成摘要」→ 草稿回填 → 用户确认才保存的完整链路
  （§7.1 摘要审核流），复用 T09 详情页 AI 面板同一模板（异步/轮询/失败重试/复制/历史）。
- **原始沟通内容（notes）**：摘要以"销售口述/粘贴的原始沟通内容"为唯一素材——
  表单内先在「客户实际反馈」粘贴原始内容，点「AI 生成摘要」即以该内容发起 run
  （`POST /api/ai/runs` 新增 `notes` 入参：仅 interaction_summary 接受且必填，
  其余类型携带一律 400，防"无料可依"调用）；notes 随快照落
  `ai_runs.input_snapshot.raw_interaction_notes` 留痕（历史可复现）；
  重试沿用原 notes、画像/最近沟通等其余数据按当前线索重建。
- **草稿回填（P5 沟通表单，UIUX §P5）**：run 成功后 `summary` 回填「客户实际反馈」、
  `next_action` 回填「下一步动作」，两字段旁挂紫虚线"✦ AI 草稿"徽标
  （UIUX §4.1，与人工输入可区分）；渲染前经与后端同一份 `interactionSummarySchema`
  校验，结构异常按 invalid_output 文案提示可重试。**未确认不落正式记录**——
  草稿只存在于表单与 `ai_runs.output`，保存永远由用户点击触发
  （集成测试固化：run 成功后 interactions 计数不变）。
- **原始输出与最终记录可区分**：`interactions` 新增 `ai_run_id` 列
  （迁移 `*_t10_ai_draft`，逻辑引用同 audit_logs，无外键）：确认保存时服务层校验
  来源 run（本人 + 本线索 + interaction_summary + success，任一不满足 400
  `invalid_ai_run` 整体拒绝、零部分成功）并登记来源；记录时间线显示
  "✦ AI 草稿确认"徽标；`ai_runs.output` 原始输出不可变，用户编辑后的最终值可与之
  比对（集成测试以"编辑后保存 + 两者不同"断言）。修正（PATCH）不接受 aiRunId，
  来源登记后不可改写。
- **互斥与轮询（§4.7）**：沟通表单与详情页 AI 面板经 `aiPending`/`onPendingChange`
  双向联动——任一处存在 pending run 时其余 AI 入口禁用（防并发重复调用）；
  表单侧 2s 轮询上限 90 次，超限提示到「AI 历史」查看；表单关闭/保存成功时停止
  本侧轮询并复位互斥状态，服务端 run 继续执行且留痕。
- **面板与复制（同一模板）**：AI 面板历史/详情支持 interaction_summary 只读展示
  （两项分区 + "草稿仅作回填参考"说明），历史区顶部展示三类 run 的启用提示词
  版本号；摘要 run 不提供面板侧"重新生成"（需携带 notes，统一从表单发起），
  失败仍可重试（新 run 留痕）；复制格式 `formatInteractionSummaryCopy` 纯文本
  两项 + 草稿边界说明 + 合规脚注；`formatAiRunCopy` 分发前先经 Zod 校验
  （结构异常返回 null 提示复制失败，不渲染 "undefined"）。
- **输出上限对齐落库列**：`interactionSummarySchema.next_action` 上限 500→255
  （对齐 `interactions.next_action` VARCHAR(255)），超限走纠错重试而非回填后被表单拒绝。
- **验收锚点**：`tests/unit/ai-schemas.test.ts`（notes 必填/禁带）、`ai-copy.test.ts`
  （草稿格式 + 分发防御）、`ai-validator.test.ts`（255 边界）、
  `interaction-schemas.test.ts`（aiRunId 可选携带/修正剥离）+
  `tests/integration/ai-draft.test.ts`（7 例：快照留痕/未确认不落库/重试沿用 notes/
  来源校验四态 400/越权 404/编辑值与原始输出可区分）；
  生产 HTTP 冒烟 31 项（`.verify/t10-smoke.cjs`：入参规则/快照留痕/未确认不落库/
  invalid_ai_run/确认保存/SSR 徽标/历史版本号）全通过。

## 工时填报（T11 交付）

- **范围口径**：`work_time_entries` 落表（迁移 `*_t11_worktime`，K5/C03 批准纳入 V1.0）
  + `GET/PUT /api/worktime`（实施计划 §6 工时 API 契约）+ P9"每日工时"周历填报页。
  该表是"每小时有效沟通数"的分母来源（K5），指标计算本身随 T12/T13 交付——
  本任务保证数据可用：未填报日期查询返回 `hours=null`（看板显示"—"而非 0 的前提）。
- **每人每日一条（验收项：重复提交覆盖不报错）**：`unique(user_id, work_date)`
  数据库约束兜底；写入走 Prisma upsert（`INSERT … ON CONFLICT DO UPDATE` 原子覆盖），
  同日重复提交恒 200、不产生第二行，并发提交也不会撞唯一约束（集成测试 + 冒烟固化）。
- **值语义**：`hours` DECIMAL(4,1)，0–24、0.5 步进（UIUX §4.9），后端为唯一事实源
  （Zod Schema 前后端同一份；0.5 的倍数在二进制浮点下精确可表示，`v*2` 整数判定安全）；
  `hours=0` = 已填报的"当天未工作"，与"未填报"（无行 → `hours=null`）区分，
  看板两者都显示"—"但语义可分（C03：禁止把未填报显示成 0%）。
- **日期口径**：`work_date` 纯日期列按 UTC 日期存储（同 `contract_expiry`），
  值即销售在上海日历（C13）下的工作日；周起点为周一（C13），
  周历工具 `src/lib/worktime.ts` 的跨月/跨年/闰年边界由单测固化。
- **API**：`GET /api/worktime?date=YYYY-MM-DD`（单日契约，未填报 `hours=null` 不报错）
  与 `?week=YYYY-MM-DD`（周内任意一天定位，返回周一→周日 7 天，供周历 UI）二选一；
  `PUT /api/worktime?date=` body `{ hours }` 录入/修改。工时是个人数据，恒按当前登录
  用户读写（他人含管理员不可见、无跨人代填）；未登录 401，入参 400 的中文文案与
  表单提示一字不差。
- **UI（`/settings/worktime`）**：周历视图（周一~周日 7 格，0–24、0.5 步进，留空 =
  未填报不提交），默认本周、可切上周/下周/回到本周（链接承载 GET 语义，禁 JS 可查看）；
  [保存本周] 只提交有改动的日期（失败保留输入可重试）；切换周时有未保存修改先确认；
  常驻提示"未填报的日期，看板「每小时有效沟通」将显示—"。设置中心完整页签结构随 T15
  交付，届时本页并入 /settings（`WorktimeWeekForm` 组件直接复用）；导航「设置中心」
  自 T11 起临时指向本页。
- **给 T12/T13 的约定**：服务层 `getWorktimeEntry`/`getWorktimeWeek` 是查询唯一实现；
  指标引擎聚合请直接查 `prisma.workTimeEntry`（`work_date` 范围有索引），遵守
  "未填报 = 无行（hours 缺失）"即可自然得到"—"语义，无需特判。
- **验收锚点**：`tests/unit/worktime-schemas.test.ts`（32 例：日期真实性/0.5 步进/
  0 与 24 边界/date+week 二选一）、`worktime-week.test.ts`（13 例：跨月/跨年/闰年
  周界与"起点必为周一"不变量）+ `tests/integration/worktime.test.ts`（7 例：
  upsert 覆盖不报错且行数恒 1/hours=0 与 24/未填报 null/UTC 日期落库/跨年周历/
  个人数据隔离）；生产 HTTP 冒烟 25 项（`.verify/t11-smoke.cjs`：未登录 401/
  重复提交覆盖/步进与范围 400/周历回填/SSR 回显与导航入口）全通过，
  最小闭环冒烟 50 项回归通过。

## 指标引擎与工作台（T12 交付）

- **范围口径**：`server/metrics` 指标引擎全口径实现（PRD §5.9 全部指标的唯一出处，
  T13 看板直接调用）+ P2 工作台首页（PRD §5.1 / UIUX P2）+ `GET /api/dashboard/summary`。
  四条验收锚点：固定 fixtures 数据集与手工计算逐项一致（单测固化）；分母 0 显示"—"；
  优先理由与规则一致；无采购信号不出现"高意向"话术。
- **指标引擎（`src/server/metrics/engine.ts`；纯函数口径在 `src/lib/metrics.ts`）**：
  - 沟通类（呼出/接通/有效）：`interactions.occurred_at` 落在周期内；呼出 =
    `channel=phone 且 direction=outbound`（K5/C08），接通 = 其中 `connected=true`，
    有效 = `effective=true`（不限渠道）；含软删除客户的沟通（发生过就是发生过，
    与个人全量导出 M9 同口径）。
  - 阶段类（合格/预约/演示/报价/成交）：`lead_events` **首次进入**语义锚点阶段的
    时间落在周期内（同一线索多次进出只计首次，不随反弹重复计数）——
    PRD §5.9"基于同一批线索的阶段推进记录计算"，也是 T13 阶段转化的口径基础。
  - 比率（§5.9 原公式，纯函数 `computeRates` 固化）：接通率=接通/呼出、
    有效沟通率=有效/接通、合格线索率=合格/有效、预约转化率=预约/有效、
    每小时有效沟通=有效/工时（K5 分母）；**分母 0 或缺工时 → null → 界面显示"—"，
    绝不显示 0%**（C03）；数值已乘 100 保留 1 位小数，前后端不再二次舍入。
  - 平均处理时间（K5 ③）：线索创建 → 首次成为合格商机或关闭；首次终态时间
    落在周期内的线索进均值（天，1 位小数），未到终态的线索不进。
  - 另含各阶段客户数量（当前快照，不含软删除；停用阶段仍持有线索时照常列出）
    与 AI 使用次数（按 `ai_runs.user_id`，发起即计，含失败/重试）。
  - 数据范围一律经 permissions 层：销售=本人线索（工时/AI 按本人），
    管理员=全量汇总（P2 权限口径）；周期口径 Asia/Shanghai 日界、周一为周起点（C13）。
- **建议优先联系（K6 规则引擎，`src/server/metrics/priority.ts` + 纯函数评估）**：
  确定性规则、AI 不参与——① 合同 30 天内到期（**核实状态=已确认**才计入，含已过期，
  理由给出具体天数）；② 今日待联系（下次联系=今天，上海日界）；
  ③ 画像完整且从未联系（核心画像 10 项已填 ≥8 且从未联系）。
  理由是封闭集合（单测状态×信号全矩阵固化），未确认合同/无采购信号不产生任何理由，
  全链路无"高意向"话术；排序 = 规则权重 → 合同到期升序 → 下次联系升序 → 创建时间；
  候选经 OR 超集 SQL 圈定后应用层逐条评估，默认限 5 条。
- **P2 工作台（`/` 首页重写）**：今日三卡（今日待联系/今日任务/逾期任务红字；
  整卡分别跳转线索池预筛选「下次联系=今天」、任务中心今日/逾期视图）+
  本周概览（呼出/有效/合格/预约，周一起算；看板随 T13 交付暂不跳转）+
  建议优先联系卡（阶段/人工优先级徽标、**理由行必显**、规则说明 ⓘ 常驻 K6 合规文案、
  电话一键复制——手机端为 `tel:` 手动拨打，系统绝不自动外呼）+
  最近沟通记录（10 条倒序：相对时间、渠道·方向·接通、有效徽标、一句话摘要，点击进详情）。
  空态文案按 UIUX §7.4；移动端卡片堆叠、号码 `tel:` 可点。
- **今日待联系口径贯通**：`leadListQuerySchema` 新增 `nextContact=today` 筛选，
  走 `buildLeadListWhere` 唯一 where 构造器（新增 `options.now` 注入供测试）——
  工作台计数、卡片跳转与线索池「下次联系」下拉三者同一段代码，口径必然一致。
- **任务计数抽取**：`getTaskCounts`（今日/逾期，上海日界）自 `listTasks` 抽出为独立
  服务函数，任务中心 `counts` 字段与工作台卡片字面上共用同一实现（T07 约定兑现）。
- **API**：`GET /api/dashboard/summary` 与首页 SSR 共用 `getWorkbenchSummary`
  （未登录 401；无需入参，周期恒为本周）；返回 today 三卡 / week 计数与比率 /
  priorities（附理由）/ recentInteractions / generatedAt。
- **给 T13 的约定**：看板直接调用 `computeMetricsSnapshot(user, period)`
  （period 为上海日历日闭区间 `{from,to}`）与 `computeRates`；阶段转化沿用
  "首次进入 lead_events 锚点"口径；"—" 语义 = 比率字段为 null，前端不需要特判。
- **验收锚点**：`tests/unit/metrics-rates.test.ts`（6 例：fixtures 手工对账/分母 0
  全null/工时 null 与 0）、`metrics-priority.test.ts`（14 例：三条规则边界/未确认
  不产生理由/排序规则/状态×信号全矩阵封闭话术）、`format-relative.test.ts`（8 例）+
  `tests/integration/dashboard.test.ts`（12 例：2027-03 固定三方数据集逐项对账
  ——销售 A/销售 B/管理员全量，含首次进入去重、工时 null、平均处理时间 5.3/5.5 天、
  任务计数同一实现、K6 排除与排序、B 数据不泄露给 A）；生产 HTTP 冒烟 30 项
  （`.verify/t12-smoke.cjs`：结构/周一为起点/计数联动/工时分母由"—"变实值/SSR 模块
  与合规文案/清理还原）+ 最小闭环 50 项回归通过。

## 最小闭环验收（T01–T07）

三层验证，从快到慢依次执行：

```bash
npm run test                # ① 单元测试（292 例，无需数据库）
npm run test:integration    # ② 集成测试（152 例，需 PostgreSQL，见上文启动方式）
npm run test:smoke          # ③ 最小闭环 E2E 冒烟（需先启动应用）
```

③ 的冒烟脚本 `tests/e2e/minimal-loop.cjs` 走 HTTP 层黑盒验证完整业务闭环（50 项断言，
自动清理冒烟数据，可重复执行）：健康检查 → 未登录重定向/登录/登出失效 → 新建线索
（校验拒绝/阶段流转/dataVersion 409）→ 线索池筛选分页/详情页/批量修改（白名单拒绝）→
导入模板下载/CSV 上传/重复检出/行级校验/确认入库/批次终态 → 列表导出 XLSX 下载 →
沟通保存 + K4 自动推进 qualified + 修正留痕 → 任务今日/逾期视图 → 完成任务弹窗
（done + completed_at + 沟通记录 + 下一任务同事务）→ 重复完成拒绝 → 取消任务 →
个人全量导出 ZIP。前置：应用已启动且数据库已迁移 + seed。

```bash
npm run start               # 先启动生产服务（或 npm run dev）
npm run test:smoke          # 另开终端执行；SMOKE_BASE/SMOKE_USERNAME/SMOKE_PASSWORD 可覆盖默认值
```

**手工 UI 验收路径**（浏览器走一遍，验证页面交互与脚本的 API 行为一致）：

1. 打开 `http://localhost:3000` → 自动跳转 `/login`，用管理员账号登录（本地默认
   `admin`，密码见 `.env` 的 `ADMIN_PASSWORD`）。
2. 线索池 `/leads`：新建客户（仅填名称即可保存成功）→ 搜索/组合筛选/翻页 →
   进入详情页。
3. 详情页：编辑画像字段 → 阶段流转（换浏览器标签同时提交可看到 409 提示刷新）→
   添加沟通记录，勾选"形成合格线索"→ 阶段自动推进并出现 stage_changed 时间线条目；
   T10：先在「客户实际反馈」粘贴一段原始沟通内容 → 点「AI 生成摘要」→ 草稿回填
   （紫虚线"AI 草稿"徽标）→ 修改确认后保存 → 时间线记录显示"✦ AI 草稿确认"。
4. 任务中心 `/tasks`：新建任务（截止时间选昨天）→ 今日视图出现该任务且标红逾期 →
   点"完成"填沟通结果并创建下一任务 → 任务变为已完成且显示完成时间与沟通记录链接。
5. 详情页 AI 面板：先在设置接口建一条启用模型配置（或临时指向不可达地址观察
   失败文案），点"AI 客户分析"→ 运行卡 → 成功后核对 8 项分区（事实/推断/未知
   分色）、复制按钮、重新生成与历史展开；用仅名称的空线索再跑一次应显示
   "信息不足"而非编造；点"AI 电话准备卡"核对 6 项与红色警示块。
6. 线索池导入：下载模板 → 填 1 行有效 + 1 行错误数据 → 上传/映射/预览确认 →
   结果汇总与线索池核对。
7. 线索池导出与个人全量导出：下载 XLSX/ZIP 核对内容与公式转义。
8. 每日工时填报（导航「设置中心」→ `/settings/worktime`，T11 临时入口）：默认本周，
   填 2–3 天 → [保存本周] → 同一天改数值再保存应覆盖且不报错；切上周再切回数值仍在；
   留空的日期保持"未填报"（本周已填计数随之变化）。
9. 工作台首页 `/`（T12）：今日三卡计数与右上角任务中心一致；点「今日待联系」卡应
   跳转线索池并预筛选「下次联系=今天」；给某个客户把合同到期改为 30 天内并标"已确认"
   （或把下次联系时间设为今天）→ 回工作台出现建议优先联系卡且理由行与规则一致，
   "规则说明 ⓘ" 展示 K6 合规文案；电话复制不自动拨打；最近沟通记录与详情页一致。
10. 右上角登出 → 再访问任意页面回到登录页。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 本地开发服务器 |
| `npm run build` / `npm run start` | 生产构建 / 启动 |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript 检查 |
| `npm run test` | Vitest 单元测试（无需数据库） |
| `npm run test:integration` | 集成测试（需先启动 PostgreSQL，见上） |
| `npm run test:smoke` | 最小闭环 E2E 冒烟（需先启动应用，见「最小闭环验收」） |
| `npm run test:all` | 单元 + 集成 |
| `npm run db:migrate` | 创建并应用开发迁移（prisma migrate dev） |
| `npm run db:deploy` | 应用已版本化的迁移（部署用，幂等） |
| `npm run db:seed` | 基础数据 seed（幂等） |
| `npm run templates:generate` | 重新生成静态导入模板（templates/，字段定义变化后执行） |

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
