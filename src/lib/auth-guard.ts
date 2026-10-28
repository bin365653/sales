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

// ---------- CSRF 防线 0（T16 全面加固：middleware 层 Origin 校验） ----------
// Route Handler 层的 assertSameOrigin（T02 起逐写端点接入）仍是防线；
// 本层在 middleware 统一兜底，堵住新增端点漏接的情形。

const UNSAFE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** 是否为需要 Origin 校验的 API 写请求（GET/HEAD/OPTIONS 不校验） */
export function isUnsafeApiWrite(pathname: string, method: string): boolean {
  return (
    (pathname === "/api" || pathname.startsWith("/api/")) &&
    UNSAFE_METHODS.has(method.toUpperCase())
  );
}

/**
 * Origin 判定纯函数（与 assertSameOrigin 同一语义）：
 * - 非浏览器客户端一般不带 Origin → 放行（由 SameSite=Lax Cookie 兜底）；
 * - 浏览器跨站写请求带非本站 Origin → 拒绝（403）；
 * - 经反向代理时按 x-forwarded-host 对比；Origin 头非法一律拒绝。
 * 本函数必须保持零服务端依赖（edge middleware 可用）。
 */
export function isOriginAllowed(
  origin: string | null | undefined,
  forwardedHost: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (!origin) {
    return true;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const expected = forwardedHost || host;
  return expected !== null && expected !== undefined && originHost === expected;
}
