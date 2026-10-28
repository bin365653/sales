#!/usr/bin/env bash
# 恢复脚本（T17，实施计划 §8.4：脚本化恢复 + 应用重启，RTO ≤ 4h）
# 用法：bash scripts/backup/restore.sh <备份文件.dump[.age]> --target-db <库名> [--jobs N] [--clean]
#   .age 文件自动解密（需配置 AGE_BIN + BACKUP_AGE_IDENTITY_FILE）。
#   --target-db 必填且不得等于源库名（防误覆盖生产库；确要覆盖见 backup.env 的
#   RESTORE_ALLOW_OVERWRITE_SOURCE）。目标库不存在时自动创建。
# 恢复后核验见 scripts/restore-drill.md 与 scripts/backup/verify-restore.ts。
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

USAGE="用法: restore.sh <备份文件.dump[.age]> --target-db <库名> [--jobs N] [--clean]"

BACKUP_FILE=""
TARGET_DB=""
JOBS=1
CLEAN=no
while [ $# -gt 0 ]; do
  case "$1" in
    --target-db) TARGET_DB="${2:?}"; shift 2 ;;
    --jobs) JOBS="${2:?}"; shift 2 ;;
    --clean) CLEAN=yes; shift ;;
    -h|--help) echo "$USAGE"; exit 0 ;;
    *) if [ -z "$BACKUP_FILE" ]; then BACKUP_FILE="$1"; shift; else echo "多余参数: $1；$USAGE" >&2; exit 2; fi ;;
  esac
done
[ -n "$BACKUP_FILE" ] && [ -n "$TARGET_DB" ] || { echo "$USAGE" >&2; exit 2; }
[ -f "$BACKUP_FILE" ] || { echo "备份文件不存在: $BACKUP_FILE" >&2; exit 2; }
printf '%s' "$TARGET_DB" | grep -Eq '^[A-Za-z0-9_]+$' || { echo "目标库名仅允许字母数字下划线: $TARGET_DB" >&2; exit 2; }

SOURCE_DB="$POSTGRES_DB"
if [ "$PG_MODE" = "host" ]; then SOURCE_DB="${PGDATABASE:-$POSTGRES_DB}"; fi
if [ "$TARGET_DB" = "$SOURCE_DB" ] && [ "${RESTORE_ALLOW_OVERWRITE_SOURCE:-no}" != "yes" ]; then
  echo "拒绝：目标库 [$TARGET_DB] 与源库同名。覆盖式恢复须在 backup.env 显式设置" \
       "RESTORE_ALLOW_OVERWRITE_SOURCE=yes（建议先停止应用再操作）。" >&2
  exit 2
fi

compose_pg() {
  local dirs=() f
  for f in ${COMPOSE_FILES:-docker-compose.yml}; do
    dirs+=(-f "$f")
  done
  (cd "$COMPOSE_PROJECT_DIR" && docker compose "${dirs[@]}" exec -T "$POSTGRES_SERVICE" "$@")
}

restore_conn_host() {  # 输出 host 模式公共连接参数
  printf '%s\n' -h "$PGHOST" -p "${PGPORT:-5432}" -U "${PGUSER:?host 模式需配置 PGUSER}"
}

START_TS="$(date +%s)"

# ---- 1. 解密（.age → 明文临时文件）----
RESTORE_SRC="$BACKUP_FILE"
if printf '%s' "$BACKUP_FILE" | grep -qE '\.age$'; then
  AGE_BIN="${AGE_BIN:-age}"
  : "${BACKUP_AGE_IDENTITY_FILE:?解密 .age 需配置 BACKUP_AGE_IDENTITY_FILE（backup.env）}"
  TMP_PLAIN="$(mktemp "${TMPDIR:-/tmp}/qince_restore_XXXXXX.dump")"
  "$AGE_BIN" -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$TMP_PLAIN" "$BACKUP_FILE"
  RESTORE_SRC="$TMP_PLAIN"
  echo "[restore] 已解密 $(basename "$BACKUP_FILE") → 临时明文（恢复完成后自动删除）"
fi
cleanup() { [ -n "${TMP_PLAIN:-}" ] && [ -f "$TMP_PLAIN" ] && rm -f "$TMP_PLAIN" || true; }
trap cleanup EXIT

# ---- 2. 目标库存在性检查与创建 ----
DB_EXISTS_SQL="SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'"
if [ "$PG_MODE" = "container" ]; then
  if [ "$(compose_pg psql -U "$POSTGRES_USER" -d postgres -tAc "$DB_EXISTS_SQL" | tr -d '[:space:]')" != "1" ]; then
    compose_pg createdb -U "$POSTGRES_USER" -T template0 -E UTF8 "$TARGET_DB"
    echo "[restore] 已创建目标库 $TARGET_DB"
  fi
else
  : "${PSQL_BIN:?host 模式需配置 PSQL_BIN（backup.env）}"
  : "${CREATEDB_BIN:?host 模式需配置 CREATEDB_BIN（backup.env）}"
  if [ "$("$PSQL_BIN" $(restore_conn_host) -d postgres -tAc "$DB_EXISTS_SQL" | tr -d '[:space:]')" != "1" ]; then
    "$CREATEDB_BIN" $(restore_conn_host) -T template0 -E UTF8 "$TARGET_DB"
    echo "[restore] 已创建目标库 $TARGET_DB"
  fi
fi

# ---- 3. 恢复（--no-owner --no-privileges：对象归连接角色所有，与应用账号一致）----
RESTORE_ARGS=(--no-owner --no-privileges -d "$TARGET_DB")
if [ "$CLEAN" = "yes" ]; then
  RESTORE_ARGS+=(--clean --if-exists)
fi
if [ "$JOBS" -gt 1 ] 2>/dev/null; then
  if [ "$PG_MODE" = "container" ]; then
    # stdin 管道不支持并行恢复：先把明文落为容器内临时文件
    echo "[restore] container 模式 --jobs>1 需经容器内文件，忽略（JOBS=1）"
  else
    RESTORE_ARGS+=(-j "$JOBS")
  fi
fi

echo "[restore] 开始恢复 $(basename "$BACKUP_FILE") → $TARGET_DB ..."
if [ "$PG_MODE" = "container" ]; then
  cat "$RESTORE_SRC" | compose_pg pg_restore "${RESTORE_ARGS[@]}" || {
    # pg_restore 对"已存在对象"等非致命问题也会给非零码；--clean 场景放宽由人工判断
    echo "[restore] pg_restore 返回非零（详见上方输出）；若是对象冲突类报错请改用 --clean" >&2
    exit 1
  }
else
  : "${PG_RESTORE_BIN:?host 模式需配置 PG_RESTORE_BIN（backup.env）}"
  "$PG_RESTORE_BIN" $(restore_conn_host) "${RESTORE_ARGS[@]}" "$RESTORE_SRC" || {
    echo "[restore] pg_restore 返回非零（详见上方输出）；若是对象冲突类报错请改用 --clean" >&2
    exit 1
  }
fi

DUR=$(( $(date +%s) - START_TS ))
echo "[restore] restore_ok file=$(basename "$BACKUP_FILE") target=$TARGET_DB dur_s=$DUR"
echo "[restore] 下一步：运行核验（scripts/backup/verify-restore.ts --source <源库URL> --target <目标库URL>）"
