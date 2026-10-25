import { describe, expect, it } from "vitest";
import {
  interactionCreateWithTaskSchema,
  nextTaskSchema,
  taskCompleteSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from "@/lib/schemas/task";
import { TASK_STATUSES, TASK_TYPES } from "@/lib/tasks";

// T07 任务 Schema 固化（PRD §5.7）：7 种类型枚举、关联客户必填、
// 标题/截止时间必填；取消与其他字段禁止混提；完成弹窗复用沟通 Schema
// （effective 依赖 connected 的交叉规则继承）；列表查询默认值。

const UUID_A = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";

function baseTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leadId: UUID_A,
    type: "follow_up",
    title: "再次联系-某客户",
    dueAt: "2026-10-26 14:00",
    ...overrides,
  };
}

describe("taskCreateSchema", () => {
  it("7 种任务类型全部可提交；备注空串归一化为 null", () => {
    for (const type of TASK_TYPES) {
      const parsed = taskCreateSchema.parse(baseTask({ type }));
      expect(parsed.type).toBe(type);
    }
    const cleared = taskCreateSchema.parse(baseTask({ remark: "  " }));
    expect(cleared.remark).toBeNull();
  });

  it.each([
    ["leadId 缺失", { leadId: undefined }],
    ["type 非法", { type: "urgent" }],
    ["title 空白", { title: "   " }],
    ["title 超长", { title: "长".repeat(129) }],
    ["dueAt 格式非法", { dueAt: "10月26日" }],
  ])("%s 被拒绝", (_label, overrides) => {
    const result = taskCreateSchema.safeParse(baseTask(overrides));
    expect(result.success).toBe(false);
  });

  it("dueAt 允许纯日期（按当日 00:00 上海解释）", () => {
    const parsed = taskCreateSchema.parse(baseTask({ dueAt: "2026-10-26" }));
    expect(parsed.dueAt).toBe("2026-10-26");
  });
});

describe("taskUpdateSchema", () => {
  it("编辑字段可单独提交；取消必须独占请求", () => {
    expect(taskUpdateSchema.parse({ title: "新标题" }).title).toBe("新标题");
    expect(taskUpdateSchema.parse({ status: "canceled" }).status).toBe("canceled");
  });

  it("取消与其他字段混提被拒绝；空请求被拒绝", () => {
    expect(
      taskUpdateSchema.safeParse({ status: "canceled", title: "混提" }).success,
    ).toBe(false);
    expect(taskUpdateSchema.safeParse({}).success).toBe(false);
  });

  it("status 仅接受 canceled（完成必须走 complete-with-interaction）", () => {
    expect(taskUpdateSchema.safeParse({ status: "done" }).success).toBe(false);
  });
});

describe("taskCompleteSchema（完成弹窗：沟通结果 + 下一任务）", () => {
  it("复用 interactionCreateSchema：未接通不能标记有效沟通", () => {
    const result = taskCompleteSchema.safeParse({
      interaction: {
        occurredAt: "2026-10-25 10:00",
        channel: "phone",
        direction: "outbound",
        connected: false,
        effective: true,
      },
      nextTask: null,
    });
    expect(result.success).toBe(false);
  });

  it("nextTask 可省略；下一任务标题/截止时间必填", () => {
    const without = taskCompleteSchema.parse({
      interaction: {
        occurredAt: "2026-10-25 10:00",
        channel: "phone",
        direction: "outbound",
        connected: true,
        effective: true,
      },
    });
    expect(without.nextTask).toBeUndefined();

    expect(
      nextTaskSchema.safeParse({ type: "follow_up", title: "再次联系" }).success,
    ).toBe(false);
  });
});

describe("interactionCreateWithTaskSchema（沟通保存同时创建任务）", () => {
  it("createTask 与沟通字段同 payload 校验", () => {
    const parsed = interactionCreateWithTaskSchema.parse({
      occurredAt: "2026-10-25 10:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      createTask: {
        type: "needs_diag",
        title: "需求诊断-某客户",
        dueAt: "2026-10-28 10:00",
      },
    });
    expect(parsed.createTask?.type).toBe("needs_diag");
  });

  it("createTask 为 null 时不创建任务", () => {
    const parsed = interactionCreateWithTaskSchema.parse({
      occurredAt: "2026-10-25 10:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      createTask: null,
    });
    expect(parsed.createTask).toBeNull();
  });
});

describe("taskListQuerySchema", () => {
  it("默认今日视图 + 全部状态 + 第 1 页 20 条", () => {
    const parsed = taskListQuerySchema.parse({});
    expect(parsed).toEqual({ view: "today", status: "all", page: 1, pageSize: 20 });
  });

  it("URL 查询字符串可解析；非法视图拒绝", () => {
    expect(taskListQuerySchema.parse({ view: "overdue", page: "3" }).page).toBe(3);
    expect(taskListQuerySchema.safeParse({ view: "yesterday" }).success).toBe(false);
  });
});

describe("枚举完整性", () => {
  it("状态枚举 = 待处理/已完成/已取消（PRD §5.7）", () => {
    expect(TASK_STATUSES).toEqual(["pending", "done", "canceled"]);
  });
});
