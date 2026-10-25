import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// API 密钥加密（T08，实施计划 §8.3 / R7）：
// - AES-256-GCM，主密钥来自部署环境变量 APP_ENCRYPTION_KEY（64 位 hex = 32 字节），
//   不进 Git、不进备份；主密钥丢失 = 密钥配置不可解密（可重新录入），业务数据不受影响。
// - 密文格式 v1:<iv_b64>:<tag_b64>:<cipher_b64>（GCM 自带完整性校验，解密失败即抛错）。
// - 本模块只做加解密：任何日志/审计/接口都不落明文与密文（接口仅返回 key_last4）。

const KEY_HEX_LENGTH = 64;

function masterKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "未配置 APP_ENCRYPTION_KEY：无法加密/解密模型密钥。请用 64 位十六进制（32 字节）主密钥配置该环境变量。",
    );
  }
  if (raw.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      "APP_ENCRYPTION_KEY 格式不合法：须为 64 位十六进制字符（32 字节），可用 openssl rand -hex 32 生成。",
    );
  }
  return Buffer.from(raw, "hex");
}

/** 加密 API 密钥：密文不含任何明文痕迹，串内无密钥可逆推主密钥 */
export function encryptApiKey(plainKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** 解密 API 密钥（仅供 Provider Adapter 调用模型时使用，结果不落任何存储） */
export function decryptApiKey(cipherText: string): string {
  const [version, ivB64, tagB64, dataB64] = cipherText.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("模型密钥密文格式不合法，请重新录入密钥。");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** 密钥尾号（接口唯一可见的密钥信息） */
export function apiKeyLast4(plainKey: string): string {
  return plainKey.slice(-4);
}

/** 主密钥指纹（运维排查"两环境是否同主密钥"用，不可逆推密钥本身） */
export function masterKeyFingerprint(): string {
  return createHash("sha256").update(masterKey()).digest("hex").slice(0, 8);
}
