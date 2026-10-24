import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthUser, SESSION_COOKIE } from "@/lib/auth";
import { resolveSession } from "@/server/auth/session";

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
  console.error("[api] 未处理异常：", error);
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
 * 写请求 Origin 校验（CSRF 补充层，§6 统一约定 / §8.1；T16 全面加固）：
 * 浏览器跨站请求会带非本站 Origin → 403；非浏览器客户端一般不带 Origin，放行，
 * 由 SameSite=Lax Cookie 兜底。
 */
export function assertSameOrigin(request: {
  headers: { get(name: string): string | null };
}): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    return;
  }
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "origin_forbidden", "请求来源不被允许");
  }
  if (!host || originHost !== host) {
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
