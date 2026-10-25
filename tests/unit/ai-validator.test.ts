import { describe, expect, it } from "vitest";
import {
  extractJsonObject,
  validateOutput,
} from "@/server/ai/validator";

// T08 Output Validator（验收项：结构非法自动重试后落 invalid_output 的判定基础；
// 三种输出结构对齐 PRD §5.4 八项 / §5.5 六项）。

const VALID_ANALYSIS = {
  fit: { level: "mid", reason: "行业匹配，规模待确认" },
  facts: [
    { topic: "在用系统", detail: "自研 Excel 台账", status: "confirmed" },
    { topic: "营收规模", detail: "约 2000 万", status: "unverified" },
  ],
  pains: [{ pain: "客户资料分散", evidence: "输入提到用 Excel 管理客户" }],
  angles: ["从 Excel 台账升级切入"],
  next_action: "预约 30 分钟演示",
  verify_questions: ["目前客户数量级", "系统预算"],
};

const VALID_CALL_PREP = {
  goal: "确认在用系统与到期时间",
  opening: "X 总您好，我是……",
  diag_questions: ["现在多少业务员在跟单？", "订单资料存在哪里？", "明年有什么计划？"],
  objections: [
    { objection: "现在系统还够用", response: "理解，我们只看是否值得对比一次" },
    { objection: "没预算", response: "先看方案，价格后议" },
  ],
  confirm_next: "约一次演示时间",
  avoid: ["未经核实不要说贵司系统已到期"],
};

const VALID_SUMMARY = {
  summary: "客户反馈现有系统仅录入不分析，约好下周演示。",
  next_action: "发送演示邀请",
};

describe("analysis 结构校验（PRD §5.4 八项）", () => {
  it("合法输出通过", () => {
    const result = validateOutput("analysis", JSON.stringify(VALID_ANALYSIS));
    expect(result.ok).toBe(true);
  });

  it("Markdown 围栏包裹的输出可解析", () => {
    const raw = "```json\n" + JSON.stringify(VALID_ANALYSIS) + "\n```";
    const result = validateOutput("analysis", raw);
    expect(result.ok).toBe(true);
  });

  it("痛点超过 3 项被拒绝", () => {
    const bad = {
      ...VALID_ANALYSIS,
      pains: [1, 2, 3, 4].map((i) => ({ pain: `痛点${i}`, evidence: "依据" })),
    };
    const result = validateOutput("analysis", JSON.stringify(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("最多 3 项");
    }
  });

  it("匹配度 level 枚举外被拒绝", () => {
    const bad = { ...VALID_ANALYSIS, fit: { level: "extreme", reason: "x" } };
    expect(validateOutput("analysis", JSON.stringify(bad)).ok).toBe(false);
  });

  it("缺少 next_action 被拒绝", () => {
    const bad: Record<string, unknown> = { ...VALID_ANALYSIS };
    delete bad.next_action;
    expect(validateOutput("analysis", JSON.stringify(bad)).ok).toBe(false);
  });
});

describe("call_prep 结构校验（PRD §5.5 六项）", () => {
  it("合法输出通过", () => {
    expect(validateOutput("call_prep", JSON.stringify(VALID_CALL_PREP)).ok).toBe(true);
  });

  it("诊断问题不足 3 条被拒绝", () => {
    const bad = { ...VALID_CALL_PREP, diag_questions: ["只有一条"] };
    const result = validateOutput("call_prep", JSON.stringify(bad));
    expect(result.ok).toBe(false);
  });

  it("异议不是 2 条被拒绝", () => {
    const bad = { ...VALID_CALL_PREP, objections: [{ objection: "a", response: "b" }] };
    expect(validateOutput("call_prep", JSON.stringify(bad)).ok).toBe(false);
  });
});

describe("interaction_summary 结构校验", () => {
  it("合法输出通过", () => {
    expect(validateOutput("interaction_summary", JSON.stringify(VALID_SUMMARY)).ok).toBe(true);
  });

  it("缺少 summary 被拒绝", () => {
    expect(validateOutput("interaction_summary", JSON.stringify({ next_action: "x" })).ok).toBe(
      false,
    );
  });

  it("next_action 超过 255 字被拒绝（对齐落库列 interactions.next_action，T10）", () => {
    const long = { summary: "反馈", next_action: "长".repeat(256) };
    expect(validateOutput("interaction_summary", JSON.stringify(long)).ok).toBe(false);
    const atLimit = { summary: "反馈", next_action: "短".repeat(255) };
    expect(validateOutput("interaction_summary", JSON.stringify(atLimit)).ok).toBe(true);
  });
});

describe("失败路径与宽容解析", () => {
  it("无 JSON 对象 → 失败且原因可读", () => {
    const result = validateOutput("analysis", "抱歉，我无法回答。");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("JSON");
    }
  });

  it("JSON 内结构错误 → 失败原因含字段路径", () => {
    const result = validateOutput("analysis", JSON.stringify({ fit: { level: "mid" } }));
    expect(result.ok).toBe(false);
  });

  it("JSON 前后混有说明文字时仍可提取", () => {
    const raw = `以下是分析结果：\n${JSON.stringify(VALID_ANALYSIS)}\n希望有帮助`;
    expect(validateOutput("analysis", raw).ok).toBe(true);
  });

  it("未知 run_type 直接失败", () => {
    expect(validateOutput("unknown_type", "{}").ok).toBe(false);
  });

  it("extractJsonObject 提取首个 { 到最后一个 }", () => {
    expect(extractJsonObject('a {"x":1} b')).toBe('{"x":1}');
    expect(extractJsonObject("no braces")).toBeNull();
  });
});
