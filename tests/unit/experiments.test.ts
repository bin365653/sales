import { describe, expect, it } from "vitest";
import {
  ASSIGN_CONFIRM_RULE_NOTE,
  buildExperimentComparisonRows,
  EXPERIMENT_COMPARISON_METRICS,
  EXPERIMENT_STATUS_LABELS,
  EXPERIMENT_GROUP_LABELS,
  CONTROL_GROUP_NOTICE,
} from "@/lib/experiments";
import {
  experimentCreateSchema,
  experimentUpdateSchema,
  EXPERIMENT_MAX_RATIO,
  EXPERIMENT_MIN_RATIO,
} from "@/lib/schemas/experiment";
import { estimateSplit } from "@/server/services/experiments";
import { computeGroupComparison } from "@/lib/analytics";

// T14 实验分组纯逻辑单测：切分估算（执行=预览同一规则）、对比行组装
// （经 computeGroupComparison，UIUX 示例 8.7pp 手工对账）、Schema 边界
// （比例 10–90、更新混传拒绝、关闭互斥）。

describe("estimateSplit（随机分组切分估算）", () => {
  it("默认 50/50：偶数对半，奇数 AI 辅助组多 1（round）", () => {
    expect(estimateSplit(100, 50)).toEqual({ controlEstimate: 50, assistedEstimate: 50 });
    expect(estimateSplit(51, 50)).toEqual({ controlEstimate: 25, assistedEstimate: 26 });
  });

  it("占比换算：n=10、ratio=30 → 辅助 3 / 常规 7", () => {
    expect(estimateSplit(10, 30)).toEqual({ controlEstimate: 7, assistedEstimate: 3 });
  });

  it("n≥2 时两侧各至少 1 条（ratio 极值也不产生空组）", () => {
    expect(estimateSplit(5, EXPERIMENT_MIN_RATIO)).toEqual({
      controlEstimate: 4,
      assistedEstimate: 1,
    });
    expect(estimateSplit(5, EXPERIMENT_MAX_RATIO)).toEqual({
      controlEstimate: 1,
      assistedEstimate: 4,
    });
    expect(estimateSplit(2, 90)).toEqual({ controlEstimate: 1, assistedEstimate: 1 });
  });

  it("n=1 时只有单侧样本（仅 n≥2 强制两侧非空；单样本无实验意义）", () => {
    // round(1×50%)=1 → 单条进 AI 辅助组；服务层不拒绝（实验规模由圈选决定）
    expect(estimateSplit(1, 50)).toEqual({ controlEstimate: 0, assistedEstimate: 1 });
  });
});

describe("buildExperimentComparisonRows（对比行组装）", () => {
  it("UIUX P7 示例手工对账：有效沟通率 37.5% vs 46.2% → +8.7pp", () => {
    const rows = buildExperimentComparisonRows(
      { control: { effective: 9, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 }, assisted: { effective: 12, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 } },
      24,
      26,
      50,
    );
    const effective = rows.find((row) => row.metricKey === "effective");
    expect(effective?.comparison.controlRatio).toBe(37.5);
    expect(effective?.comparison.assistedRatio).toBe(46.2);
    expect(effective?.comparison.diffPp).toBe(8.7);
  });

  it("样本量 < 阈值 → insufficient 标志置位（数值照常计算）", () => {
    const rows = buildExperimentComparisonRows(
      { control: { effective: 1, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 }, assisted: { effective: 2, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 } },
      3,
      4,
      50,
    );
    expect(rows.every((row) => row.comparison.insufficient)).toBe(true);
    expect(rows[0]?.comparison.controlRatio).toBe(33.3);
  });

  it("五个指标行齐全，行序与定义一致；零样本组比例/差异为 null", () => {
    const rows = buildExperimentComparisonRows(
      { control: { effective: 0, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 }, assisted: { effective: 0, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 } },
      0,
      0,
      50,
    );
    expect(rows.map((row) => row.metricKey)).toEqual(
      EXPERIMENT_COMPARISON_METRICS.map((metric) => metric.key),
    );
    expect(rows.every((row) => row.comparison.controlRatio === null)).toBe(true);
    expect(rows.every((row) => row.comparison.diffPp === null)).toBe(true);
  });

  it("口径复用：与 computeGroupComparison 直接调用结果一致（勿在 T14 重写口径）", () => {
    const rows = buildExperimentComparisonRows(
      { control: { effective: 5, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 }, assisted: { effective: 7, qualified: 0, booked_demo: 0, won: 0, ai_used: 0 } },
      20,
      20,
      50,
    );
    expect(rows[0]?.comparison).toEqual(
      computeGroupComparison({ sampleSize: 20, hits: 5 }, { sampleSize: 20, hits: 7 }, 50),
    );
  });
});

describe("experimentCreateSchema / experimentUpdateSchema", () => {
  it("创建：缺省比例 50、阈值 50；圈选字段可全空", () => {
    const parsed = experimentCreateSchema.parse({ name: "AI 效果验证" });
    expect(parsed.assistedRatio).toBe(50);
    expect(parsed.minSampleSize).toBe(50);
  });

  it("创建：比例越界 9/91 拒绝；10 与 90 合法", () => {
    expect(experimentCreateSchema.safeParse({ name: "x", assistedRatio: 9 }).success).toBe(false);
    expect(experimentCreateSchema.safeParse({ name: "x", assistedRatio: 91 }).success).toBe(false);
    expect(experimentCreateSchema.safeParse({ name: "x", assistedRatio: 10 }).success).toBe(true);
    expect(experimentCreateSchema.safeParse({ name: "x", assistedRatio: 90 }).success).toBe(true);
  });

  it("创建：空名称/超长名称拒绝", () => {
    expect(experimentCreateSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(experimentCreateSchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
  });

  it("更新：草稿改配置合法（至少一项）", () => {
    expect(experimentUpdateSchema.safeParse({ name: "新名称" }).success).toBe(true);
    expect(experimentUpdateSchema.safeParse({ minSampleSize: 30 }).success).toBe(true);
  });

  it("更新：空对象拒绝（不静默忽略）", () => {
    expect(experimentUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("更新：关闭与配置混传拒绝（关闭只接受 {status:'closed'}）", () => {
    expect(experimentUpdateSchema.safeParse({ status: "closed", name: "x" }).success).toBe(false);
    expect(experimentUpdateSchema.safeParse({ status: "closed" }).success).toBe(true);
  });

  it("留痕文案与标签常量（守契约）", () => {
    expect(ASSIGN_CONFIRM_RULE_NOTE).toContain("random");
    expect(EXPERIMENT_STATUS_LABELS.running).toBe("进行中");
    expect(EXPERIMENT_GROUP_LABELS.control).toBe("常规组");
    expect(CONTROL_GROUP_NOTICE).toContain("常规组");
  });
});
