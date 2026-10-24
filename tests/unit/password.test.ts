import { describe, expect, it } from "vitest";
import { equalizingVerify, hashPassword, verifyPassword } from "@/server/auth/password";

describe("密码哈希（Argon2id，实施计划 §8.1）", () => {
  it("哈希后可验证成功，且为 argon2id 格式", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    expect(passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(passwordHash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(passwordHash, "wrong password")).toBe(false);
  });

  it("盐随机：同一密码两次哈希结果不同", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(a).not.toBe(b);
  });

  it("哈希格式非法时按不匹配处理，不抛错", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });

  it("未知用户名的等时校验：返回 false 且不抛错", async () => {
    expect(await equalizingVerify(null, "whatever")).toBe(false);
    expect(await equalizingVerify(null, "")).toBe(false);
  });
});
