// 登录限流（实施计划 §8.1：5 次/15 分钟，键 = IP + 账号）。
// V1.0 单机部署不引入 Redis（§2.2），用内存滑动窗口；进程重启窗口清零，
// 完整失败记录仍保留在 audit_logs 供人工核查（防绕过审计）。

export interface LoginRateLimiter {
  /** 记录一次失败；返回记录后是否已达到封锁阈值 */
  recordFailure(key: string): boolean;
  /** 该键当前是否处于封锁状态 */
  isBlocked(key: string): boolean;
  /** 登录成功后清除该键的失败记录 */
  reset(key: string): void;
}

export interface LoginRateLimiterOptions {
  /** 窗口内允许的失败次数上限，默认 5 */
  maxFailures?: number;
  /** 滑动窗口时长，默认 15 分钟 */
  windowMs?: number;
  now?: () => number;
}

export function createLoginRateLimiter(
  options: LoginRateLimiterOptions = {},
): LoginRateLimiter {
  const maxFailures = options.maxFailures ?? 5;
  const windowMs = options.windowMs ?? 15 * 60 * 1000;
  const now = options.now ?? (() => Date.now());
  const failures = new Map<string, number[]>();

  function currentFailures(key: string): number[] {
    const current = now();
    const timestamps = (failures.get(key) ?? []).filter(
      (time) => current - time < windowMs,
    );
    if (timestamps.length === 0) {
      failures.delete(key);
    } else {
      failures.set(key, timestamps);
    }
    return timestamps;
  }

  return {
    recordFailure(key) {
      const current = now();
      const timestamps = currentFailures(key);
      timestamps.push(current);
      failures.set(key, timestamps);
      // 键数过多时整体清理一次过期键，防止长期运行内存缓慢增长
      if (failures.size > 10_000) {
        for (const [existingKey, times] of failures) {
          if (times.every((time) => current - time >= windowMs)) {
            failures.delete(existingKey);
          }
        }
      }
      return timestamps.length >= maxFailures;
    },

    isBlocked(key) {
      return currentFailures(key).length >= maxFailures;
    },

    reset(key) {
      failures.delete(key);
    },
  };
}

// 全局共享实例（开发热重载挂到 globalThis，避免反复重置窗口）
const globalForRateLimit = globalThis as unknown as {
  loginRateLimiter?: LoginRateLimiter;
};

export const loginRateLimiter =
  globalForRateLimit.loginRateLimiter ?? createLoginRateLimiter();

if (process.env.NODE_ENV !== "production") {
  globalForRateLimit.loginRateLimiter = loginRateLimiter;
}
