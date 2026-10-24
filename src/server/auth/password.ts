import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// 密码哈希统一走 Argon2id（实施计划 §8.1 / 决策 M5）。
// 参数用库默认（OWASP 2023 推荐：m=19456 KiB、t=2、p=1）。
// @node-rs/argon2 的枚举成员在 isolatedModules 下不可引用，用字面量 2 = Argon2id
//（与 prisma/seed.ts 保持一致）。
const ARGON2ID = 2;

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID });
}

export async function verifyPassword(
  passwordHash: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(passwordHash, plain, { algorithm: ARGON2ID });
  } catch {
    // 哈希格式非法等情况一律按"不匹配"处理，不向调用方泄漏细节
    return false;
  }
}

let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomUUID());
  return dummyHashPromise;
}

/**
 * 等时校验：用户不存在时也对一个随机假哈希执行一次完整 Argon2id 校验，
 * 让"未知用户名"与"密码错误"的响应耗时一致，防用户名枚举。
 */
export async function equalizingVerify(
  passwordHash: string | null,
  plain: string,
): Promise<boolean> {
  if (passwordHash === null) {
    await verifyPassword(await getDummyHash(), plain);
    return false;
  }
  return verifyPassword(passwordHash, plain);
}
