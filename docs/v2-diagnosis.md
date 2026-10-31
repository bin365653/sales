# 勤策 AI 销售工作台 V2.0 升级 —— 产品诊断与技术方案

**版本**：V2.0-DIAG-1（2026-10-31）
**性质**：诊断与方案文档，**不含任何代码改动**。经产品负责人确认后进入实施。
**诊断对象**：`qince-sales-workbench` @ main = 63e8dfe（V1.0 T01–T18 全量交付，单测 364 / 集成 182 / E2E 50 断言全绿）

**诊断依据**（已完整阅读）：
《V1.0GPT-PRD》《V1.0工程实施计划-Z》《V1.0-UIUX设计文档》、README（T01–T18 验收口径）、`prisma/schema.prisma` + 10 个迁移记录、`src/server/services/*`（leads/tasks/interactions/imports/lead-fields）、`src/server/metrics/*`（engine/priority）、`src/server/ai/*`（context/runner/validator/guard/prompts）、全部页面与 API 路由、tests 三层结构、部署配置。

---

## 0. 特别检查要求结论（先回答"是否重复开发"）

| 能力 | 现状 | 结论 |
| --- | --- | --- |
| 客户画像 | 字段集已按 PRD §5.3 落库（基本信息/系统情况/采购情况/管理组四组列），4 个关键事实字段带 `unknown/unverified/confirmed` 核实状态 | **部分已有，禁止重做**。缺的是：核实元数据（来源/核实人/核实时间）、字段级状态全覆盖、2 个象限轴字段 |
| 任务自动生成 | **完全没有**。任务仅有 3 个手工入口（新建/沟通附带/完成弹窗下一任务），全库无 cron/调度器/生成逻辑 | **需新建**（在现有 tasks 表上增量扩展） |
| 周期跟进 | **完全没有**。跟进节奏完全靠人工填 `nextContactAt` 与手工建任务 | **需新建** |
| 软件到期相关 | 仅有 `contractExpiry` 字段 + 优先级规则里"30 天内到期（须 confirmed）"的**展示性**提示（`src/server/metrics/priority.ts:110`） | 无任何到期任务生成、无 6 个月窗口概念，需新建 |
| 四象限 | 全库 0 命中（grep quadrant/象限/分类无业务代码） | **需新建** |

**总判定**：V1.0 骨架（线索/沟通/任务/AI 基础设施/阶段/导入导出/权限/测试）质量高且与 V2.0 要求高度同构，**全部复用**；V2.0 是在其上叠加"画像元数据 + 分类引擎 + 策略化任务生成"，属**纯增量升级**，无需推翻任何现有功能。

---

## A. 当前功能清单

### A.1 已完成（可直接复用）

| # | 域 | 内容 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 认证与安全 | DB 会话（30 天滑动、可撤销）、Argon2id、登录限流 5 次/15 分钟、全 API Origin 校验（CSRF）、middleware 双防线、数据归属隔离（销售只见本人） | `src/server/auth/*`、`src/middleware.ts` |
| 2 | 客户线索管理 | PRD §5.3 字段全集独立列、软删除、`dataVersion` 乐观锁、`lead_events` 只追加留痕、批量修改、关键词搜索 + 8 项筛选 | `src/server/services/leads.ts`、`prisma/schema.prisma:154-210` |
| 3 | 阶段管理 | 13 预置阶段，UUID + 语义锚点（`new_lead/qualified/booked_demo/quoted/won/closed` 等）全配置（增改排停），阶段变更快照留痕 | `src/lib/stages.ts`、`lead_stages` |
| 4 | 自定义字段 | 4 类型（text/number/date/single_select）+ 校验引擎，值存 `custom_values` JSONB，可导入导出 | `lead_field_defs`、`src/lib/lead-field-validation.ts` |
| 5 | 导入导出 | 两阶段导入（上传→映射→预览→确认）、精确/模糊查重、行级中文错误、XLSX/CSV；导出落库 24h 过期 + 限流 + 审计 | `imports.ts`、`exports.ts` |
| 6 | 沟通记录 | 只追加 + 修正留痕（editAudit）、有效沟通统一定义、K4 自动推进（isQualified→qualified / demoBooked→booked_demo，只进不退）、"本次确认"置位 2 项核实状态、`lastContactAt/nextContactAt` 回写 | `interaction-write.ts:177-240` |
| 7 | 手工任务 | 7 种任务类型、必须关联客户、完成必留 `completedAt`、完成弹窗单事务（完成任务+写沟通+可选下一任务+K4 推进）、只可取消不可删除、今日/逾期视图（上海日界） | `src/server/services/tasks.ts` |
| 8 | AI 基础设施 | 模型配置密文落库（AES-256-GCM）、多配置单激活、提示词版本只增不改、`ai_runs` 全量留痕（输入快照+dataVersion+状态/耗时/错误）、异步发起+轮询、失败自动纠错重试 1 次、每日 50 次频控、实验常规组拦截 | `src/server/ai/*` |
| 9 | AI 三能力 | 客户分析（匹配度/事实/痛点/切入点/verify_questions）、电话准备卡（目标/开场/3 诊断问题/2 异议/avoid）、沟通摘要草稿（口述→摘要+下一步，**人工确认后才落库**，`ai_run_id` 溯源） | `src/server/ai/prompts/*`、`validator.ts` |
| 10 | 看板与实验 | 周漏斗 8 指标、5 个比率口径（分母 0 显"—"）、圈选筛选、A/B 实验（draft→assign→running→closed，50/50 固定分组，样本不足提示） | `src/server/metrics/*` |
| 11 | 工时 | 每日一条 upsert，"每小时有效沟通数"分母 | `work_time_entries` |
| 12 | 设置 | 账号/密码、AI 模型、提示词版本、阶段、字段、用户管理、操作日志、个人导出 | `/settings` |
| 13 | 运维 | 备份（pg_dump→age 加密→rclone）+ 恢复演练（RTO 70s）、docker-compose.prod、Nginx 配置、看门狗自愈、Tailscale 方案 C 已上线 | `scripts/backup/*`、`docs/ops/*` |

### A.2 部分完成（V2.0 需升级）

| 域 | 已有 | 缺口 |
| --- | --- | --- |
| 客户画像 | 字段集齐全、4 字段核实状态（currentSystem/contractExpiry/purchaseTime/decisionMaker）、详情页状态徽章 | ① 核实状态仅 4 字段，V2.0 要求"每个重要字段"；② 无信息来源/核实人/最近核实时间元数据；③ 值变更不重置核实状态（`leads.ts:221-265` 逐字段独立写）；④ 沟通"本次确认"只置状态**不回写值**（`interaction-write.ts:227-232`） |
| 首页工作台 | 今日三卡（待联系/今日任务/逾期）、本周四指标、建议优先联系（3 规则引擎+理由必显）、最近沟通 10 条 | 无"半年内到期客户"、"画像待完善客户"、"四象限分布"卡片；优先理由不含 6 个月窗口与象限 |
| AI 助手 | 三能力 + 结构化输出 + 红线（AI 零写回，`runner.ts:22`） | 无画像缺口结构化识别、无"与上次沟通对比的变化"、提示词不感知象限/到期窗口 |

### A.3 未完成（V2.0 需新建）

1. **四象限分类**（X：是否新一代手机开单系统；Y：是否愿意沟通了解勤策）——两个轴字段本身都不存在。
2. **软件到期时间规则**（6 个月窗口月度任务 / 未知→画像补充 / 已过期持续核实 / 更新后重算保历史）。
3. **跟进策略配置**（分象限可配置周期，禁止硬编码）与**周期任务自动生成**（含 6 条防重复/优先级/停止规则）。

---

## B. 差距分析（新业务要求 vs 现状）

| V2.0 要求 | 现状 | 差距与影响 |
| --- | --- | --- |
| 画像：基础信息（城市/行业/主营品类/营收区间/业务员数） | 全部已有列 | 无差距 |
| 画像：业务信息（访销/车销、业务流程、业务管理情况） | `salesMode` 已有；后两项无 | 新增 2 个可空文本列 |
| 画像：软件信息（当前系统、**是否新一代**、到期时间） | `currentSystem`、`contractExpiry` 已有；"是否新一代"无 | **新增象限 X 轴字段**（含核实状态）；到期时间复用 `contractExpiry`（展示名统一为"软件到期时间"） |
| 画像：意愿信息（**是否愿意沟通了解勤策**、痛点、换系统意愿） | `knownPains`、`consideringSwitch` 已有；沟通意愿无 | **新增象限 Y 轴字段**（含核实状态） |
| 画像：决策信息（决策人/流程/预算/采购时间） | 全部已有列 | 无差距 |
| 每个重要字段：值+核实状态+来源+最近核实时间+核实人 | 仅 4 字段有状态；无来源/人/时间 | **新增统一核实元数据表**（见 D），并把状态覆盖扩展到全部重要字段 |
| 未知/待核实 ≠ 否 | 枚举三态已有且 AI 快照带提示 | 已满足，新引擎必须沿用（象限未确认→画像待完善，不落象限） |
| 四象限分类（双维确认才生成，未知→画像待完善） | 无 | 新建分类引擎 + `leads.quadrant` + 事件留痕 |
| 到期 ≤6 个月→每月任务 | 无（仅 30 天展示提示） | 新建到期月度任务生成，period 级防重 |
| 到期未知→画像补充任务 | 无 | 新建 profile_gap 任务源 |
| 已过期→持续核实不自动退出 | 无 | 到期月度任务对已过期客户持续生成，直至核实更新或阶段 won/closed |
| 到期更新→重算未来任务、保留历史 | 无 | 重算 = 仅取消未开始的自 动任务再生成；done/canceled 永不动 |
| 四象限差异化周期、可配置不硬编码 | 无 | 新建 `followup_strategies` 表 + 设置页管理 |
| 6 条任务生成规则（见提示词四-明确处理 1–6） | 无自动生成 | 新建生成引擎（见 H，逐条映射机制） |
| 首页六块（今日应跟进/半年到期/画像待完善/逾期/四象限分布/优先联系+原因） | 已有 3.5 块 | 增 3 块 + 优先理由扩展 |
| AI 五能力 + 不许未经确认改关键字段 | 已有 3 能力 + 红线已满足 | 提示词/输入/输出升级（见 I），红线零改动 |
| 服务端实现所有规则 | 全部业务规则已在服务端 | 新规则同样落 `src/server/services` |
| 新规则必须有自动化测试 | 三层测试体系成熟 | 每阶段验收含测试（见 J） |

---

## C. 数据库可复用部分及需调整字段

### C.1 完全复用（零改动）

`users / sessions / audit_logs / lead_stages（含 won、closed 锚点）/ lead_field_defs / lead_events / import_batches / import_rows / export_files / interactions / model_configs / prompt_templates / prompt_versions / ai_runs / work_time_entries / experiments / experiment_assignments` —— 共 17 张表不动。线索 ID、沟通历史、任务记录、AI 调用历史全部保留。

### C.2 `leads` 表：复用列 → V2.0 画像字段映射

| V2.0 画像字段 | 复用列 | 说明 |
| --- | --- | --- |
| 城市/行业/主营品类/营收区间/业务员数量 | `city/industry/main_category/revenue_range/sales_team_size` | 直用 |
| 访销/车销 | `sales_mode` | 直用 |
| 当前使用软件 | `current_system` | 直用 |
| 软件到期时间 | `contract_expiry`（@db.Date） | **语义即软件到期**，UI 文案统一"软件到期时间"，列不改 |
| 当前痛点 / 换系统意愿 | `known_pains / considering_switch` | 直用 |
| 决策人/决策流程/预算/采购时间 | `decision_maker/decision_process/budget/purchase_time` | 直用 |
| 最近/下次联系、阶段、优先级、备注 | 管理组列 | 直用 |

### C.3 `leads` 表需新增列（全部可空、增量）

| 新列 | 类型 | 用途 |
| --- | --- | --- |
| `is_next_gen_system` | Boolean? | X 轴：是否新一代手机开单系统 |
| `willingness` | enum `lead_willingness`（yes/no）? | Y 轴：是否愿意沟通了解勤策 |
| `quadrant` | enum `lead_quadrant`（a/b/c/d）? | 四象限结果；NULL = 画像待完善 |
| `quadrant_computed_at` | Timestamptz? | 最近一次分类计算时间 |
| `business_process` | VarChar(255)? | 业务流程（画像-业务信息） |
| `business_management` | VarChar(255)? | 业务管理情况（画像-业务信息） |

### C.4 `tasks` 表需新增列（增量，旧数据不受影响）

| 新列 | 类型 | 用途 |
| --- | --- | --- |
| `source` | enum `task_source`（manual/periodic/expiry_monthly/profile_gap），**default manual** | 任务来源；存量任务迁移时即默认 manual |
| `strategy_id` | Uuid? → followup_strategies | periodic 任务记录所用策略（快照另存 period_key，策略改名不影响历史语义） |
| `period_key` | VarChar(16)? | 防重键：expiry_monthly 用 `YYYY-MM`；periodic/profile_gap 用固定哨兵 `'open'` |

### C.5 既有 4 个 `*_status` 列的处理（关键取舍）

现状：`current_system_status / contract_expiry_status / purchase_time_status / decision_maker_status` 四列被优先级规则（`priority.ts:128-132`）、AI 输入快照（`context.ts:96-114`）、详情页徽章三处读取。

**方案（最低风险增量）**：新建 `lead_field_verifications` 作为**核实元数据唯一权威**（状态+来源+核实人+核实时间），迁移时从 4 列回填初始行；4 个旧列**保留并在同一事务内同步写**（防旧读取点漂移），标记 deprecated，V2.1 再择机下线。读写统一走新服务函数 `getFieldVerifications(leadId)`。

---

## D. 新增数据库表与迁移方案

### D.1 新表 1：`lead_field_verifications`（字段级核实元数据）

```prisma
model LeadFieldVerification {
  id         String      @id @default(uuid(7)) @db.Uuid
  leadId     String      @map("lead_id") @db.Uuid
  fieldKey   String      @map("field_key") @db.VarChar(64)   // 白名单 key，如 current_system / is_next_gen_system
  status     fact_status @default(unknown)                    // 复用既有枚举 unknown/unverified/confirmed
  source     verification_source @default(manual)             // manual / import / interaction / initial
  verifiedBy String?     @map("verified_by") @db.Uuid         // 逻辑关联 users（同 audit_logs 惯例）
  verifiedAt DateTime?   @map("verified_at") @db.Timestamptz(6)
  note       String?     @db.VarChar(255)
  createdAt  / updatedAt
  @@unique([leadId, fieldKey])
  @@index([leadId])
}
```

- **覆盖白名单**（"重要字段"，约 15 个）：`city, industry, main_category, revenue_range, sales_team_size, sales_mode, business_process, business_management, current_system, is_next_gen_system, contract_expiry, willingness, known_pains, considering_switch, purchase_time, budget, decision_maker, decision_process`。
- 写入点（全部同事务）：① 线索创建/编辑（source=manual，改值自动置 unverified + 记核实人/时间——修复"值变更不重置状态"缺陷）；② 导入确认（source=import，状态 unverified）；③ 沟通"本次确认"（source=interaction，置 confirmed）；④ 迁移回填（source=initial）。

### D.2 新表 2：`followup_strategies`（跟进策略配置，禁止硬编码）

```prisma
model FollowupStrategy {
  id            String   @id @default(uuid(7)) @db.Uuid
  quadrant      lead_quadrant @unique                            // a/b/c/d 每象限一条
  name          String   @db.VarChar(64)
  intervalDays  Int      @map("interval_days")                   // >0
  taskType      task_type @default(follow_up)                    // 复用既有任务类型枚举
  titleTemplate String   @map("title_template") @db.VarChar(128) // 如"周期跟进：{客户名}（D 类）"
  isActive      Boolean  @default(true) @map("is_active")
  updatedBy     String?  @map("updated_by") @db.Uuid
  createdAt / updatedAt
}
```

- seed 幂等预置 4 行默认值（**仅为初始值，管理员可改**）：A=30 天、B=60 天、C=14 天、D=90 天（C 类"未用新一代 + 有意愿"是最优目标故最短）。
- 修改走管理员 API + audit_logs 留痕；停用（isActive=false）= 该象限不再生成 periodic 任务（到期月度任务不受影响，它是硬规则）。

### D.3 新表 3：`next_gen_systems`（新一代系统名单，辅助 X 轴确认）

```prisma
model NextGenSystem {
  id        String   @id @default(uuid(7)) @db.Uuid
  name      String   @unique @db.VarChar(128)   // 与 current_system 精确匹配（不区分大小写）
  isActive  Boolean  @default(true)
  createdBy / createdAt
}
```

作用：`current_system` 命中名单时，表单/详情页提示"疑似新一代系统"，**一键带入** `is_next_gen_system=true`（仍需人工保存确认——满足"未知不能当否/是"）。名单初始为空，管理员录入。

### D.4 迁移方案（单个增量迁移 + seed 扩展，可回滚）

一个迁移文件（对齐现有命名风格，如 `2026xxxx_t02_v2_profile_quadrant_strategy`）：

1. `CREATE TYPE lead_quadrant / lead_willingness / task_source / verification_source`；`ALTER TYPE lead_event_type ADD VALUE 'quadrant_changed'`（PostgreSQL 枚举加值安全，不可逆但纯增量）。
2. `leads` 加 6 列（C.3）；`tasks` 加 3 列（C.4，source 默认 manual → 存量任务自动归类手工任务）。
3. 建 3 张新表 + 索引；`tasks` 防重部分唯一索引：
   `CREATE UNIQUE INDEX tasks_periodic_one_pending ON tasks(lead_id) WHERE source='periodic' AND status='pending'`
   `CREATE UNIQUE INDEX tasks_expiry_monthly_unique ON tasks(lead_id, period_key) WHERE source='expiry_monthly' AND status='pending'`
   `CREATE UNIQUE INDEX tasks_profile_gap_one_pending ON tasks(lead_id) WHERE source='profile_gap' AND status='pending'`
4. **回填**（SQL 内完成）：`lead_field_verifications` 从 4 个旧 status 列生成 initial 行；`quadrant` 不回填（存量客户一律"画像待完善"，符合"未知不得强制归类"）。
5. seed.ts 幂等追加：4 条默认策略 +（名单空表）。`npm run db:seed` 对已存在行跳过，不破坏现有数据。

**约束自检**：无删列、无改列类型、无重命名 → 满足"增量迁移、不推翻现有库"；`prisma migrate dev` 生成后走既有 `db:deploy` 通道；备份脚本无需改（pg_dump 全库逻辑备份覆盖新表）。

---

## E. 页面改造方案

| 页面 | 改造内容 |
| --- | --- |
| **首页** `/` | 现有 4 块保留；新增 3 卡：①"半年内到期客户"（0–6 个月，点击进过滤列表）②"已过期待核实" ③"画像待完善客户"；新增"四象限分布"条形/四格块（A/B/C/D 计数 + 画像待完善计数，点击按象限过滤）；"建议优先联系"理由扩展：新增"软件 6 个月内到期（含已过期）""C 类高价值象限""画像缺口 ≥N 项"三类理由（复用现有理由引擎结构 `src/lib/metrics.ts:182-214`，权重高于现有"30 天到期"规则或直接替换之——实施时以 6 个月规则取代 30 天展示规则，避免双口径） |
| **客户列表** `/leads` | 筛选新增：象限（A/B/C/D/画像待完善）、到期窗口（6 个月内/已过期/未知）、画像完整度（可后续迭代）；列表列增加象限徽章与到期列；`buildLeadListWhere`（`leads.ts:578-617`）扩展对应参数 |
| **客户详情** `/leads/[id]` | ① 画像区每重要字段显示"核实徽章 + 来源 + 核实人 + 核实时间"（数据来自 D.1 表，徽章组件复用现有三态样式 `lead-detail-client.tsx:337-347`）；② 新增"分类信息"块：X 轴/Y 轴两字段的值+状态+象限结果大徽章（含"为何是待完善"提示：缺哪个维度的确认）；③ 编辑表单（LeadForm）新增 6 个画像字段与核实状态；④ AI 区新增能力入口（见 I） |
| **沟通表单** | "本次确认"区扩展：确认当前系统（含是否新一代）、软件到期时间、沟通意愿——确认即**同时写值 + 置 confirmed + 记核实元数据**（修复现状只置状态不写值的缺口）；勾选项复用现有 `confirmCurrentSystem/confirmPurchaseTime` 模式（`interaction-write.ts:227-232`）扩展 |
| **任务页** `/tasks` | 任务行显示来源徽章（周期/到期/画像补充/手工）；筛选增加来源维度；逾期视图不变 |
| **设置页** `/settings` | 管理员段新增两块：①"跟进策略"（四象限卡片：周期天数/任务类型/标题模板/启停，保存即审计）②"新一代系统名单"（增删启停） |

---

## F. API 改造方案（全部服务端实现规则）

| API | 改造 |
| --- | --- |
| `POST/PATCH /api/leads(/{id})` | 入参 schema 增 6 个画像字段；服务端同事务写 `lead_field_verifications`（改值→unverified+核实人/时间）；X/Y 轴或到期字段变更后触发 `reevaluateQuadrant` + `recalcLeadPlan` |
| `GET /api/leads` | 筛选参数增加 `quadrant`（含 pending 值）、`expiryWindow`（within_6m / expired / unknown）；排序参数本期不加（维持 updatedAt desc，象限筛选优先） |
| `POST /api/leads/{id}/interactions` | "本次确认"扩展（见 E 沟通表单）；确认轴字段→同事务重算象限+重算任务计划 |
| `GET /api/dashboard/summary` | 返回体新增 `expirySixMonths`、`expiredLeads`、`profilePending`、`quadrantDistribution{a,b,c,d,pending}`；`priorities` 理由结构扩展；**该 API 内先执行惰性任务生成** `ensureTasksGenerated(viewer)`（见 H） |
| `GET /api/tasks` | 服务端同样先跑 `ensureTasksGenerated`；筛选参数增加 `source` |
| `GET/PUT /api/settings/followup-strategies`（新） | 管理员专用；PUT 校验 intervalDays>0；改动后对所有命中象限客户触发计划重算（批量异步防超时） |
| `GET/POST/DELETE /api/settings/next-gen-systems`（新） | 管理员专用名单维护 |
| `POST /api/tasks/generate`（新，可选） | 管理员手动全量触发生成（幂等），弥补惰性触发盲区 |
| AI 三 API | 入参不变；`POST /api/ai/runs` 的 run_type 语义不变（见 I） |

既有约束全部沿用：Zod v4 宽松 UUID 正则、线索 owner 恒=创建人、`items` 响应键、CSRF Origin、权限层判定归属。

---

## G. 四象限计算规则

**纯函数** `evaluateQuadrant(input)`（放 `src/lib/quadrant.ts`，单测友好）：

```
输入：x = { value: is_next_gen_system|null, status }, y = { value: willingness|null, status }
规则：
1. x.status ∈ {unknown, unverified} 或 y.status ∈ {unknown, unverified}
   或 x.value = null 或 y.value = null
   → 返回 { quadrant: null, reason: 'profile_pending', missing: [缺失维度] }   // 画像待完善
2. x.status = confirmed 且 y.status = confirmed：
   A = x:true  + y:yes
   B = x:true  + y:no
   C = x:false + y:yes
   D = x:false + y:no
3. 单侧 confirmed、另一侧 unverified → 仍是画像待完善（不预判）
```

**计算与落库**（`src/server/services/quadrant.ts`）：
- 触发点：线索编辑保存、沟通记录"本次确认"轴字段、（仅展示用途的）详情页读取——一律服务端。
- 写入：`leads.quadrant + quadrant_computed_at`，同事务追加 `lead_events`（eventType=`quadrant_changed`，detail 含 `{from, to, basis:{x,y 及其 status}}` 快照）——沿用阶段变更快照模式（`lead_events.stage_snapshot` 惯例）。
- **未确认永不归类**：未知≠否、待核实≠否，直接由规则 1 保证。
- 分类变化 → 调 `recalcLeadPlan(leadId)`（见 H-规则 5）。
- 已成交/已关闭客户：象限照常显示，但任务生成被 H-规则 4 拦截。
- 展示：详情页"分类信息"块 + 列表徽章 + 首页分布卡；"画像待完善"是显式第五态（`quadrant IS NULL`），有独立入口与筛选值。

---

## H. 周期任务生成规则及防重复机制

### H.1 生成器（`src/server/services/task-generation.ts`）

**触发机制（推荐：惰性 + 手动兜底）**：`GET /api/dashboard/summary` 与 `GET /api/tasks` 时对当前用户名下客户执行 `ensureTasksGenerated(userId)`（幂等，DB 唯一索引兜底）；管理员可 `POST /api/tasks/generate` 全量触发。理由：单实例部署（2–3 账号）无定时器基础设施，惰性触发零新增组件、与"打开工作台即看到当日任务"的行为天然一致；首页/任务页每请求执行一次轻量扫描（按 owner 索引 + 到期索引，量级 <1 万无压力）。

**三类自动任务源**：

| source | 触发条件 | due 计算 | period_key | 防重 |
| --- | --- | --- | --- | --- |
| `expiry_monthly` | `contract_expiry` 已知（status≥unverified 且有值）且 到期日 ≤ 今天+6 个月（**含已过期**，持续生成直到到期时间被更新或阶段 won/closed） | 生成日当天 | `YYYY-MM`（当月） | 唯一索引 (lead_id, period_key) where pending |
| `periodic` | `quadrant ∈ {a,b,c,d}` 且策略 isActive 且到期不满足 expiry_monthly 条件（>6 个月或未知→不叠加） | `anchor + intervalDays`，anchor = max(最后一条沟通 occurredAt, 最后一个完成任务 completedAt, createdAt)；due ≤ 今天即生成、dueAt=今天 | `'open'` | 唯一索引 (lead_id) where pending |
| `profile_gap` | `contract_expiry` 为 null 或 status=unknown | 生成日+3 天 | `'open'` | 唯一索引 (lead_id) where pending |

**expiry_monthly 与 periodic 互斥**：进入 6 个月窗口的客户只走月度节奏（比象限周期更密或相等时不叠加双任务）；离开窗口（到期更新为 >6 个月或核实为已续费）后回到象限周期。

### H.2 提示词"明确处理"6 条 → 机制逐条映射

| # | 要求 | 机制 |
| --- | --- | --- |
| 1 | 已有未完成任务时不重复生成 | 生成前查询该客户**任意 pending 任务**（含手工）存在即跳过所有自动源（唯一索引再兜底并发） |
| 2 | 每客户每周期仅一条有效周期任务 | 三条部分唯一索引（D.4-3）；"有效"=status=pending，任务完成后索引释放，下周期可再生成 |
| 3 | 约定任务优先于普通周期任务 | 手工任务（source=manual，含沟通约定 nextContactAt 生成的任务）天然被规则 1 保护；自动任务标题带"周期/到期"前缀徽章区分，用户可识别并优先处理约定任务 |
| 4 | 已成交/已关闭停止普通线索任务 | 生成器过滤 `stage.semanticKey ∈ {won, closed}`（锚点已存在 `src/lib/stages.ts:52,54`）；已生成的 pending 自动任务在阶段流转到 won/closed 时由 `recalcLeadPlan` 取消 |
| 5 | 分类改变后重新计算后续跟进计划 | `recalcLeadPlan(leadId)`：① 将该客户 pending 且 source≠manual 的任务批量置 canceled（留痕不删）② 重跑三源生成。触发点：象限变化、到期时间变化、阶段流转、策略修改（批量） |
| 6 | 已完成历史任务不能被覆盖或删除 | 生成器只 INSERT；重算只 UPDATE pending→canceled；done/canceled 行任何路径不可改（沿用 C11 不可删除约束）；沟通/完成链路零改动 |

### H.3 到期时间规则专项对照

- **未来 ≤6 个月（含 6 个月整）**：无论象限、无论意愿 → `expiry_monthly` 每月一条（H.1 表）。
- **到期未知** → `profile_gap` 画像补充任务（同时进首页"画像待完善"卡）。
- **已过期**：不自动退出管理——`expiry_monthly` 条件"≤ 今天+6 个月"天然包含过去日期，持续月度生成，任务标题为"核实续费/换系统/停用情况"；直至到期时间被更新（核实新值）或客户进入 won/closed。
- **到期时间更新后**：字段变更触发 `recalcLeadPlan` → 旧 pending 自动任务取消（历史 done 保留）→ 按新到期日重算；全部沟通与任务记录可追溯（事件+任务行都在）。

---

## I. AI 能力升级方案

**基础设施零改动**：模型配置、提示词版本机制（新版本=新增行，历史可复现）、`ai_runs` 留痕、频控 50/日、常规组拦截、发起-轮询全部复用。**run_type 保持 3 个不变**（analysis/call_prep/interaction_summary），避免迁移 ai_runs 枚举与前端面板结构。

### I.1 V2.0 五项能力 → 落点

| V2.0 要求 | 落点 | 改造 |
| --- | --- | --- |
| 1 识别画像缺口 | **analysis v2** | ① 输入白名单（`context.ts`）增加：象限及双维状态、6 个月到期窗口标记、`lead_field_verifications` 汇总（哪些字段 unknown/unverified）② 输出 schema 新增 `profile_gaps: [{field, reason, priority}]≤8` |
| 2 生成下次电话需核实的问题 | **analysis v2** | 现有 `verify_questions ≤10` 升级为**按缺口定向**：prompt 要求问题必须对应 profile_gaps 中的字段，输出保持 `questions: [{field, question}]` |
| 3 电话准备卡（按分类和历史沟通） | **call_prep v2** | 输入增加象限、到期窗口、意愿、最近 5 次沟通（已有）；prompt 分象限/分场景策略（如 C 类=价值切入、到期客户=续费窗口、D 类=低打扰破冰）；输出结构不变（goal/opening/diag_questions/objections/confirm_next/avoid） |
| 4 总结最近沟通中的需求与变化 | **interaction_summary v2** | 输入已含最近 5 次沟通；输出 schema 新增 `changes: [{topic, from, to}]≤5`（与既往沟通对比的变化点）；采纳流程不变（摘要+next_action 回填表单，人工确认保存） |
| 5 推荐下一步沟通动作 | **analysis v2**（next_action，已有）+ summary 的 next_action（已有） | prompt 结合象限策略建议动作节奏（如"A 类建议 30 天内约演示"），仅建议 |

### I.2 红线（不变并强化展示）

- `runner.ts:22` "AI 输出只写 ai_runs.output，绝不触发业务表写操作"——**保持原样**，新 run 一样零写回。
- 画像缺口、问题、建议全部**只读展示 + 复制**；唯一落地通道仍是 interaction_summary 草稿→人工确认保存（`resolveAiDraftRunId` 校验链不变）。
- 详情页 AI 面板加固定文案："AI 建议不会自动修改客户字段、分类、到期时间或销售阶段；采纳需人工确认"。象限/到期/阶段字段无任何 AI 写入路径（服务端 schema 层面就不存在该入参）。
- 输入快照继续排除 contact_phone；新增的 verifications 汇总不含核实人姓名（只含状态），符合最小化原则。

### I.3 提示词版本落地

- `prompt-registry` 按 run_type 取最高版本机制现成：为三个 run_type 各发一个 v2 `PromptVersion` 行 + 对应 `outputSchema` 更新（validator.ts 三 schema 扩展字段，向后兼容旧 output 展示）。
- 设置页"提示词模板"管理块可直接编辑 v2 内容（无需新页面）。

---

## J. 分阶段开发计划和验收标准

沿用 V1.0 任务制（README 每任务一节 + 冒烟脚本 + 推送门）。依赖顺序：T01→T02→(T03,T04 可并行)→T05→(T06,T07 可并行)→T08。

| 任务 | 内容 | 验收标准（全部自动化测试覆盖） | 预估 |
| --- | --- | --- | --- |
| **V2-T01** 数据库与核实元数据底座 | D.4 迁移 + 3 新表 + `lead_field_verifications` 服务（写入点①②④）+ `evaluateQuadrant` 纯函数 + 回填 | ① 迁移在开发库/空库均可 deploy，存量数据零丢失（ID/沟通/任务/AI 历史抽验一致）② 回填后 4 字段元数据与旧列一致 ③ 改值自动置 unverified+记录核实人/时间（集成测试）④ `evaluateQuadrant` 全分支单测（含"单侧 confirmed 仍待完善"）⑤ 存量客户 quadrant 全 NULL | 1.5 天 |
| **V2-T02** 画像字段升级 | leads API/表单/详情/导入导出/列表支持 6 新字段 + 字段级核实展示 + 沟通"本次确认"扩展（写值+置 confirmed+元数据，同事务重算象限） | ① 新字段空值可保存（不强迫填假数据）② 确认动作：值+状态+来源+人+时间五元组齐变（集成测试断言 DB）③ 导入映射含新字段 ④ next_gen 名单命中提示带入但不自动保存 | 2 天 |
| **V2-T03** 四象限引擎与展示 | quadrant 落库 + `quadrant_changed` 事件 + 详情分类块 + 列表/首页筛选徽章 | ① 双维 confirmed 才出象限；任一维改动回 unknown → 象限清空回待完善 + 事件留痕 ② 事件含 from/to/basis 快照 ③ 列表按 5 值筛选正确（SQL 对账测试，仿 leads-list） | 1 天 |
| **V2-T04** 跟进策略配置 | followup_strategies CRUD API + 设置页管理块 + next_gen_systems 管理 + audit 留痕 | ① 仅管理员可写（销售 403）② intervalDays≤0 拒绝 ③ 改策略触发命中客户计划重算（异步，日志可查）④ 4 条默认 seed 幂等 | 1 天 |
| **V2-T05** 周期任务生成引擎 | H 全部：三源生成 + 惰性触发 + 手动触发 + recalcLeadPlan + 6 规则 | **逐条集成测试**：① 有 pending 任务不生成 ② 唯一索引并发防重（两并发仅 1 条）③ 手工任务在场时自动源跳过 ④ won/closed 停止且已生成 pending 被取消 ⑤ 象限变化→旧自动任务取消+新周期任务生成、done 历史不变 ⑥ 到期 6 个月边界（恰好 6 个月整→生成；6 个月+1 天→不生成）、已过期持续生成、未知→profile_gap、到期更新→重算 | 3 天 |
| **V2-T06** 首页升级 | E-首页 3 新卡 + 四象限分布 + 优先理由扩展（6 个月规则取代 30 天规则） | ① 各卡计数与 SQL 对账 ② 全部卡片可点击进入对应过滤列表 ③ 优先理由必显且可解释（引擎单测扩权重新排序）④ 打开首页即触发惰性生成（无 pending 时当月到期客户出现任务） | 1.5 天 |
| **V2-T07** AI 升级 + 全链路验收 | I 全部：context/validator/prompts v2 + 详情展示升级 + E2E 扩展 + 文档 | ① analysis v2 输出 profile_gaps 与 questions 且缺口字段与真实 unknown 字段一致（mock provider 测试）② summary v2 输出 changes ③ call_prep v2 分象限场景 ④ 三个 v2 输出过 validator、旧版本 output 仍可查看 ⑤ AI 全链路仍零业务写回（grep+测试断言）⑥ E2E 核心闭环扩至：导入→补画像→确认象限→到期任务生成→AI→沟通确认→任务完成 ⑦ README/docs 更新 | 2.5 天 |

**总计约 12.5 人日**。每任务完成跑标准推送门：lint → typecheck → `npm run test` → `test:integration`（migrate deploy + seed 前置）→ build + start + 冒烟 + `test:e2e`。

---

## 待产品负责人确认的决策点

1. **X 轴确认方式**：是否采用"新一代系统名单表辅助 + 人工确认"（本方案推荐），还是纯人工勾选？
2. **四象限默认周期**：A=30 / B=60 / C=14 / D=90 天是否合适？（上线后管理员随时可改）
3. **任务生成触发机制**：惰性触发（打开首页/任务页时）+ 管理员手动按钮（本方案推荐，零新增组件），还是引入进程内定时器？
4. **优先级 30 天规则去留**：V2.0 的"6 个月到期"是否直接取代现有"30 天内到期（confirmed）"优先理由（本方案推荐取代，避免双口径）？
5. **新增业务信息两字段**（业务流程/业务管理情况）为自由文本，是否本期纳入（推荐纳入，成本低）？

**确认后即可按 V2-T01 → T08 顺序进入实施。**
