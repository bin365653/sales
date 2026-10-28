import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { ApiError } from "@/server/http/api";
import { assertSameOrigin, clientIp } from "@/server/http/api";
import { isOriginAllowed, isUnsafeApiWrite } from "@/lib/auth-guard";

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers,
  });
}

function statusOf(fn: () => void): number {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.status;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("写请求 Origin 校验（CSRF 补充层，§6 统一约定）", () => {
  it("同源 Origin 放行", () => {
    expect(() =>
      assertSameOrigin(makeRequest({ origin: "http://localhost:3000", host: "localhost:3000" })),
    ).not.toThrow();
  });

  it("非浏览器请求（无 Origin）放行，由 SameSite=Lax 兜底", () => {
    expect(() => assertSameOrigin(makeRequest({}))).not.toThrow();
  });

  it("跨站 Origin → 403", () => {
    expect(
      statusOf(() =>
        assertSameOrigin(makeRequest({ origin: "http://evil.example", host: "localhost:3000" })),
      ),
    ).toBe(403);
  });

  it("Origin 头非法 → 403", () => {
    expect(
      statusOf(() => assertSameOrigin(makeRequest({ origin: "::not-a-url", host: "localhost:3000" }))),
    ).toBe(403);
  });

  it("经反向代理时按 x-forwarded-host 对比", () => {
    expect(() =>
      assertSameOrigin(
        makeRequest({ origin: "https://sales.example.com", host: "internal:3000", "x-forwarded-host": "sales.example.com" }),
      ),
    ).not.toThrow();
    expect(
      statusOf(() =>
        assertSameOrigin(
          makeRequest({ origin: "https://evil.example.com", host: "internal:3000", "x-forwarded-host": "sales.example.com" }),
        ),
      ),
    ).toBe(403);
  });
});

describe("客户端 IP 提取", () => {
  it("优先 x-forwarded-for 的第一段（Nginx 场景）", () => {
    const request = makeRequest({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("其次 x-real-ip；都没有返回 null", () => {
    expect(clientIp(makeRequest({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientIp(makeRequest({}))).toBeNull();
  });
});

// ---------- T16：middleware 防线 0（全面加固） ----------

describe("isUnsafeApiWrite（Origin 校验适用范围）", () => {
  it("API 路径的非安全方法命中；GET/HEAD/OPTIONS 不校验", () => {
    expect(isUnsafeApiWrite("/api/leads", "POST")).toBe(true);
    expect(isUnsafeApiWrite("/api/settings/users/1", "PATCH")).toBe(true);
    expect(isUnsafeApiWrite("/api/auth/logout", "DELETE")).toBe(true);
    expect(isUnsafeApiWrite("/api/leads", "GET")).toBe(false);
    expect(isUnsafeApiWrite("/api/imports", "HEAD")).toBe(false);
    expect(isUnsafeApiWrite("/api/health", "OPTIONS")).toBe(false);
  });

  it("非 API 路径不校验（页面无服务端表单写）", () => {
    expect(isUnsafeApiWrite("/leads", "POST")).toBe(false);
    expect(isUnsafeApiWrite("/settings", "PATCH")).toBe(false);
  });
});

describe("isOriginAllowed（middleware 判定，与 assertSameOrigin 同语义）", () => {
  it("无 Origin 放行（非浏览器客户端，SameSite 兜底）", () => {
    expect(isOriginAllowed(null, null, "localhost:3000")).toBe(true);
    expect(isOriginAllowed(undefined, null, null)).toBe(true);
  });

  it("同源放行；跨站拒绝；Origin 非法拒绝", () => {
    expect(isOriginAllowed("http://localhost:3000", null, "localhost:3000")).toBe(true);
    expect(isOriginAllowed("http://evil.example", null, "localhost:3000")).toBe(false);
    expect(isOriginAllowed("::not-a-url", null, "localhost:3000")).toBe(false);
  });

  it("x-forwarded-host 优先于 host（反向代理）", () => {
    expect(
      isOriginAllowed("https://sales.example.com", "sales.example.com", "internal:3000"),
    ).toBe(true);
    expect(
      isOriginAllowed("https://evil.example", "sales.example.com", "internal:3000"),
    ).toBe(false);
  });

  it("Origin 存在但 host 全部缺失 → 拒绝", () => {
    expect(isOriginAllowed("http://localhost:3000", null, null)).toBe(false);
  });

  it("不同 scheme 同 host：按 host 对比（http/https 混部由反代终止 TLS 决定）", () => {
    expect(isOriginAllowed("https://localhost:3000", null, "localhost:3000")).toBe(true);
  });
});
