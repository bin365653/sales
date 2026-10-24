import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
} from "@/server/auth/session";

describe("会话令牌（§4.2 sessions：Cookie 存随机 token，库里存哈希）", () => {
  it("token 为 32 字节 base64url，且不重复", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateSessionToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it("库中仅存 SHA-256 哈希（64 位十六进制，不可反推 token）", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash); // 确定性
    expect(hashSessionToken(generateSessionToken())).not.toBe(hash);
  });
});
