// E2E Mock AI Provider（T18）：本地 OpenAI 兼容 /chat/completions 假服务。
// 按 system 提示词关键词分发三种 runType 的固定结构化输出（与
// src/server/ai/validator.ts 的 Zod Schema 严格对齐，含约束条数），
// 供核心闭环 E2E 断言界面渲染。node tests/e2e/mock-ai-server.cjs
/* eslint-disable @typescript-eslint/no-require-imports -- Node 端 .cjs 假服务脚本，CommonJS 有意为之 */
const http = require("node:http");

const PORT = Number(process.env.MOCK_AI_PORT || 4599);

function analysisOutput() {
  return {
    fit: { level: "high", reason: "E2E 演练：客户规模、行业与采购窗口均匹配目标画像" },
    facts: [
      { topic: "在用系统", detail: "E2E Mock：当前用 Excel 管理客户资料", status: "confirmed" },
      { topic: "采购时间", detail: "E2E Mock：约在本季度启动选型", status: "unverified" },
    ],
    pains: [
      { pain: "客户资料分散在表格，多人跟进易撞单", evidence: "输入资料提到“用 Excel 记录、经常撞单”" },
    ],
    angles: ["先把客户资料集中到统一线索池", "再演示跟进提醒与阶段推进"],
    next_action: "预约 30 分钟演示，重点演示线索池与任务提醒",
    verify_questions: [
      "目前有几个人同时维护客户资料？",
      "本次选型的预算范围大概是多少？",
    ],
  };
}

function callPrepOutput() {
  return {
    goal: "确认选型时间表与决策流程，争取约定产品演示",
    opening: "E2E Mock 开场白：您好，上次沟通中您提到想在本季度内完成选型，今天想跟您对齐一下时间表。",
    diag_questions: [
      "现在几个系统之间数据怎么打通？",
      "切换系统时最担心停机还是数据迁移？",
      "预算是已经立项还是需要走审批？",
    ],
    objections: [
      { objection: "担心数据迁移工作量太大", response: "提供模板化导入与专人迁移支持，历史资料一天内完成迁移" },
      { objection: "团队年纪大不好上手", response: "界面按销售动线设计，提供一次上手培训与一个月陪跑" },
    ],
    confirm_next: "确认下周三下午 3 点的线上演示时间",
    avoid: ["不要承诺未核实的折扣力度", "不要贬低客户在用系统"],
  };
}

function interactionSummaryOutput() {
  return {
    summary: "E2E Mock 摘要：客户认可方案方向，两人团队用表格管理经常撞单，约定本周内发送报价并安排演示。",
    next_action: "发送报价单并约定演示时间",
  };
}

// V2.0-T11 跟进策略助手：原因解释（与任务来源一致）+ 沟通建议
function followupAdviceOutput() {
  return {
    reason_explanation:
      "E2E Mock：该客户由系统按到期月度强制规则生成本月跟进任务（软件处于半年内窗口）。",
    communication_advice:
      "E2E Mock 建议：结合象限经营建议核实续费意向，并确认当前系统的使用痛点。",
  };
}

function pickOutput(systemText) {
  if (systemText.includes("电话准备卡")) {
    return callPrepOutput();
  }
  if (systemText.includes("沟通摘要")) {
    return interactionSummaryOutput();
  }
  if (systemText.includes("跟进策略助手")) {
    return followupAdviceOutput();
  }
  return analysisOutput();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/healthz" || req.url.startsWith("/v1/models"))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, data: [{ id: "e2e-mock" }] }));
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let systemText = "";
    try {
      const body = JSON.parse(raw || "{}");
      const system = (body.messages || []).find((m) => m.role === "system");
      systemText = system?.content ?? "";
    } catch {
      // 保持空 systemText，走默认 analysis 分支
    }
    const content = JSON.stringify(pickOutput(systemText));
    const body = JSON.stringify({
      id: "chatcmpl-e2e-mock-" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "e2e-mock",
      choices: [
        { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 128, completion_tokens: 256, total_tokens: 384 },
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("[mock-ai] listening on http://127.0.0.1:" + PORT);
});
