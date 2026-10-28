# 恢复演练记录（T17 验收材料归档）

- 演练日期：2026-10-28（UTC 时间戳为准）
- 依据：`scripts/restore-drill.md` 核对清单
- 结论：**演练通过**。27 项数据核验全部一致，实测 RTO 约 70 秒（目标 ≤ 4h）、
  实测 RPO = 0（设计上限 24h）；告警链路与本地保留策略验证通过。
- 演练人/执行方式：开发者本机自动化执行（Git Bash 脚本链）。

## 1. 演练环境

| 项 | 值 |
|----|-----|
| 源库（"生产"替身） | 本地开发实例 PostgreSQL 16.4，`127.0.0.1:5432/qince_sales`（19 表全有数据：45 用户/8 线索/257 审计/16 模型配置等；另按 drill-data 脚本补入沟通/任务/AI run/实验分组/导入批次各若干，演练后已自清回基线） |
| 独立恢复实例 | PostgreSQL 16.4（EDB Windows x64 同版本），`127.0.0.1:5433`，独立数据目录（演练后已停用并删除） |
| 恢复目标库 | `qince_drill`（独立实例内，不与源库同集群） |
| 工具链 | pg_dump/pg_restore/psql/createdb 16.4 + age v1.2.1（密钥对为演练专用，不入 Git） |
| 备份模式 | host 模式（无 Docker 环境）；生产形态为 container 模式（同一脚本，`PG_MODE=container`） |
| 应用验收 | 生产构建 `next start`（PORT=3100）指向恢复库 |

## 2. 时间线（UTC）

| 时刻 | 事件 |
|------|------|
| 07:24:22.965 | 备份开始（`backup.sh`） |
| 07:24:26.071 | 备份完成：`qince_sales_20261028T072423Z.dump.age`（84,596 字节，age 加密 + 解密自检 passed，本地保留清理，rclone 未配置按本地 MVP 跳过） |
| 07:28:01.839 | **T0 灾难宣告**（执行恢复） |
| 07:28:02.5 | 排障：恢复侧配置文件未建 → 脚本以明确报错快败（`BACKUP_AGE_IDENTITY_FILE` 缺失提示）；补配置重跑 |
| 07:28:14.567 | 恢复重跑：解密 → 自动建库 `qince_drill` → pg_restore |
| 07:28:16.728 | `restore_ok dur_s=2`（shell 实测 2.1s） |
| 07:28:2x | 数据核验：`verify-restore.ts` 27/27 PASS（见 §3） |
| 07:28:5x | 应用拉起：`next start` 指向恢复库（:3100） |
| 07:29:0x | 应用验收：`/api/health` 200、登录 200、`/leads` 与 `/analytics` SSR 200、`/api/leads` 200 |
| 07:29:12.005 | **T1 恢复完成**（写操作 `POST /api/leads` 返回 201 之后） |

**RTO = T1 − T0 = 70.2 秒**（含 12.7 秒排障；成功链路净耗时 ≈ 57 秒）。
**RPO 实测 = 0**（备份后立即宣告灾难）；设计口径：每日 02:00 全量，最坏 RPO ≈ 24h ≤ 目标。

## 3. 数据核验结果（verify-restore.ts，27/27 PASS）

- **核心表行数比对**：19 张表逐表一致（users 45、sessions 77、audit_logs 257、
  lead_stages 13、lead_field_defs 23、leads 8、lead_events 15、import_batches 1、
  import_rows 2、export_files 4、interactions 1、tasks 1、model_configs 16、
  prompt_templates 3、prompt_versions 3、ai_runs 1、work_time_entries 5、
  experiments 1、experiment_assignments 2）。
- **抽样数据校验**：最新一条线索全字段一致（含自定义字段 JSONB/核实状态/乐观锁
  版本）；最新沟通记录全字段一致（含修正留痕 edit_audit）；最新 ai_run 输入快照
  与输出 JSON 一致；最新实验分组明细（规则快照/画像快照）一致。
- **AI / 实验记录完整性**：提示词版本链（3 模板×最高版本×条数）一致；
  model_configs 密文列逐字节一致（last4=7890，未显示明文）；
  export_files bytea 字节流一致（1,309 字节）；实验分组计数一致。
- **人工抽查**：备份前写入的演练数据（"T17 恢复演练抽样"沟通记录）在恢复库中
  原样可读，演练后源库已自清回基线（行数快查与演练前完全一致）。

## 4. 配套链路验证

- **告警链路**：人为制造失败（指向不存在的库）→ 退出码 1、日志
  `backup_fail ts=… at_line=76 err=…`、`alerts/20261028T072951Z-failure.eml`
  生成（From/To/UTF-8 base64 主题与正文齐全，正文含失败行号与日志路径）、
  `alert_sent=1`。真实 SMTP 发送需生产 SMTP 账号（部署前准备清单项，
  `docs/deploy.md` §4）。
- **本地保留策略**：9 个旧文件 + 2 个真实备份 = 11 → 保留最新 7 份
  （清理最旧 4 个）；不匹配命名规范的文件不清理（保守侧设计）。
- **同名防护**：`restore.sh --target-db qince_sales`（与源库同名）被拒绝，
  退出码 2，提示须显式 `RESTORE_ALLOW_OVERWRITE_SOURCE=yes`。
- **主密钥分离语义（§8.3）**：备份产物为纯数据库转储+age 密文，不含 `.env`/
  主密钥/age 私钥；恢复库不携带主密钥——按设计，主密钥丢失时仅模型密钥不可
  解密（重新录入即可），业务数据完整可恢复。
- **异地上传（rclone）**：未实测——本地 MVP 阶段无对象存储远端（§8.4 允许仅
  本地保留）；脚本路径已实现（copy + 28 天 min-age 清理），云端部署时按
  `docs/deploy.md` §4 首跑验证。

## 5. 偏差与说明

1. 演练在本机 Windows（Git Bash）而非 Linux 云服务器：备份/恢复脚本为同一份
   POSIX bash，host 模式即本次演练形态；container 模式（生产）是
   `docker compose exec -T` 透传同一 pg_dump/pg_restore，云端部署时首跑验证。
2. Next.js 请求体 10MB 截断、上传三限等应用层行为与备份链路无关，未重复验证
   （T16 已覆盖）。
3. 演练专用 age 密钥对、备份产物、日志均保留在 `.verify/`（gitignored），
   不构成交付物；交付物为脚本 + 清单 + 本记录。

## 6. 踩坑（已沉淀到 README 踩坑记录 ⑱）

PostgreSQL 二进制安装路径含中文（`D:\项目\…`）时 initdb 引导失败：
`FATAL: invalid byte sequence for encoding "UTF8": 0xcf 0xee`（"项"的 GBK 字节
进入 UTF-8 流）。数据目录放 ASCII 路径**不够**——二进制 + share 全树必须在纯
ASCII 路径。本次将 pgsql 树复制到 `C:\Users\PC\qince-pg16-ascii` 后一切正常。
