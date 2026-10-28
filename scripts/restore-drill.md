# 恢复演练核对清单（T17 验收材料，实施计划 §8.4 / §9 T17）

> 目标：证明"备份存在**且可恢复**"（风险 R8 的硬验收）。每次演练按本清单逐项
> 执行并留痕，记录归档为 `docs/ops/restore-drill-<日期>.md`（提交入库）。
> 恢复目标：RPO ≤ 24h（每日全量）、RTO ≤ 4h（脚本化恢复 + 应用重启）。

## 1. 演练环境要求

- **独立环境**：与生产隔离的 PostgreSQL 实例（独立端口 + 独立数据目录 +
  独立库名），绝不指向生产库；演练机上若用同一 PostgreSQL 服务，必须用不同端口。
- 客户端工具可用：`pg_restore` / `createdb`（大版本 ≥ 服务端，host 模式），
  或生产走容器内工具（container 模式）。
- age 身份文件（解密 `.age` 备份用）与备份产物可获取；身份文件用后从演练环境清除。
- 应用构建产物可启动（`npm run build` 产物或镜像）。

## 2. 演练步骤（每步记录实际时刻）

| # | 步骤 | 命令要点 | 记录 |
|---|------|----------|------|
| 0 | 声明灾难时刻 T0 | `date +%FT%T` | ____ |
| 1 | 准备独立实例 | `initdb -D <新数据目录> -U qince -A trust -E UTF8` + `pg_ctl -o "-p <独立端口>" start`（或新 compose 项目） | 端口/目录 ____ |
| 2 | 恢复数据库 | `bash scripts/backup/restore.sh <备份文件> --target-db qince_drill` | 开始/结束 ____，耗时 ____s |
| 3 | 数据核验（本清单 §3） | `npx tsx scripts/backup/verify-restore.ts --source <源> --target <目标>` | 通过 ____ 项 / 失败 ____ 项 |
| 4 | 应用拉起 | `DATABASE_URL=<指向恢复库> npm run start`（或容器） | 启动时刻 ____ |
| 5 | 应用验收 | `/api/health` 200；管理员登录成功；线索池/详情/看板页 200；一次写操作成功 | 结果 ____ |
| 6 | 宣告恢复完成 T1 | `date +%FT%T` | RTO = T1 - T0 = ____ |
| 7 | 告警链路（见 §4） | 人为制造一次备份失败（ALERT_DRY_RUN=1） | .eml 生成路径 ____ |
| 8 | 清理 | 停独立实例、删演练数据目录、删临时明文、清身份文件 | 完成 ____ |

## 3. 数据核验核对项（verify-restore.ts 自动覆盖 + 人工抽查）

- [ ] **核心表行数比对**：19 张表（users/sessions/audit_logs/lead_stages/
  lead_field_defs/leads/lead_events/import_batches/import_rows/export_files/
  interactions/tasks/model_configs/prompt_templates/prompt_versions/ai_runs/
  work_time_entries/experiments/experiment_assignments）源库与恢复库逐表一致。
- [ ] **抽样数据校验**：最新一条线索全字段一致（含自定义字段 JSONB、核实状态、
  乐观锁版本）；最新沟通记录全字段一致（含修正留痕 edit_audit）；
  最新 ai_run 的输入快照与输出 JSON 一致。
- [ ] **AI / 实验记录完整性**：提示词版本链（模板×最高版本×条数）一致；
  model_configs 密文列逐字节一致（只报布尔，不显示密文）；
  export_files bytea 字节流一致；实验分组计数（实验×组别）一致。
- [ ] **人工抽查（至少 1 条）**：从恢复库随机取一条业务线索，与备份前业务印象核对
  （名称/阶段/最近沟通内容）。
- [ ] **主密钥分离语义（§8.3）**：恢复库不含主密钥——不带 `APP_ENCRYPTION_KEY`
  启动时业务数据可用，仅模型密钥不可解密（重新录入即可）；主密钥与备份分处
  不同介质。演练中确认备份产物内无主密钥、无 `.env`。

## 4. 告警链路演练（无 SMTP 账号环境）

1. `backup.env` 设 `ALERT_DRY_RUN=1`；
2. 人为制造失败（如 `PGDATABASE=不存在的库`）执行 `backup.sh`；
3. 确认：退出码非 0；`backups/backup.log` 出现 `backup_fail` 与 `alert_sent=1`；
   `backups/alerts/<时间戳>-failure.eml` 生成且正文含失败行号与时间戳。
   有 SMTP 账号的环境改为真发一封并确认收件（部署前准备清单项）。

## 5. RPO / RTO 记录（归档必填）

| 指标 | 设计目标 | 本次实测 | 说明 |
|------|----------|----------|------|
| RPO | ≤ 24h | ____ | 每日 02:00 全量；演练为备份后立即"灾难"，实测 0；最坏 = 距上次备份间隔 |
| 备份耗时 | — | ____s | 影响备份窗口，不占 RTO |
| RTO | ≤ 4h | ____ | T0（灾难宣告）→ T1（应用验收通过） |
| 其中：恢复 | — | ____s | restore.sh 含解密 |
| 其中：应用拉起+验收 | — | ____s | 启动 + /api/health + 登录 + 关键页 |

## 6. 通过标准（全部满足才算演练通过）

1. §3 自动核验 0 失败；
2. RTO 实测 ≤ 4h、RPO 说明与备份节奏一致；
3. 告警链路产出 .eml（或真实邮件送达）；
4. 本清单各项已填、记录已归档 `docs/ops/restore-drill-<日期>.md` 并提交 Git。
