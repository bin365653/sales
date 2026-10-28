import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthUser, SESSION_COOKIE } from "@/lib/auth";
import { isOriginAllowed } from "@/lib/auth-guard";
import { resolveSession } from "@/server/auth/session";
import { describeError } from "@/server/http/redact";

// Route Handler 公共层：统一错误结构、会话守卫、Origin 校验、客户端 IP 提取。

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "validation_error",
          message: error.issues[0]?.message ?? "入参不合法",
        },
      },
      { status: 400 },
    );
  }
  // 未处理异常只输出脱敏后的单行描述（T16 日志脱敏），不整对象打日志
  console.error("[api] 未处理异常：", describeError(error));
  return NextResponse.json(
    { error: { code: "internal_error", message: "服务器内部错误" } },
    { status: 500 },
  );
}

/** API 统一入守卫（§8.2 防线 2）：无有效会话一律 401 */
export async function requireUser(request: {
  cookies: { get(name: string): { value: string } | undefined };
}): Promise<AuthUser> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const user = await resolveSession(token);
  if (!user) {
    throw new ApiError(401, "unauthenticated", "未登录或会话已过期");
  }
  return user;
}

/**
 * 写请求 Origin 校验（CSRF 补充层，§6 统一约定 / §8.1）：
 * 判定与 middleware 防线 0 共用 isOriginAllowed 纯函数（T16 全面加固：
 * middleware 对全部 API 写请求兜底，本函数在 Route Handler 层双保险）。
 */
export function assertSameOrigin(request: {
  headers: { get(name: string): string | null };
}): void {
  const allowed = isOriginAllowed(
    request.headers.get("origin"),
    request.headers.get("x-forwarded-host"),
    request.headers.get("host"),
  );
  if (!allowed) {
    throw new ApiError(403, "origin_forbidden", "请求来源不被允许");
  }
}

/** 客户端 IP：优先反向代理头（Nginx），否则取直连头 */
export function clientIp(request: {
  headers: { get(name: string): string | null };
}): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  return request.headers.get("x-real-ip");
}
