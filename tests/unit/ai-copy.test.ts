import { describe, expect, it } from "vitest";
import {
  formatAiRunCopy,
  formatAnalysisCopy,
  formatCallPrepCopy,
} from "@/lib/ai-copy";
import type { AnalysisOutput, CallPrepOutput } from "@/server/ai/validator";

// T09 复制格式单测（UIUX §4.10）：复制一律产出纯文本、分节排版、末尾常驻
// "AI 生成，仅供参考"标识；分析 8 项 / 准备卡 6 项齐全；信息不足如实呈现。

const ANALYSIS: AnalysisOutput = {
  fit: { level: "mid", reason: "行业与规模基本匹配" },
  facts: [
    { topic: "在用系统", detail: "Excel 台账", status: "confirmed" },
    { topic: "采购时间", detail: "可能在今年 Q4", status: "unverified" },
  ],
  pains: [{ pain: "资料分散难协同", evidence: "客户自述资料靠微信群传递" }],
  angles: ["以资料统一管理切入"],
  next_action: "预约 15 分钟演示",
  verify_questions: ["现用系统到期时间"],
};

const CALL_PREP: CallPrepOutput = {
  goal: "确认采购需求与时间",
  opening: "您好，我是勤策的小张",
  diag_questions: ["现在怎么管理客户资料？", "几个人用？", "遇到什么问题？"],
  objections: [
    { objection: "太贵了", response: "先看效果再谈价格" },
    { objection: "不需要", response: "了解现状再判断" },
  ],
  confirm_next: "约定演示时间",
  avoid: ["承诺降本 50%", "声称竞品即将停服"],
};

describe("formatAnalysisCopy（AI 客户分析）", () => {
  it("含标题行、全部 8 项分节与合规脚注", () => {
    const text = formatAnalysisCopy("合肥XX商贸", "2026-10-26 10:00", ANALYSIS);
    expect(text).toContain("【AI 客户分析】客户:合肥XX商贸  生成时间:2026-10-26 10:00");
    expect(text).toContain("■ 匹配度：中");
    expect(text).toContain("依据：行业与规模基本匹配");
    expect(text).toContain("■ 已知事实");
    expect(text).toContain("1. 在用系统：Excel 台账");
    expect(text).toContain("■ 待核实信息");
    expect(text).toContain("1. 采购时间：可能在今年 Q4");
    expect(text).toContain("■ 经营痛点（含推断依据）");
    expect(text).toContain("资料分散难协同（依据：客户自述资料靠微信群传递）");
    expect(text).toContain("■ 沟通切入点");
    expect(text).toContain("■ 推荐下一步动作");
    expect(text).toContain("预约 15 分钟演示");
    expect(text).toContain("■ 建议向客户核实的问题");
    expect(text).toContain("(AI 生成,仅供参考,请核对后使用)");
    // 纯文本：不带 Markdown 符号
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
  });

  it("信息不足：匹配度如实显示、空分节给出占位说明", () => {
    const empty: AnalysisOutput = {
      fit: { level: "insufficient", reason: "输入资料几乎没有有效信息" },
      facts: [],
      pains: [],
      angles: [],
      next_action: "先补全客户基础信息再分析",
      verify_questions: ["主营业务", "团队规模"],
    };
    const text = formatAnalysisCopy("空线索客户", "2026-10-26 10:00", empty);
    expect(text).toContain("■ 匹配度：信息不足");
    expect(text).toContain("（暂无输入资料支撑的已知事实）");
    expect(text).not.toContain("■ 待核实信息");
    expect(text).not.toContain("■ 经营痛点");
  });
});

describe("formatCallPrepCopy（AI 电话准备卡）", () => {
  it("含标题行、全部 6 项分节与合规脚注", () => {
    const text = formatCallPrepCopy("合肥XX商贸", "2026-10-26 10:00", CALL_PREP);
    expect(text).toContain("【AI 电话准备卡】客户:合肥XX商贸  生成时间:2026-10-26 10:00");
    expect(text).toContain("■ 本次沟通目标");
    expect(text).toContain("■ 开场建议(15–30 秒)");
    expect(text).toContain("■ 需求诊断问题");
    expect(text).toContain("1. 现在怎么管理客户资料？");
    expect(text).toContain("■ 可能异议与回应");
    expect(text).toContain("1. 异议:太贵了 / 建议回应:先看效果再谈价格");
    expect(text).toContain("■ 希望确认的下一步");
    expect(text).toContain("■ 需要避免的表述");
    expect(text).toContain("1. 承诺降本 50%");
    expect(text).toContain("(AI 生成,仅供参考,请核对后使用)");
  });
});

describe("formatAiRunCopy（分发与防御）", () => {
  it("按 run 类型分发", () => {
    expect(formatAiRunCopy("analysis", "客户", "t", ANALYSIS)).toContain("AI 客户分析");
    expect(formatAiRunCopy("call_prep", "客户", "t", CALL_PREP)).toContain("AI 电话准备卡");
  });

  it("输出缺失/结构损坏/未知类型返回 null（不抛错）", () => {
    expect(formatAiRunCopy("analysis", "客户", "t", null)).toBeNull();
    expect(formatAiRunCopy("analysis", "客户", "t", "not-json")).toBeNull();
    expect(
      formatAiRunCopy("analysis", "客户", "t", { fit: { level: "high" } }),
    ).toBeNull();
    expect(formatAiRunCopy("interaction_summary", "客户", "t", {})).toBeNull();
  });
});
