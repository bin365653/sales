#!/usr/bin/env bash
# 每日备份主脚本（T17，实施计划 §8.4 / §9 T17）
#   pg_dump（自定义格式）→ age 加密 → 本地保留 7 份 →（可选）rclone 异地上传
#   成功/失败均写日志；失败另经 notify.sh 发邮件告警（成功只写日志）。
# 用法：bash scripts/backup/backup.sh
#   定时执行见 scripts/backup/crontab.example；配置见同目录 backup.env.example。
# 一致性说明：pg_dump 基于 MVCC 快照，导出期间业务可持续写入，无需停应用。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_FILE="${BACKUP_ENV:-$SCRIPT_DIR/backup.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

PG_MODE="${PG_MODE:-container}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
POSTGRES_USER="${POSTGRES_USER:-qince}"
POSTGRES_DB="${POSTGRES_DB:-qince_sales}"
COMPOSE_PROJECT_DIR="${COMPOSE_PROJECT_DIR:-$REPO_ROOT}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"
BACKUP_KEEP_REMOTE="${BACKUP_KEEP_REMOTE:-28}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$BACKUP_DIR/backup.log"
mkdir -p "$BACKUP_DIR"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG_FILE"; }

notify_failure() {
  local line="${1:-?}" err="${2:-未知错误}"
  rm -f -- "${TMP_FILE:-/nonexistent}"   # 失败时不留半截明文
  log "backup_fail ts=$TS at_line=$line err=$err"
  if printf '%s\n' \
      "备份失败（$(date -u +%FT%TZ) UTC）" \
      "主机: $(hostname 2>/dev/null || echo '?')" \
      "时间戳: $TS  失败位置: 行 $line" \
      "错误: $err" \
      "日志: $LOG_FILE" \
    | bash "$SCRIPT_DIR/notify.sh" failure "backup failed at $TS"; then
    log "alert_sent=1"
  else
    log "alert_sent=0（告警发送本身失败，请人工检查 SMTP 配置）"
  fi
}
trap 'rc=$?; notify_failure "$LINENO" "命令失败（退出码 $rc）"' ERR

START_TS="$(date +%s)"

# ---- 1. 导出（自定义格式，一致性快照）----
DUMP_FILE="$BACKUP_DIR/qince_sales_$TS.dump"
TMP_FILE="$BACKUP_DIR/.tmp-qince_sales_$TS.dump"

compose_pg() {
  # 在 postgres 容器内执行传入的命令（stdin 可透传）
  local dirs=()
  local f
  for f in ${COMPOSE_FILES:-docker-compose.yml}; do
    dirs+=(-f "$f")
  done
  (cd "$COMPOSE_PROJECT_DIR" && docker compose "${dirs[@]}" exec -T "$POSTGRES_SERVICE" "$@")
}

if [ "$PG_MODE" = "container" ]; then
  log "dump_start mode=container db=$POSTGRES_DB"
  compose_pg pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$TMP_FILE"
elif [ "$PG_MODE" = "host" ]; then
  : "${PG_DUMP_BIN:?host 模式需配置 PG_DUMP_BIN（backup.env）}"
  : "${PGHOST:?host 模式需配置 PGHOST/PGPORT/PGDATABASE/PGUSER}"
  : "${PGUSER:?host 模式需配置 PGUSER}"
  : "${PGDATABASE:?host 模式需配置 PGDATABASE}"
  log "dump_start mode=host db=$PGDATABASE host=$PGHOST"
  PGPASSWORD="${PGPASSWORD:-}" "$PG_DUMP_BIN" \
    -h "$PGHOST" -p "${PGPORT:-5432}" -U "$PGUSER" -d "$PGDATABASE" -Fc > "$TMP_FILE"
else
  notify_failure "$LINENO" "PG_MODE 非法: $PG_MODE（仅 container|host）"
  exit 1
fi

if [ ! -s "$TMP_FILE" ]; then
  notify_failure "$LINENO" "pg_dump 产物为空"
  exit 1
fi

# ---- 2. 归档完整性自检（pg_restore -l 能读出目录即归档头完好）----
if [ "$PG_MODE" = "container" ]; then
  cat "$TMP_FILE" | compose_pg pg_restore -l > /dev/null
else
  if [ -n "${PG_RESTORE_BIN:-}" ]; then
    "$PG_RESTORE_BIN" -l "$TMP_FILE" > /dev/null
  fi
fi
log "dump_done file=$(basename "$TMP_FILE") bytes=$(wc -c < "$TMP_FILE" | tr -d ' ')"

# ---- 3. age 加密（未配置时显式 WARN，不静默降级）----
ENCRYPTED=no
FINAL_FILE="$DUMP_FILE"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  AGE_BIN="${AGE_BIN:-age}"
  "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$DUMP_FILE.age" "$TMP_FILE"
  rm -f "$TMP_FILE"
  FINAL_FILE="$DUMP_FILE.age"
  ENCRYPTED=yes
  # 解密自检：配置了身份文件时验证可还原（防"密文读不回"）
  if [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]; then
    "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY_FILE" -o /dev/null "$FINAL_FILE"
    log "encrypt_ok decrypt_selfcheck=passed"
  else
    log "encrypt_ok decrypt_selfcheck=skipped（未配置 BACKUP_AGE_IDENTITY_FILE）"
  fi
else
  mv "$TMP_FILE" "$DUMP_FILE"
  log "encrypt_skipped=WARN 未配置 BACKUP_AGE_RECIPIENT，本次备份为明文（§8.4 要求加密，请尽快配置）"
fi

# ---- 4. 本地保留（BACKUP_KEEP_LOCAL 份，文件名时间戳即排序）----
if [ "$BACKUP_KEEP_LOCAL" -gt 0 ] 2>/dev/null; then
  REMOVED=0
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    rm -f -- "$BACKUP_DIR/$old"
    log "retention_local removed=$old"
    REMOVED=$((REMOVED + 1))
  done < <(ls -1 "$BACKUP_DIR" 2>/dev/null \
    | grep -E '^qince_sales_[0-9]{8}T[0-9]{6}Z\.dump(\.age)?$' \
    | sort | head -n "-$BACKUP_KEEP_LOCAL" || true)
  log "retention_local_done kept=$BACKUP_KEEP_LOCAL removed=$REMOVED"
fi

# ---- 5. 异地上传（rclone；本地 MVP 留空即跳过）----
UPLOADED=no
if [ -n "${RCLONE_REMOTE:-}" ]; then
  RCLONE_BIN="${RCLONE_BIN:-rclone}"
  "$RCLONE_BIN" copy "$FINAL_FILE" "$RCLONE_REMOTE/"
  UPLOADED=yes
  log "upload_ok remote=$RCLONE_REMOTE file=$(basename "$FINAL_FILE")"
  "$RCLONE_BIN" delete --min-age "${BACKUP_KEEP_REMOTE}d" "$RCLONE_REMOTE/" || \
    log "retention_remote=WARN 远端清理失败（不影响本次上传）"
  log "retention_remote_done keep_days=$BACKUP_KEEP_REMOTE"
else
  log "upload_skipped=local_only 未配置 RCLONE_REMOTE（本地 MVP 阶段按 §8.4 仅本地保留）"
fi

DUR=$(( $(date +%s) - START_TS ))
log "backup_ok ts=$TS file=$(basename "$FINAL_FILE") bytes=$(wc -c < "$FINAL_FILE" | tr -d ' ') dur_s=$DUR encrypted=$ENCRYPTED uploaded=$UPLOADED"
log "backup_end"
