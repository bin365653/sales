import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { decideAuthRouting } from "@/lib/auth-guard";

// 防线 1（实施计划 §8.2）：未登录拒绝所有 (app) 页面与 /api（登录/健康检查除外）。
// edge 运行时只判断 Cookie 存在性，不连数据库；会话真伪由 (app) 布局的
// getCurrentUser 与各 Route Handler 的 requireUser 校验（防线 2）。

export function middleware(request: NextRequest) {
  const decision = decideAuthRouting(
    request.nextUrl.pathname,
    Boolean(request.cookies.get(SESSION_COOKIE)?.value),
  );
  switch (decision.kind) {
    case "allow":
      return NextResponse.next();
    case "redirect":
      return NextResponse.redirect(new URL(decision.location, request.url));
    case "unauthorized":
      return NextResponse.json(
        { error: { code: "unauthenticated", message: "未登录或会话已过期" } },
        { status: 401 },
      );
  }
}

export const config = {
  // 静态资源不经过认证中间件
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
