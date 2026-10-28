#!/usr/bin/env bash
# 失败邮件告警（T17，实施计划 §8.4：备份成功/失败写日志，失败经 SMTP 发邮件告警）
# 用法：notify.sh <failure|info> "<subject>"   （正文自 stdin 读入）
#   真实发信走 curl + SMTP（smtps 或 STARTTLS）；ALERT_DRY_RUN=1 时把完整邮件
#   写入 "$BACKUP_DIR/alerts/<时间戳>.eml"，供无 SMTP 账号环境的链路演练。
# 依赖：curl；配置读 scripts/backup/backup.env（可被 BACKUP_ENV 覆盖）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CONFIG_FILE="${BACKUP_ENV:-$SCRIPT_DIR/backup.env}"
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

LEVEL="${1:?用法: notify.sh <failure|info> <subject>（正文自 stdin）}"
SUBJECT="${2:?缺少邮件主题}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
ALERT_DIR="$BACKUP_DIR/alerts"
ALERT_SUBJECT_PREFIX="${ALERT_SUBJECT_PREFIX:--[qince-backup]}"
mkdir -p "$ALERT_DIR"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
MSG_FILE="$ALERT_DIR/$STAMP-$LEVEL.eml"

BODY_B64="$(base64 | tr -d '\n')"
SUBJECT_ENC="=?UTF-8?B?$(printf '%s' "$ALERT_SUBJECT_PREFIX $LEVEL: $SUBJECT" | base64 | tr -d '\n')?="

{
  printf 'From: %s\r\n' "$ALERT_FROM"
  printf 'To: %s\r\n' "$ALERT_TO"
  printf 'Subject: %s\r\n' "$SUBJECT_ENC"
  printf 'Date: %s\r\n' "$(date -u -R)"
  printf 'MIME-Version: 1.0\r\n'
  printf 'Content-Type: text/plain; charset=utf-8\r\n'
  printf 'Content-Transfer-Encoding: base64\r\n'
  printf '\r\n'
  printf '%s\n' "$BODY_B64" | fold -w 76
} > "$MSG_FILE"

if [ "${ALERT_DRY_RUN:-0}" = "1" ]; then
  echo "[notify] ALERT_DRY_RUN=1：邮件未发送，全文已写入 $MSG_FILE"
  exit 0
fi

: "${SMTP_URL:?SMTP_URL 未配置且 ALERT_DRY_RUN!=1（见 backup.env.example）}"
: "${SMTP_USER:?SMTP_USER 未配置且 ALERT_DRY_RUN!=1}"
: "${SMTP_PASS:?SMTP_PASS 未配置且 ALERT_DRY_RUN!=1}"
: "${ALERT_FROM:?ALERT_FROM 未配置}"
: "${ALERT_TO:?ALERT_TO 未配置}"

curl --silent --show-error --fail \
  --mail-from "$ALERT_FROM" --mail-rcpt "$ALERT_TO" \
  --user "$SMTP_USER:$SMTP_PASS" \
  --upload-file "$MSG_FILE" "$SMTP_URL"

echo "[notify] 告警邮件已发送至 $ALERT_TO（留档：$MSG_FILE）"
