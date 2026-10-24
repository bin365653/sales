import { describe, expect, it } from "vitest";
import { decideAuthRouting, sanitizeNextPath } from "@/lib/auth-guard";

describe("middleware 路由判定（§8.2 防线 1）", () => {
  it("未登录访问受保护页面 → 登录重定向并携带 next", () => {
    expect(decideAuthRouting("/", false)).toEqual({
      kind: "redirect",
      location: "/login?next=%2F",
    });
    expect(decideAuthRouting("/leads/123", false)).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fleads%2F123",
    });
  });

  it("未登录访问受保护 API → 401 判定", () => {
    expect(decideAuthRouting("/api/leads", false)).toEqual({ kind: "unauthorized" });
    expect(decideAuthRouting("/api/auth/session", false)).toEqual({
      kind: "unauthorized",
    });
  });

  it("白名单放行：登录页、登录接口、健康检查", () => {
    expect(decideAuthRouting("/login", false)).toEqual({ kind: "allow" });
    expect(decideAuthRouting("/api/auth/login", false)).toEqual({ kind: "allow" });
    expect(decideAuthRouting("/api/health", false)).toEqual({ kind: "allow" });
  });

  it("携带会话 Cookie 一律放行（真伪由防线 2 校验）", () => {
    expect(decideAuthRouting("/", true)).toEqual({ kind: "allow" });
    expect(decideAuthRouting("/api/leads", true)).toEqual({ kind: "allow" });
    expect(decideAuthRouting("/login", true)).toEqual({ kind: "allow" });
  });

  it("next 仅接受站内绝对路径（防 open redirect）", () => {
    expect(sanitizeNextPath("/leads?keyword=x")).toBe("/leads?keyword=x");
    expect(sanitizeNextPath("https://evil.example")).toBeNull();
    expect(sanitizeNextPath("//evil.example")).toBeNull();
    expect(sanitizeNextPath("/\\evil.example")).toBeNull();
    expect(sanitizeNextPath("relative")).toBeNull();
    expect(sanitizeNextPath(null)).toBeNull();
  });
});
