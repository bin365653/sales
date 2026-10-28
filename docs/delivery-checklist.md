# V1.0 交付物清单核对（T18 交付，PRD §10 逐项）

> 核对日期：2026-10-28。PRD §10 十一项逐项映射到仓库内交付物与验收锚点。
> 签核栏见文末（供人工核对签字用）。

| # | PRD §10 交付物 | 交付物位置 | 验收锚点 | 核对结果 |
|---|----------------|------------|----------|----------|
| 1 | 可运行的 Web 应用 | 仓库根（Next.js 15）；`docker compose up -d --build` 一键起 | T01 验收：容器入口自动迁移+seed，`/api/health` 200；T18 E2E 类生产环境全绿 | ✅ |
| 2 | 前后端源代码 | `src/`（App Router 页面 + Route Handler + server 服务层）；`prisma/` | `npm run build` 零错误；lint/typecheck 全绿 | ✅ |
| 3 | 数据库结构与迁移脚本 | `prisma/schema.prisma` + `prisma/migrations/`（10 个版本化迁移） | `prisma migrate deploy` 幂等可重复执行（T01/容器入口验证） | ✅ |
| 4 | `.env.example` | `.env.example`（T18 核对：应用 6 变量 + DATABASE_URL + POSTGRES_* 三项，全部占位符；备份侧独立 `scripts/backup/backup.env.example`） | 无真实密钥入库（§8.3）；生产 compose 缺变量拒启 | ✅ |
| 5 | CSV/Excel 导入模板 | 动态端点 `GET /api/imports/template?format=xlsx\|csv`（始终含启用中自定义字段）；静态副本 `templates/客户导入模板.{xlsx,csv}`（`npm run templates:generate` 生成） | T05 导入验收；E2E 用模板表头实导 | ✅ |
| 6 | AI 提示词模板 | `src/server/ai/prompts/`（analysis/call-prep/interaction-summary 三份基线，含结构化 JSON Schema 与反幻觉约束）；seed 落库版本化 | T08/T09 输出 8+6 项结构校验；空线索"信息不足"不编造（冒烟实测） | ✅ |
| 7 | 自动化测试 | 单元 364（`tests/unit/`）+ 集成 182（`tests/integration/`）+ HTTP 冒烟 7 套（`tests/e2e/*.cjs`、`.verify/` 冒烟脚本）+ Playwright E2E 核心闭环（`tests/e2e/core-loop.spec.ts`） | `npm run test` / `test:integration` / `test:smoke` / `test:e2e` 全绿（数字见 README T18 验收锚点） | ✅ |
| 8 | 本地启动说明 | README「快速开始」三种方式（Docker 一键 / 本地开发 / Windows 便携 PG） | 新人按文档可独立起环境 | ✅ |
| 9 | 部署说明 | `docs/deploy.md`（2C4G 全流程：准备清单/应用/Nginx+HTTPS/备份告警/升级回滚/安全复查/排障）+ `deploy/nginx/qince.conf.example` + `docker-compose.prod.yml` | T17 恢复演练记录（RTO 70.2s / RPO 0）佐证部署链路可用 | ✅ |
| 10 | 数据备份与恢复说明 | `scripts/backup/`（backup/restore/verify 脚本 + 配置样例 + crontab 样例）+ `scripts/restore-drill.md`（核对清单）+ `docs/deploy.md` §4 + 操作手册 §10（`docs/operations.md`） | T17 独立环境恢复演练通过并归档（`docs/ops/restore-drill-2026-10-28.md`） | ✅ |
| 11 | 已知问题和后续迭代清单 | `docs/known-issues.md`（依赖审计复核结论 / 设计内取舍 12 项 / 环境注意 6 项 / 迭代候选 8 项） | T16 依赖审计在 T18 交付前复核一致 | ✅ |

## PRD §9 验收标准对照（摘要）

自动化覆盖锚点（详细口径见各 README 任务章节）：

- **客户管理**：导入/错误行原因/重复检出/搜索筛选编辑历史 —— T05 冒烟 +
  集成 `imports-flow` / `leads-list`；E2E 步骤②③覆盖实导实查。
- **AI 功能**：分析+准备卡生成/事实推断未知区分/信息不足不编造/失败不影响
  页面/复制重生成历史 —— T08–T10 集成与冒烟；E2E 步骤④覆盖两类 run 渲染
  （Mock Provider 输出经真实 Validator 校验）。
- **沟通和任务**：详情页新增记录/下次联系生成任务/完成保留时间/阶段可追溯
  —— T06/T07 集成（事务回滚对账）；E2E 步骤⑤⑥覆盖 AI 草稿确认、K4 推进、
  完成弹窗单事务。
- **数据分析**：口径与手工计算一致/分母 0 显示"—"/筛选影响统计/分组对比
  —— `tests/integration/analytics.test.ts` 固定数据集逐项对账 + T13/T14 集成；
  口径成文 `docs/metrics.md`。
- **安全**：未登录拒绝/用户隔离/源码无密钥/导出权限 —— T02 权限集成 +
  T16 渗透冒烟 50 项（CSRF/越权/注入/超大文件/恶意公式/限流/Cookie 标志）。

## 签核

| 角色 | 姓名 | 日期 | 结论 |
|------|------|------|------|
| 交付人（开发） | | 2026-10-28 | 交付物齐备，自动化验收全绿 |
| 验收人 | | | （待签字） |
