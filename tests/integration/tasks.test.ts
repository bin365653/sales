import { afterAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import {
  completeTaskWithInteraction,
  createTask,
  listLeadTasks,
  listTasks,
  updateTask,
} from "@/server/services/tasks";
import { createInteraction } from "@/server/services/interactions";
import { startOfShanghaiDay } from "@/lib/tasks";
import type { TaskListQuery } from "@/lib/schemas/task";

// T07 任务管理验收项（实施计划 §9 / PRD §5.7 / UIUX P6）：
// - 任务 CRUD：必须关联客户；assignee = 线索负责人快照；越权一律 404；
// - 完成（complete-with-interaction）：completed_at 必须保留（验收项）+ 沟通记录 +
//   last_contact_at + K4 阶段联动 + 可选下一任务，单事务、失败整体回滚（对账）；
// - 今日/逾期视图：逾期判定跨日正确（上海日界，C13）；
// - 取消：只可取消不可删（C11）；已完成/已取消任务不可再编辑/取消。

afterAll(cleanupTestUsers);

const TASK_BASE = {
  type: "follow_up",
  title: "再次联系-验证客户",
  dueAt: "2026-10-26 14:00",
} as const;

/** 上海时区字符串 → Date（测试内固定时刻用） */
function shanghai(value: string): Date {
  return new Date(`${value.replace(" ", "T")}+08:00`);
}

function queryOf(overrides: Partial<TaskListQuery> = {}): TaskListQuery {
  return { view: "today", status: "all", page: 1, pageSize: 20, ...overrides };
}

async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      if (code) {
        expect(error.code).toBe(code);
      }
      return;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("新建任务（必须关联客户）", () => {
  it("创建成功：assignee = 线索负责人、createdBy = 操作人、截止时间按上海解释", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "任务归属客户" });

    const task = await createTask(sales, {
      leadId: lead.id,
      ...TASK_BASE,
    } as never);
    expect(task.assigneeId).toBe(sales.id);
    expect(task.createdBy).toBe(sales.id);
    expect(task.status).toBe("pending");
    expect(task.completedAt).toBeNull();
    // 2026-10-26 14:00 +08:00 = 06:00Z
    expect(task.dueAt.toISOString()).toBe("2026-10-26T06:00:00.000Z");
  });

  it("软删除客户不能新建任务（404）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "已删除客户任务" });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { deletedAt: new Date() },
    });
    await expectApiError(
      () => createTask(sales, { leadId: lead.id, ...TASK_BASE } as never),
      404,
    );
  });

  it("销售 A 给 B 的客户建任务：404（越权不暴露存在性）", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, { name: "B 的私有客户" });
    await expectApiError(
      () => createTask(a, { leadId: leadB.id, ...TASK_BASE } as never),
      404,
    );
  });
});

describe("今日/逾期视图（逾期判定跨日正确）", () => {
  it("今日含逾期置顶；逾期仅含截止日早于今天的待处理任务", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "视图验证客户" });
    const now = shanghai("2026-10-25 10:00");

    // 已逾期 2 天 / 已逾期 5 天 / 今天 14:00 / 明天 / 已完成 / 已取消
    await createTask(sales, {
      leadId: lead.id,
      type: "first_contact",
      title: "逾期5天",
      dueAt: "2026-10-20 09:00",
    } as never);
    const overdue1 = await createTask(sales, {
      leadId: lead.id,
      type: "first_contact",
      title: "逾期2天",
      dueAt: "2026-10-23 18:00",
    } as never);
    await createTask(sales, {
      leadId: lead.id,
      type: "needs_diag",
      title: "今天1400",
      dueAt: "2026-10-25 14:00",
    } as never);
    await createTask(sales, {
      leadId: lead.id,
      type: "revive",
      title: "明天",
      dueAt: "2026-10-26 09:00",
    } as never);
    const done = await createTask(sales, {
      leadId: lead.id,
      type: "quote_follow",
      title: "已完成",
      dueAt: "2026-10-20 09:00",
    } as never);
    await prisma.task.update({
      where: { id: done.id },
      data: { status: "done", completedAt: now },
    });
    await updateTask(sales, overdue1.id, { status: "canceled" });

    // 今日视图：逾期置顶（dueAt 升序）→ 逾期5天、今天1400；不含已完成/已取消/明天
    const todayView = await listTasks(sales, queryOf({ view: "today" }), { now });
    expect(todayView.items.map((item) => item.title)).toEqual([
      "逾期5天",
      "今天1400",
    ]);
    expect(todayView.total).toBe(2);
    // 工作台卡片口径：今日任务（截止日=今天）不含逾期
    expect(todayView.counts).toEqual({ today: 1, overdue: 1 });

    // 逾期视图：仅待处理且截止日 < 今天 00:00
    const overdueView = await listTasks(sales, queryOf({ view: "overdue" }), { now });
    expect(overdueView.items.map((item) => item.title)).toEqual(["逾期5天"]);
    expect(overdueView.total).toBe(1);

    // 全部视图 + 状态筛选（本用例共 5 条：逾期5天/逾期2天(取消)/今天1400/明天/已完成）
    const allDone = await listTasks(
      sales,
      queryOf({ view: "all", status: "done" }),
      { now },
    );
    expect(allDone.items.map((item) => item.title)).toEqual(["已完成"]);
    const allView = await listTasks(sales, queryOf({ view: "all" }), { now });
    expect(allView.total).toBe(5);
  });

  it("跨日正确：昨天 23:59 截止 → 今天 00:00 逾期；今天 00:00 截止 → 今天不算逾期", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "跨日客户" });
    await createTask(sales, {
      leadId: lead.id,
      type: "follow_up",
      title: "昨天2359",
      dueAt: "2026-10-24 23:59",
    } as never);
    await createTask(sales, {
      leadId: lead.id,
      type: "follow_up",
      title: "今天0000",
      dueAt: "2026-10-25 00:00",
    } as never);

    const boundary = shanghai("2026-10-25 00:00");
    const overdue = await listTasks(sales, queryOf({ view: "overdue" }), {
      now: boundary,
    });
    expect(overdue.items.map((item) => item.title)).toEqual(["昨天2359"]);
    const today = await listTasks(sales, queryOf({ view: "today" }), {
      now: boundary,
    });
    expect(today.items.map((item) => item.title)).toEqual(["昨天2359", "今天0000"]);

    // 今日视图查询上界 = 明日 00:00（上海）
    expect(startOfShanghaiDay(1, boundary).toISOString()).toBe(
      "2026-10-25T16:00:00.000Z",
    );
  });

  it("数据范围：销售仅本人客户的任务；管理员全量", async () => {
    const a = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const leadA = await createLead(a, { name: "A 的视图客户" });
    await createTask(a, { leadId: leadA.id, ...TASK_BASE } as never);

    const forA = await listTasks(a, queryOf({ view: "all" }));
    expect(forA.total).toBe(1);
    // 管理员全量：能看到 A 的任务（同测试运行中其他用例的任务也在内，只断言包含）
    const forAdmin = await listTasks(admin, queryOf({ view: "all" }));
    expect(forAdmin.total).toBeGreaterThanOrEqual(1);
    expect(forAdmin.items.some((item) => item.leadId === leadA.id)).toBe(true);
    const other = await createTestUser("sales");
    const forOther = await listTasks(other, queryOf({ view: "all" }));
    expect(forOther.total).toBe(0);
  });
});

describe("编辑与取消（C11 只可取消不可删）", () => {
  it("待处理任务可编辑标题/截止时间/备注", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "编辑客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);

    const updated = await updateTask(sales, task.id, {
      title: "改名后的任务",
      dueAt: "2026-10-27 09:00",
      remark: "优先打手机",
    } as never);
    expect(updated.title).toBe("改名后的任务");
    expect(updated.dueAt.toISOString()).toBe("2026-10-27T01:00:00.000Z");
    expect(updated.remark).toBe("优先打手机");
  });

  it("取消后状态 canceled；再编辑/再取消被拒（400）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "取消客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);

    const canceled = await updateTask(sales, task.id, { status: "canceled" } as never);
    expect(canceled.status).toBe("canceled");

    await expectApiError(
      () => updateTask(sales, task.id, { title: "再改" } as never),
      400,
      "task_not_editable",
    );
    await expectApiError(
      () => updateTask(sales, task.id, { status: "canceled" } as never),
      400,
      "task_not_editable",
    );
  });

  it("越权：销售 A 编辑/取消 B 的任务一律 404；管理员可操作", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const leadB = await createLead(b, { name: "B 的任务客户" });
    const taskB = await createTask(b, { leadId: leadB.id, ...TASK_BASE } as never);

    await expectApiError(
      () => updateTask(a, taskB.id, { title: "越权改" } as never),
      404,
    );
    const byAdmin = await updateTask(admin, taskB.id, {
      remark: "管理员备注",
    } as never);
    expect(byAdmin.remark).toBe("管理员备注");
  });
});

describe("完成任务弹窗（单事务：done + completed_at + 沟通记录 + K4 + 下一任务）", () => {
  const interactionInput = {
    occurredAt: "2026-10-25 15:00",
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: true,
    feedback: "客户确认下周安排演示",
  };

  it("完成后 completed_at 保留、interaction_id 回填、last_contact_at 更新、版本 +1", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "完成基础客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);

    const result = await completeTaskWithInteraction(sales, task.id, {
      interaction: interactionInput,
      nextTask: null,
    } as never);

    expect(result.task.status).toBe("done");
    expect(result.task.completedAt).not.toBeNull();
    expect(result.task.interactionId).toBe(result.interaction.id);
    expect(result.nextTask).toBeNull();
    expect(result.stageAdvanced).toBeNull();

    const interaction = await prisma.interaction.findUniqueOrThrow({
      where: { id: result.interaction.id },
    });
    expect(interaction.leadId).toBe(lead.id);
    expect(interaction.userId).toBe(sales.id);
    expect(interaction.effective).toBe(true);
    // 2026-10-25 15:00 +08:00 = 07:00Z
    expect(interaction.occurredAt.toISOString()).toBe("2026-10-25T07:00:00.000Z");

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.lastContactAt?.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    expect(after.dataVersion).toBe(2);
  });

  it("K4：勾选合格自动推进阶段并留痕（reason/triggers），与完成任务同事务", async () => {
    const sales = await createTestUser("sales");
    const qualified = await getPresetStage("qualified");
    const newLeadStage = await getPresetStage("new_lead");
    const lead = await createLead(sales, { name: "完成K4客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);

    const result = await completeTaskWithInteraction(sales, task.id, {
      interaction: { ...interactionInput, isQualified: true },
      nextTask: null,
    } as never);
    expect(result.stageAdvanced).toEqual({
      fromStageId: newLeadStage.id,
      toStageId: qualified.id,
    });

    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, eventType: "stage_changed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({
      reason: "interaction_advance",
      interactionId: result.interaction.id,
      triggers: ["is_qualified"],
    });
  });

  it("下一任务同事务创建：归属线索负责人、截止时间按上海解释", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "下一任务客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);

    const result = await completeTaskWithInteraction(sales, task.id, {
      interaction: interactionInput,
      nextTask: {
        type: "online_demo",
        title: "线上演示-下一任务客户",
        dueAt: "2026-10-28 10:00",
      },
    } as never);

    expect(result.nextTask).not.toBeNull();
    expect(result.nextTask!.assigneeId).toBe(sales.id);
    expect(result.nextTask!.createdBy).toBe(sales.id);
    expect(result.nextTask!.status).toBe("pending");
    expect(result.nextTask!.dueAt.toISOString()).toBe("2026-10-28T02:00:00.000Z");
  });

  it("重复完成被拒（400 task_not_editable），不产生第二条沟通记录", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "重复完成客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);
    await completeTaskWithInteraction(sales, task.id, {
      interaction: interactionInput,
      nextTask: null,
    } as never);

    await expectApiError(
      () =>
        completeTaskWithInteraction(sales, task.id, {
          interaction: interactionInput,
          nextTask: null,
        } as never),
      400,
      "task_not_editable",
    );
    const count = await prisma.interaction.count({ where: { leadId: lead.id } });
    expect(count).toBe(1);
  });

  it("事务回滚对账：沟通写入失败 → 任务仍待处理、completed_at 为空、无下一任务", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "完成回滚客户" });
    const task = await createTask(sales, { leadId: lead.id, ...TASK_BASE } as never);
    const versionBefore = lead.dataVersion;

    // 强制事务内 interaction.create 抛错（真实事务回调抛错 → Prisma 自动 ROLLBACK）
    const original = prisma.$transaction.bind(prisma) as unknown as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce((async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: unknown,
      ) => {
        return original(async (tx) => {
          const failing: Prisma.TransactionClient = new Proxy(tx, {
            get(target, prop) {
              if (prop === "interaction") {
                return new Proxy(
                  Reflect.get(target, prop, target) as typeof target.interaction,
                  {
                    get(t, p) {
                      if (p === "create") {
                        return async () => {
                          throw new Error("forced failure for rollback test");
                        };
                      }
                      return Reflect.get(t, p, t);
                    },
                  },
                );
              }
              return Reflect.get(target, prop, target);
            },
          });
          return fn(failing);
        }, options);
      }) as unknown as typeof prisma.$transaction);

    await expect(
      completeTaskWithInteraction(sales, task.id, {
        interaction: interactionInput,
        nextTask: { type: "follow_up", title: "回滚不应存在", dueAt: "2026-10-30 09:00" },
      } as never),
    ).rejects.toThrow("forced failure for rollback test");
    spy.mockRestore();

    const afterTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(afterTask.status).toBe("pending");
    expect(afterTask.completedAt).toBeNull();
    expect(afterTask.interactionId).toBeNull();
    const interactionCount = await prisma.interaction.count({
      where: { leadId: lead.id },
    });
    expect(interactionCount).toBe(0);
    const nextTaskCount = await prisma.task.count({
      where: { leadId: lead.id, title: "回滚不应存在" },
    });
    expect(nextTaskCount).toBe(0);
    const afterLead = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(afterLead.dataVersion).toBe(versionBefore);
    expect(afterLead.lastContactAt).toBeNull();
  });

  it("越权：销售 A 完成 B 的任务 404", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, { name: "B 的完成私有客户" });
    const taskB = await createTask(b, { leadId: leadB.id, ...TASK_BASE } as never);
    await expectApiError(
      () =>
        completeTaskWithInteraction(a, taskB.id, {
          interaction: interactionInput,
          nextTask: null,
        } as never),
      404,
    );
  });
});

describe("沟通保存同时创建任务（UIUX P5，同事务）", () => {
  it("createTask 与沟通记录同事务落库：任务归属线索负责人", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "沟通建任务客户" });

    const result = await createInteraction(sales, lead.id, {
      occurredAt: "2026-10-25 10:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      nextContactAt: "2026-10-28 10:00",
      createTask: {
        type: "needs_diag",
        title: "需求诊断-沟通建任务客户",
        dueAt: "2026-10-28 10:00",
      },
    } as never);

    expect(result.createdTask).not.toBeNull();
    expect(result.createdTask!.assigneeId).toBe(sales.id);
    expect(result.createdTask!.type).toBe("needs_diag");
    expect(result.createdTask!.dueAt.toISOString()).toBe("2026-10-28T02:00:00.000Z");

    const count = await prisma.task.count({ where: { leadId: lead.id } });
    expect(count).toBe(1);
  });

  it("回滚对账：任务创建失败 → 沟通记录与线索副作用一并回滚", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "沟通建任务回滚客户" });
    const versionBefore = lead.dataVersion;

    const original = prisma.$transaction.bind(prisma) as unknown as (
      fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: unknown,
    ) => Promise<unknown>;
    const spy = vi
      .spyOn(prisma, "$transaction")
      .mockImplementationOnce((async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: unknown,
      ) => {
        return original(async (tx) => {
          const failing: Prisma.TransactionClient = new Proxy(tx, {
            get(target, prop) {
              if (prop === "task") {
                return new Proxy(
                  Reflect.get(target, prop, target) as typeof target.task,
                  {
                    get(t, p) {
                      if (p === "create") {
                        return async () => {
                          throw new Error("forced task failure");
                        };
                      }
                      return Reflect.get(t, p, t);
                    },
                  },
                );
              }
              return Reflect.get(target, prop, target);
            },
          });
          return fn(failing);
        }, options);
      }) as unknown as typeof prisma.$transaction);

    await expect(
      createInteraction(sales, lead.id, {
        occurredAt: "2026-10-25 10:00",
        channel: "phone",
        direction: "outbound",
        connected: true,
        effective: true,
        createTask: {
          type: "needs_diag",
          title: "不应存在",
          dueAt: "2026-10-28 10:00",
        },
      } as never),
    ).rejects.toThrow("forced task failure");
    spy.mockRestore();

    expect(await prisma.interaction.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await prisma.task.count({ where: { leadId: lead.id } })).toBe(0);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.dataVersion).toBe(versionBefore);
    expect(after.lastContactAt).toBeNull();
  });
});

describe("客户详情任务列表（P5 任务区块）", () => {
  it("待处理在前（截止时间升序），已完成/已取消按完成时间倒序殿后", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "详情列表客户" });
    const early = await createTask(sales, {
      leadId: lead.id,
      type: "follow_up",
      title: "待处理早",
      dueAt: "2026-10-25 09:00",
    } as never);
    const late = await createTask(sales, {
      leadId: lead.id,
      type: "follow_up",
      title: "待处理晚",
      dueAt: "2026-10-25 18:00",
    } as never);
    const doneA = await createTask(sales, {
      leadId: lead.id,
      type: "first_contact",
      title: "完成A",
      dueAt: "2026-10-20 09:00",
    } as never);
    const doneB = await createTask(sales, {
      leadId: lead.id,
      type: "first_contact",
      title: "完成B",
      dueAt: "2026-10-21 09:00",
    } as never);
    await prisma.task.update({
      where: { id: doneA.id },
      data: { status: "done", completedAt: shanghai("2026-10-22 10:00") },
    });
    await prisma.task.update({
      where: { id: doneB.id },
      data: { status: "done", completedAt: shanghai("2026-10-23 10:00") },
    });

    const rows = await listLeadTasks(sales, lead.id);
    expect(rows.map((row) => row.title)).toEqual([
      "待处理早",
      "待处理晚",
      "完成B",
      "完成A",
    ]);
    void early;
    void late;
  });

  it("越权：销售 A 查看 B 客户的任务列表 404", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, { name: "B 的列表客户" });
    await expectApiError(() => listLeadTasks(a, leadB.id), 404);
  });
});
