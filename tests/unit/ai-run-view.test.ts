import { describe, expect, it } from "vitest";
import { toAiRunView } from "@/lib/ai-run-view";

// T09 视图映射单测：服务端首屏（Date 对象）与客户端轮询（API JSON，ISO 字符串）
// 两条路径共用 toAiRunView，产出字段口径一致（面板渲染与展示字段不因来源而异）。

const NOW = new Date("2026-10-26T02:00:00.000Z");

const SERVER_SHAPE = {
  id: "run-1",
  runType: "analysis",
  status: "success",
  errorType: null,
  errorMessage: null,
  output: { fit: { level: "mid", reason: "x" } },
  durationMs: 120,
  retryOfId: null,
  inputDataVersion: 3,
  createdAt: NOW,
  modelConfig: { provider: "openai_compatible", modelName: "m1" },
  promptVersion: { version: 2 },
};

describe("toAiRunView", () => {
  it("服务层 Date 形态与 API ISO 字符串形态产出一致视图", () => {
    const fromServer = toAiRunView(SERVER_SHAPE as unknown as Parameters<typeof toAiRunView>[0]);
    const fromApi = toAiRunView({
      ...SERVER_SHAPE,
      createdAt: NOW.toISOString(),
    } as unknown as Parameters<typeof toAiRunView>[0]);
    expect(fromServer).toEqual(fromApi);
    expect(fromServer.createdAt).toBe("2026-10-26T02:00:00.000Z");
  });

  it("映射展示字段：模型名/服务商/提示词版本；缺省关系容错为 null", () => {
    const view = toAiRunView(SERVER_SHAPE as unknown as Parameters<typeof toAiRunView>[0]);
    expect(view.modelName).toBe("m1");
    expect(view.provider).toBe("openai_compatible");
    expect(view.promptVersion).toBe(2);
    expect(view.inputDataVersion).toBe(3);

    const bare = toAiRunView({
      id: "run-2",
      runType: "call_prep",
      status: "pending",
      createdAt: NOW.toISOString(),
    } as unknown as Parameters<typeof toAiRunView>[0]);
    expect(bare.modelName).toBeNull();
    expect(bare.provider).toBeNull();
    expect(bare.promptVersion).toBeNull();
    expect(bare.output).toBeNull();
    expect(bare.status).toBe("pending");
  });
});
