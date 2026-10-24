# ---------- 依赖与构建 ----------
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期占位 DATABASE_URL：prisma generate 与 next build 不需要真实连接
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npx prisma generate && npm run build

# ---------- 运行时 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# prisma 引擎与 argon2 原生模块依赖 openssl
RUN apk add --no-cache openssl \
  && addgroup -S app \
  && adduser -S app -G app

# 生产依赖（含 prisma CLI：容器启动时执行 migrate deploy；含 tsx：执行 seed）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# Prisma client 生成产物
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# 应用产物与运行所需源文件
COPY --from=builder /app/.next ./.next
COPY prisma ./prisma
COPY src/lib ./src/lib
COPY next.config.ts ./
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh \
  && chown -R app:app /app

USER app
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
