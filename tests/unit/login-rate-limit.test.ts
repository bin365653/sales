import { describe, expect, it } from "vitest";
import { createLoginRateLimiter } from "@/server/auth/login-rate-limit";

// 可注入时钟，验证滑动窗口行为
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("登录限流（5 次/15 分钟/IP+账号，§8.1）", () => {
  it("连续 5 次失败后封锁，窗口过后自动解除", () => {
    const clock = fakeClock();
    const limiter = createLoginRateLimiter({ now: clock.now });
    const key = "1.2.3.4|alice";

    for (let i = 0; i < 4; i += 1) {
      expect(limiter.recordFailure(key)).toBe(false);
      expect(limiter.isBlocked(key)).toBe(false);
    }
    expect(limiter.recordFailure(key)).toBe(true); // 第 5 次失败 → 封锁
    expect(limiter.isBlocked(key)).toBe(true);

    clock.advance(15 * 60 * 1000 + 1);
    expect(limiter.isBlocked(key)).toBe(false);
  });

  it("登录成功清空该键的失败记录", () => {
    const clock = fakeClock();
    const limiter = createLoginRateLimiter({ now: clock.now });
    const key = "1.2.3.4|bob";

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(key);
    }
    limiter.reset(key);
    expect(limiter.isBlocked(key)).toBe(false);
  });

  it("键与键之间互不影响（IP+账号维度隔离）", () => {
    const clock = fakeClock();
    const limiter = createLoginRateLimiter({ now: clock.now });
    const alice = "1.2.3.4|alice";
    const bob = "1.2.3.4|bob";

    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure(alice);
    }
    expect(limiter.isBlocked(alice)).toBe(true);
    expect(limiter.isBlocked(bob)).toBe(false);
  });

  it("滑动窗口：窗口外的旧失败被淘汰", () => {
    const clock = fakeClock();
    const limiter = createLoginRateLimiter({ now: clock.now });
    const key = "5.6.7.8|carol";

    limiter.recordFailure(key);
    clock.advance(16 * 60 * 1000); // 旧失败已滑出窗口
    expect(limiter.recordFailure(key)).toBe(false);
    expect(limiter.isBlocked(key)).toBe(false);
  });
});
