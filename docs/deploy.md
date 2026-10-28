# 部署文档（T17 交付，实施计划 §8.4/§8.5）

> 目标形态：2C4G 云服务器单机部署——Docker Compose 承载应用与 PostgreSQL 16，
> 前置 Nginx 做 TLS 终止与反向代理；每日 02:00 全量备份（age 加密 + 本地 7 份 +
> rclone 异地上传 4 周）+ 失败邮件告警。本地开发/演示见 README「快速开始」。
> 上线验收前请同步完成恢复演练（`scripts/restore-drill.md`）。

## 1. 部署前准备清单

| 项 | 说明 |
|----|------|
| 服务器 | 2C4G 云主机，Ubuntu 22.04/24.04（或等效），可访问公网拉镜像 |
| 域名 | 一个 A 记录指向服务器 IP（HTTPS 证书与 Origin 校验都依赖固定域名） |
| Docker | Docker Engine ≥ 24 + docker compose plugin（`docker compose version` 验证） |
| 代码 | `git clone` 本仓库到 `/opt/qince`（下文以此路径为例） |
| 主密钥 | `openssl rand -hex 32` 生成 `APP_ENCRYPTION_KEY`；**离线另存一份**，与备份分离存放（§8.3） |
| 管理员口令 | `ADMIN_PASSWORD` 强口令（首次登录后建议再改一次） |
| SMTP 账号 | 用于备份失败告警的发信账号（地址+授权码），部署前准备清单已确认项 |
| age 密钥对 | `age-keygen -o age-identity.txt`；公钥填备份配置，私钥**离线另存**（不与备份同机同处） |
| 对象存储 | 备份异地保留用：rclone 支持的任意远端（S3/OBS/COS/B2…），`rclone config` 建好远端名 |
| PostgreSQL 客户端 | 可选：宿主机装 `postgresql-client-16`（便于人工查库；恢复演练见 `scripts/restore-drill.md`） |

## 2. 应用部署

```bash
cd /opt/qince
cp .env.example .env
vim .env    # 覆盖全部 CHANGE_ME：DATABASE_URL/POSTGRES_*/ADMIN_PASSWORD/APP_ENCRYPTION_KEY
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps    # 等待 postgres healthy、app running
```

- `docker-compose.prod.yml` 与开发用 `docker-compose.yml` 的差异：**不映射 5432**、
  app 只绑 `127.0.0.1:3000`、敏感变量缺失即拒绝启动（`${VAR:?}`）。
- 容器入口（`docker-entrypoint.sh`）自动执行 `prisma migrate deploy`（幂等）与
  seed（13 个预置阶段 + 初始管理员，缺则补建、不覆盖既有配置）。
- 验证初始化：

```bash
curl -fsS http://127.0.0.1:3000/api/health        # 期望 200
curl -fsS -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:3000' \
  -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'
```

## 3. Nginx + HTTPS

1. 安装：`apt install nginx certbot python3-certbot-nginx`（或用 webroot，见下）。
2. 复制配置样例：`cp deploy/nginx/qince.conf.example /etc/nginx/sites-available/qince.conf`
   并把 `<你的域名>` 全部替换；`ln -s` 到 `sites-enabled`。
3. **三处与应用安全机制强耦合的配置不可删**（样例头部有注释）：
   `X-Forwarded-Host`（Origin 校验，缺失会导致写请求 403 `origin_forbidden`）、
   `X-Forwarded-For`/`X-Real-IP`（限流与审计 IP）、
   `client_max_body_size 11m`（应用上传三限 10MB + middleware 硬截断余量）。
4. 签发证书（webroot 方式，80 端口的 acme 路径已在样例中保留）：

```bash
mkdir -p /var/www/certbot
certbot certonly --webroot -w /var/www/certbot -d <你的域名> --agree-tos -m <邮箱> --no-eff-email
nginx -t && systemctl reload nginx
systemctl list-timers | grep certbot    # 自动续期 timer 应存在（certbot 装包自带）
```

5. 验证：浏览器打开 `https://<你的域名>` → 跳登录页；登录后新建/保存一条数据成功
   （写请求 Origin 校验在代理链路上正常 = X-Forwarded-Host 透传正确）。

## 4. 备份与告警部署

```bash
cp scripts/backup/backup.env.example scripts/backup/backup.env
vim scripts/backup/backup.env
```

按注释填写（云上推荐值）：

- `PG_MODE=container`、`COMPOSE_FILES=docker-compose.prod.yml`
- `BACKUP_DIR=/var/backups/qince`（独立数据盘更佳；`mkdir -p` 并确认 root 可写）
- `BACKUP_AGE_RECIPIENT=<age 公钥>`、`BACKUP_AGE_IDENTITY_FILE=<私钥路径>`
  （加密自检会自动验证"密文可解回"；私钥务必另存离线一份）
- `RCLONE_REMOTE=<远端名>:<桶内路径>`（先 `rclone lsd <远端名>:` 验证连通）
- `SMTP_URL/SMTP_USER/SMTP_PASS/ALERT_FROM/ALERT_TO`

手动试跑与安装定时任务：

```bash
bash scripts/backup/backup.sh                 # 立即全量备份一次并观察日志
ls -lh /var/backups/qince                     # 确认 .dump.age 产物与 backup.log
cp scripts/backup/crontab.example /etc/cron.d/qince-backup   # 或 crontab -e
# 修改 /etc/cron.d 里的路径与用户后：systemctl reload cron
```

- 成功只写日志（`backup_ok` 行含耗时/字节数/加密/上传状态）；失败写 `backup_fail`
  并经 SMTP 发邮件（无 SMTP 账号时可 `ALERT_DRY_RUN=1` 验证链路，邮件全文落
  `backups/alerts/*.eml`）。
- 保留策略：本地 7 份、远端 28 天（§8.4）；两者都按脚本自动清理。
- **备份不可用时怎么办**：脚本每步失败都会非零退出并告警——收到告警先看
  `backup.log` 尾部 `backup_fail` 行的定位。
- 恢复与演练：`scripts/backup/restore.sh` + `scripts/backup/verify-restore.ts`，
  核对清单见 `scripts/restore-drill.md`；**上线前至少完成一次真实演练并归档记录**。

## 5. 升级与回滚

- 升级：`cd /opt/qince && git pull && docker compose -f docker-compose.prod.yml up -d --build`
  —— 入口自动补跑新迁移（幂等），seed 不覆盖既有配置。
- 回滚应用：`git checkout <上一发布 tag/commit>` 后重新 `up -d --build`；
  涉及数据库迁移的回滚**不删列不降迁移**（本项目迁移只增不改），异常时以最近
  备份恢复数据（见 restore-drill.md），并向开发确认迁移兼容性。
- 回滚后验证：`/api/health` 200 + 登录 + 一次写操作。

## 6. 上线前安全复查（对照 T16 安全基线）

- [ ] `.env` 全部口令已覆盖默认值；`.env` 不入 Git（已在 .gitignore）
- [ ] 5432 未对公网暴露（`docker compose -f docker-compose.prod.yml` 天然不映射；`ss -ltnp` 复查）
- [ ] 3000 端口只绑回环，公网仅 80/443（云安全组 + `ss -ltnp` 复查）
- [ ] HTTPS 生效且 80 跳转 443；Cookie 为 `Secure`（NODE_ENV=production 自动启用）
- [ ] 登录后执行一次写操作成功（Origin 校验链路通）
- [ ] 备份手动试跑成功且 `.age` 加密生效；失败告警链路验证过
- [ ] 主密钥、age 私钥已离线另存，且不在服务器备份目录内
- [ ] 恢复演练记录已归档（`docs/ops/`）
- [ ] `npm audit` 复核一次（T16 结论：3 条传递依赖通告暂缓升级，交付前复核）

## 7. 常见故障排查

| 现象 | 可能原因与处理 |
|------|----------------|
| 写请求一律 403 `origin_forbidden` | Nginx 未透传 `X-Forwarded-Host`（见 §3 第 3 条） |
| 上传 ~1MB 即失败 | Nginx 未设 `client_max_body_size 11m` |
| 上传近 10MB 返回 500 | 应用版本过旧（T16 前），更新镜像；T16 起应返回 400 `file_too_large` |
| 容器反复重启 | `.env` 缺变量（compose 启动即报 `${VAR:?}`）；`docker compose logs app` 看迁移/seed 报错 |
| 登录连续失败后 429 | 登录限流 5 次/15 分钟（IP+账号），等待窗口或重启应用清空内存窗口 |
| 备份 429/403 无 | 备份走数据库端口不经应用限流；若 `pg_dump` 报认证失败检查 `backup.env` 的账号口令 |
