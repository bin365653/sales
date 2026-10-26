import { describe, expect, it } from "vitest";
import {
  formatRelativeShanghai,
  oneLineSnippet,
} from "@/lib/format";

// T12 工作台展示辅助固化（UIUX P2"2小时前"、一句话反馈摘要）。
// 全部为纯函数，上海时区（C13）。

const NOW = new Date("2026-10-28T10:00:00+08:00");

describe("formatRelativeShanghai：相对时间", () => {
  it("1 分钟内显示'刚刚'", () => {
    expect(
      formatRelativeShanghai(new Date("2026-10-28T09:59:30+08:00"), NOW),
    ).toBe("刚刚");
  });

  it("1 小时内显示'N 分钟前'", () => {
    expect(
      formatRelativeShanghai(new Date("2026-10-28T09:30:00+08:00"), NOW),
    ).toBe("30 分钟前");
  });

  it("24 小时内显示'N 小时前'", () => {
    expect(
      formatRelativeShanghai(new Date("2026-10-28T08:00:00+08:00"), NOW),
    ).toBe("2 小时前");
  });

  it("24–48 小时显示'昨天 HH:mm'（上海时区）", () => {
    expect(
      formatRelativeShanghai(new Date("2026-10-27T09:05:00+08:00"), NOW),
    ).toBe("昨天 09:05");
  });

  it("同年更早显示'MM-DD HH:mm'；跨年带年份", () => {
    expect(
      formatRelativeShanghai(new Date("2026-10-20T08:30:00+08:00"), NOW),
    ).toBe("10-20 08:30");
    expect(
      formatRelativeShanghai(new Date("2025-12-01T08:30:00+08:00"), NOW),
    ).toBe("2025-12-01 08:30");
  });
});

describe("oneLineSnippet：一句话摘要", () => {
  it("拍平换行与多余空白", () => {
    expect(oneLineSnippet("  客户\n  想了解  报价\t方案  ", 48)).toBe(
      "客户 想了解 报价 方案",
    );
  });

  it("超长截断按码点并补省略号", () => {
    const long = "一".repeat(60);
    const snippet = oneLineSnippet(long, 48);
    expect(snippet).toBe("一".repeat(48) + "…");
  });

  it("空串与 null 返回 null（不渲染空节点）", () => {
    expect(oneLineSnippet("   ", 10)).toBeNull();
    expect(oneLineSnippet(null, 10)).toBeNull();
  });
});
