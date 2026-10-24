// middleware 路由判定（纯函数，供 edge 运行时 middleware 使用，
// 本文件必须保持零服务端依赖：不 import next/server / prisma / node crypto）。

export type AuthRouteDecision =
  | { kind: "allow" }
  | { kind: "redirect"; location: string }
  | { kind: "unauthorized" };

/** 免登录页面白名单 */
const PUBLIC_PAGES = new Set(["/login"]);

/** 免登录 API 白名单（登录、健康检查；§8.2 防线 1） */
const PUBLIC_APIS = new Set(["/api/auth/login", "/api/health"]);

/**
 * 未登录请求的统一判定：
 * - 受保护页面 → 307 重定向到 /login?next=…（验收项：未登录 30 重定向）；
 * - 受保护 API → 401 JSON；
 * - 白名单与带会话 Cookie 的请求放行（Cookie 真伪由防线 2 校验）。
 */
export function decideAuthRouting(
  pathname: string,
  hasSessionCookie: boolean,
): AuthRouteDecision {
  if (hasSessionCookie) {
    return { kind: "allow" };
  }
  if (PUBLIC_PAGES.has(pathname)) {
    return { kind: "allow" };
  }
  if (PUBLIC_APIS.has(pathname) || pathname.startsWith("/api/health/")) {
    return { kind: "allow" };
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return { kind: "unauthorized" };
  }
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return { kind: "allow" };
  }
  return { kind: "redirect", location: `/login?next=${encodeURIComponent(pathname)}` };
}

/** 登录后的跳转路径仅允许站内绝对路径（防 open redirect） */
export function sanitizeNextPath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }
  return value;
}
