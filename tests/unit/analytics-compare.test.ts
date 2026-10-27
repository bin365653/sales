import { describe, expect, it } from "vitest";
import {
  computeGroupComparison,
  EXPERIMENT_DEFAULT_MIN_SAMPLE,
  SAMPLE_INSUFFICIENT_NOTICE,
} from "@/lib/analytics";

// T13 实验对比口径固化（PRD §5.10 / UIUX P7 对比表，P8 复用）：
// 比例 = 命中/样本量 ×100（1 位小数）；绝对差异 = AI 辅助组 − 常规组（百分点）；
// 样本量 < 阈值 → insufficient 标志（UI 显示"样本不足，暂不宜判断"横幅）。
// 函数只输出数字/布尔——不存在也不允许"提升 X%"类结论文案（§5.10 红线）。

describe("computeGroupComparison：比例与绝对差异手工对账", () => {
  it("UIUX P7 示例值：37.5% vs 46.2% → +8.7pp", () => {
    // 9/24 = 37.5%；12/26 = 46.15…% → 46.2；46.2 − 37.5 = 8.7
    const result = computeGroupComparison(
      { sampleSize: 24, hits: 9 },
      { sampleSize: 26, hits: 12 },
    );
    expect(result.controlRatio).toBe(37.5);
    expect(result.assistedRatio).toBe(46.2);
    expect(result.diffPp).toBe(8.7);
    expect(result.insufficient).toBe(true); // 均小于 50
  });

  it("负差异与 0 差异（带符号渲染由 UI 层负责）", () => {
    const negative = computeGroupComparison(
      { sampleSize: 50, hits: 30 },
      { sampleSize: 50, hits: 20 },
    );
    expect(negative.controlRatio).toBe(60);
    expect(negative.assistedRatio).toBe(40);
    expect(negative.diffPp).toBe(-20);
    expect(negative.insufficient).toBe(false);

    const zero = computeGroupComparison(
      { sampleSize: 50, hits: 25 },
      { sampleSize: 60, hits: 30 },
    );
    expect(zero.diffPp).toBe(0);
  });

  it("样本量 0 → 比例 null、差异 null；不足阈值 → insufficient", () => {
    const result = computeGroupComparison(
      { sampleSize: 0, hits: 0 },
      { sampleSize: 49, hits: 10 },
      50,
    );
    expect(result.controlRatio).toBeNull();
    expect(result.assistedRatio).toBe(20.4);
    expect(result.diffPp).toBeNull();
    expect(result.insufficient).toBe(true);
  });

  it("样本量恰好等于阈值 → 不算不足；任一组低于阈值 → 不足", () => {
    const okBoth = computeGroupComparison(
      { sampleSize: 50, hits: 10 },
      { sampleSize: 50, hits: 15 },
      50,
    );
    expect(okBoth.insufficient).toBe(false);

    const oneShort = computeGroupComparison(
      { sampleSize: 50, hits: 10 },
      { sampleSize: 49, hits: 15 },
      50,
    );
    expect(oneShort.insufficient).toBe(true);
  });

  it("默认阈值 50（UIUX P8 最小样本阈值默认值）", () => {
    expect(EXPERIMENT_DEFAULT_MIN_SAMPLE).toBe(50);
    const at49 = computeGroupComparison(
      { sampleSize: 49, hits: 10 },
      { sampleSize: 49, hits: 10 },
    );
    expect(at49.insufficient).toBe(true);
  });

  it("输出为纯数值结构：不含任何文案字段（防'提升 X%'结论文案）", () => {
    const result = computeGroupComparison(
      { sampleSize: 60, hits: 30 },
      { sampleSize: 60, hits: 36 },
    );
    expect(Object.keys(result).sort()).toEqual([
      "assistedRatio",
      "controlRatio",
      "diffPp",
      "insufficient",
    ]);
    // 横幅文案为固定常量，不含因果判断
    expect(SAMPLE_INSUFFICIENT_NOTICE).toBe("样本不足，暂不宜判断");
    expect(SAMPLE_INSUFFICIENT_NOTICE).not.toContain("提升");
  });
});
