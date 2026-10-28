import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import {
  decideAuthRouting,
  isOriginAllowed,
  isUnsafeApiWrite,
} from "@/lib/auth-guard";

// 防线 1（实施计划 §8.2）：未登录拒绝所有 (app) 页面与 /api（登录/健康检查除外）。
// edge 运行时只判断 Cookie 存在性，不连数据库；会话真伪由 (app) 布局的
// getCurrentUser 与各 Route Handler 的 requireUser 校验（防线 2）。
// 防线 0（T16 全面加固）：API 写请求（POST/PATCH/PUT/DELETE）统一做 Origin
// 校验——跨站浏览器的伪造请求带非本站 Origin → 403；非浏览器客户端不带
// Origin 放行，由 SameSite=Lax Cookie 兜底。Route Handler 层 assertSameOrigin
// 逐端点校验继续保留（双保险）。

const ORIGIN_FORBIDDEN = JSON.stringify({
  error: { code: "origin_forbidden", message: "请求来源不被允许" },
});

export function middleware(request: NextRequest) {
  const decision = decideAuthRouting(
    request.nextUrl.pathname,
    Boolean(request.cookies.get(SESSION_COOKIE)?.value),
  );
  if (decision.kind === "redirect") {
    return NextResponse.redirect(new URL(decision.location, request.url));
  }
  if (decision.kind === "unauthorized") {
    return NextResponse.json(
      { error: { code: "unauthenticated", message: "未登录或会话已过期" } },
      { status: 401 },
    );
  }
  if (
    isUnsafeApiWrite(request.nextUrl.pathname, request.method) &&
    !isOriginAllowed(
      request.headers.get("origin"),
      request.headers.get("x-forwarded-host"),
      request.headers.get("host"),
    )
  ) {
    return new NextResponse(ORIGIN_FORBIDDEN, {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return NextResponse.next();
}

export const config = {
  // 静态资源不经过认证中间件
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
