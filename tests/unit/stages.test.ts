import { describe, expect, it } from "vitest";
import {
  BOOKED_DEMO_STAGE_ANCHOR,
  PRESET_STAGES,
  QUALIFIED_STAGE_ANCHOR,
  REQUIRED_METRIC_ANCHORS,
} from "../../src/lib/stages";

// 固化 PRD §5.8 的 13 个预置阶段口径：名称与顺序不得漂移，
// 语义锚点是指标引擎（T12/T13）与阶段自动推进（T06/K4）的依据。
describe("PRESET_STAGES", () => {
  it("共 13 个阶段，名称与顺序与 PRD §5.8 完全一致", () => {
    expect(PRESET_STAGES.map((s) => s.name)).toEqual([
      "新线索",
      "待联系",
      "已接通",
      "已有效沟通",
      "需求待确认",
      "合格商机",
      "已预约演示",
      "已完成演示",
      "方案报价",
      "商务谈判",
      "已成交",
      "暂缓",
      "已关闭",
    ]);
  });

  it("sortOrder 为 1..13 连续递增", () => {
    expect(PRESET_STAGES.map((s) => s.sortOrder)).toEqual(
      Array.from({ length: PRESET_STAGES.length }, (_, i) => i + 1),
    );
  });

  it("semanticKey 与 code 均唯一且非空", () => {
    const semanticKeys = PRESET_STAGES.map((s) => s.semanticKey);
    const codes = PRESET_STAGES.map((s) => s.code);
    expect(new Set(semanticKeys).size).toBe(PRESET_STAGES.length);
    expect(new Set(codes).size).toBe(PRESET_STAGES.length);
    for (const stage of PRESET_STAGES) {
      expect(stage.semanticKey.trim().length).toBeGreaterThan(0);
      expect(stage.code.trim().length).toBeGreaterThan(0);
      expect(stage.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("指标引擎依赖的语义锚点全部存在", () => {
    const semanticKeys = new Set(PRESET_STAGES.map((s) => s.semanticKey));
    for (const anchor of REQUIRED_METRIC_ANCHORS) {
      expect(semanticKeys.has(anchor)).toBe(true);
    }
    expect(semanticKeys.has(QUALIFIED_STAGE_ANCHOR)).toBe(true);
    expect(semanticKeys.has(BOOKED_DEMO_STAGE_ANCHOR)).toBe(true);
  });

  it("漏斗起点为新线索，终点组为已成交/暂缓/已关闭", () => {
    expect(PRESET_STAGES[0]?.semanticKey).toBe("new_lead");
    expect(PRESET_STAGES.at(-1)?.semanticKey).toBe("closed");
    expect(PRESET_STAGES.at(-2)?.semanticKey).toBe("on_hold");
    expect(PRESET_STAGES.at(-3)?.semanticKey).toBe("won");
  });
});
