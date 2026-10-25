import { describe, expect, it } from "vitest";
import {
  apiKeyLast4,
  decryptApiKey,
  encryptApiKey,
  masterKeyFingerprint,
} from "@/server/ai/crypto";

// T08 密钥加密（验收项：密钥不回显不入日志的基础——密文落库、可解密、主密钥校验）。
// 主密钥经环境变量按调用读取，测试内直接切换。

const TEST_KEY = "a".repeat(32) + "b".repeat(32); // 64 hex = 32 字节

function withMasterKey<T>(fn: () => T): T {
  const previous = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = TEST_KEY;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = previous;
    }
  }
}

describe("AES-256-GCM 密钥加解密", () => {
  it("加解密往返一致", () => {
    withMasterKey(() => {
      const plain = "sk-test-1234567890abcdef";
      const cipher = encryptApiKey(plain);
      expect(cipher).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
      expect(cipher).not.toContain(plain);
      expect(decryptApiKey(cipher)).toBe(plain);
    });
  });

  it("相同明文两次加密产生不同密文（随机 IV）", () => {
    withMasterKey(() => {
      const cipher1 = encryptApiKey("sk-same-key");
      const cipher2 = encryptApiKey("sk-same-key");
      expect(cipher1).not.toBe(cipher2);
      expect(decryptApiKey(cipher1)).toBe("sk-same-key");
    });
  });

  it("密文被篡改后解密失败（GCM 完整性校验）", () => {
    withMasterKey(() => {
      const cipher = encryptApiKey("sk-integrity");
      const tampered = `${cipher.slice(0, -4)}AAAA`;
      expect(() => decryptApiKey(tampered)).toThrow();
    });
  });

  it("主密钥不匹配时解密失败且不泄露明文", () => {
    const cipher = withMasterKey(() => encryptApiKey("sk-cross-env"));
    process.env.APP_ENCRYPTION_KEY = "c".repeat(64);
    expect(() => decryptApiKey(cipher)).toThrow();
  });

  it("缺少/非法主密钥时报错清晰（不含密钥内容）", () => {
    delete process.env.APP_ENCRYPTION_KEY;
    expect(() => encryptApiKey("sk-x")).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = "short";
    expect(() => encryptApiKey("sk-x")).toThrow(/64 位十六进制/);
  });

  it("尾号与主密钥指纹", () => {
    withMasterKey(() => {
      expect(apiKeyLast4("sk-abcdef1234")).toBe("1234");
      expect(masterKeyFingerprint()).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
