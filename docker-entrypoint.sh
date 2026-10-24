#!/bin/sh
# 容器启动入口：迁移 → 幂等 seed → 启动应用（T01 一键启动验收）
set -e

echo "[entrypoint] 1/3 应用数据库迁移（prisma migrate deploy，幂等）..."
npx --no-install prisma migrate deploy

echo "[entrypoint] 2/3 写入基础数据（seed，缺则补建、不覆盖既有配置）..."
npx --no-install prisma db seed

echo "[entrypoint] 3/3 启动应用（0.0.0.0:${PORT}）..."
exec node_modules/.bin/next start -H 0.0.0.0 -p "${PORT}"
