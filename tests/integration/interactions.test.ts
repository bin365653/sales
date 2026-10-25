import { afterAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
} from "./helpers";
import { createLead, transitionStage } from "@/server/services/leads";
import {
  createInteraction,
  listInteractions,
  updateInteraction,
} from "@/server/services/interactions";

// T06 沟通记录验收项（实施计划 §9）：
// - 保存事务：记录 + last_contact_at + next_contact_at + "本次确认"核实状态 +
//   K4 条件推进阶段，任一步失败整体回滚（回滚用例强制线索行更新失败后对账）；
// - K4：勾选合格/预约自动推进并留痕（stage_changed 事件含 reason/triggers），
//   只进不退，目标停用/缺失不动作，双勾选推进到更远目标且单条事件；
// - M11 修正留痕：edit_audit 追加谁/何时/改了什么（from/to），无变化幂等；
// - 越权：销售 A/B 互不可见（404），管理员全量可读。

afterAll(cleanupTestUsers);

function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    occurredAt: "2026-10-24 10:00",
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: true,
    ...overrides,
  };
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

describe("保存沟通记录（事务副作用）", () => {
  it("保存后 last_contact_at / next_contact_at 更新，线索版本 +1，记录归属当前用户", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "沟通基础验证客户" });
    expect(lead.lastContactAt).toBeNull();

    const result = await createInteraction(
      sales,
      lead.id,
      baseInput({ nextContactAt: "2026-10-30 09:00" }) as never,
    );
    expect(result.stageAdvanced).toBeNull();
    expect(result.interaction.leadId).toBe(lead.id);
    expect(result.interaction.userId).toBe(sales.id);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    // 2026-10-24 10:00 +08:00 = 02:00Z；下次联系同规则（10-30 09:00 = 01:00Z）
    expect(after.lastContactAt?.toISOString()).toBe("2026-10-24T02:00:00.000Z");
    expect(after.nextContactAt?.toISOString()).toBe("2026-10-30T01:00:00.000Z");
    expect(after.dataVersion).toBe(2);
  });

  it("补录更早的沟通不回退最近联系时间；未填下次联系时间不动既有计划", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "补录验证客户" });
    await createInteraction(sales, lead.id, {
      ...baseInput({ occurredAt: "2026-10-25 12:00" }),
      nextContactAt: "2026-11-02 09:00",
    } as never);
    await createInteraction(
      sales,
      lead.id,
      baseInput({ occurredAt: "2026-10-20 09:00" }) as never,
    );

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.lastContactAt?.toISOString()).toBe("2026-10-25T04:00:00.000Z");
    expect(after.nextContactAt?.toISOString()).toBe("2026-11-02T01:00:00.000Z");
  });

  it("'本次确认'仅提交时把对应画像核实状态置为已确认", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "核实确认客户" });
    const result = await createInteraction(
      sales,
      lead.id,
      baseInput({ confirmCurrentSystem: true, confirmPurchaseTime: true }) as never,
    );
    expect(result.factStatusConfirmed).toEqual([
      "current_system",
      "purchase_time",
    ]);

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.currentSystemStatus).toBe("confirmed");
    expect(after.purchaseTimeStatus).toBe("confirmed");
    expect(after.contractExpiryStatus).toBe("unknown");
  });

  it("软删除客户的线索不能新增沟通（404）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "已删除客户沟通" });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { deletedAt: new Date() },
    });
    await expectApiError(
      () =>
        createInteraction(sales, lead.id, baseInput() as never),
      404,
    );
  });
});

describe("K4 阶段联动（勾选合格/预约自动推进并留痕）", () => {
  it("勾选合格：推进到合格商机，写 stage_changed 事件（reason/triggers/快照），版本 +1", async () => {
    const sales = await createTestUser("sales");
    const newLeadStage = await getPresetStage("new_lead");
    const qualified = await getPresetStage("qualified");
    const lead = await createLead(sales, { name: "合格推进客户" });

    const result = await createInteraction(
      sales,
      lead.id,
      baseInput({ isQualified: true }) as never,
    );
    expect(result.stageAdvanced).toEqual({
      fromStageId: newLeadStage.id,
      toStageId: qualified.id,
    });

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stageId).toBe(qualified.id);
    expect(after.dataVersion).toBe(2);

    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, eventType: "stage_changed" },
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actorId).toBe(sales.id);
    expect(event.fromStageId).toBe(newLeadStage.id);
    expect(event.toStageId).toBe(qualified.id);
    expect(event.stageSnapshot).toMatchObject({
      from: { semanticKey: "new_lead" },
      to: { semanticKey: "qualified", code: qualified.code, name: qualified.name },
    });
    expect(event.detail).toMatchObject({
      reason: "interaction_advance",
      interactionId: result.interaction.id,
      triggers: ["is_qualified"],
    });
  });

  it("同时勾选合格与预约：推进到排序更远的目标，单条事件记录两个触发", async () => {
    const sales = await createTestUser("sales");
    const bookedDemo = await getPresetStage("booked_demo");
    const lead = await createLead(sales, { name: "双勾选推进客户" });

    const result = await createInteraction(
      sales,
      lead.id,
      baseInput({ isQualified: true, demoBooked: true }) as never,
    );
    expect(result.stageAdvanced?.toStageId).toBe(bookedDemo.id);

    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, eventType: "stage_changed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({
      triggers: ["is_qualified", "demo_booked"],
    });
  });

  it("只进不退：线索已处于更晚阶段时不推进、不写事件", async () => {
    const sales = await createTestUser("sales");
    const quoted = await getPresetStage("quoted");
    const lead = await createLead(sales, { name: "不回退客户" });
    await transitionStage(sales, lead.id, {
      stageId: quoted.id,
      dataVersion: lead.dataVersion,
    });

    const result = await createInteraction(
      sales,
      lead.id,
      baseInput({ isQualified: true, demoBooked: true }) as never,
    );
    expect(result.stageAdvanced).toBeNull();

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stageId).toBe(quoted.id);
    const advanceEvents = await prisma.leadEvent.count({
      where: { leadId: lead.id, eventType: "stage_changed", detail: { path: ["reason"], equals: "interaction_advance" } },
    });
    expect(advanceEvents).toBe(0);
  });

  it("目标阶段已停用：不自动推进（用户可手动流转）", async () => {
    const sales = await createTestUser("sales");
    const qualified = await getPresetStage("qualified");
    const lead = await createLead(sales, { name: "停用阶段客户" });
    await prisma.leadStage.update({
      where: { id: qualified.id },
      data: { isActive: false },
    });
    try {
      const result = await createInteraction(
        sales,
        lead.id,
        baseInput({ isQualified: true }) as never,
      );
      expect(result.stageAdvanced).toBeNull();
      const after = await prisma.lead.findUniqueOrThrow({
        where: { id: lead.id },
      });
      expect(after.stageId).toBe(lead.stageId);
    } finally {
      await prisma.leadStage.update({
        where: { id: qualified.id },
        data: { isActive: true },
      });
    }
  });
});

describe("修正与留痕（M11）", () => {
  it("修正追加 edit_audit（谁/何时/改了什么 from→to），原值可追溯", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "修正留痕客户" });
    const created = await createInteraction(sales, lead.id, {
      ...baseInput({ effective: true, occurredAt: "2026-10-24 10:00" }),
      feedback: "初始反馈",
    } as never);

    const updated = await updateInteraction(sales, created.interaction.id, {
      occurredAt: "2026-10-24 11:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: false,
      feedback: "修正后的反馈",
    } as never);

    const audit = Array.isArray(updated.interaction.editAudit)
      ? (updated.interaction.editAudit as Record<string, unknown>[])
      : [];
    expect(audit).toHaveLength(1);
    expect(audit[0]!.by).toBe(sales.id);
    expect(typeof audit[0]!.at).toBe("string");
    expect(audit[0]!.changed).toMatchObject({
      occurred_at: {
        from: "2026-10-24T02:00:00.000Z",
        to: "2026-10-24T03:00:00.000Z",
      },
      effective: { from: true, to: false },
      feedback: { from: "初始反馈", to: "修正后的反馈" },
    });

    // 未提交字段保持原值
    expect(updated.interaction.channel).toBe("phone");
  });

  it("提交内容与现值一致：幂等返回，不升版本、不追加审计", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "幂等修正客户" });
    const created = await createInteraction(
      sales,
      lead.id,
      baseInput({ feedback: "一致反馈" }) as never,
    );
    const versionBefore = (
      await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    ).dataVersion;

    const again = await updateInteraction(sales, created.interaction.id, {
      occurredAt: "2026-10-24 10:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      feedback: "一致反馈",
    } as never);

    expect(again.interaction.editAudit ?? null).toBeNull();
    const versionAfter = (
      await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })
    ).dataVersion;
    expect(versionAfter).toBe(versionBefore);
  });

  it("修正旧记录不同步下次联系时间；修正最新一条才同步", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "下次联系同步客户" });
    const older = await createInteraction(sales, lead.id, {
      ...baseInput({ occurredAt: "2026-10-20 09:00" }),
      nextContactAt: "2026-10-30 09:00",
    } as never);
    const latest = await createInteraction(sales, lead.id, {
      ...baseInput({ occurredAt: "2026-10-25 09:00" }),
      nextContactAt: "2026-10-31 09:00",
    } as never);

    // 修正旧记录的下次联系时间 → 不覆盖最新计划
    await updateInteraction(sales, older.interaction.id, {
      occurredAt: "2026-10-20 09:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      nextContactAt: "2026-12-01 09:00",
    } as never);
    const mid = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(mid.nextContactAt?.toISOString()).toBe("2026-10-31T01:00:00.000Z");

    // 修正最新一条 → 同步
    await updateInteraction(sales, latest.interaction.id, {
      occurredAt: "2026-10-25 09:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      nextContactAt: "2026-12-05 09:00",
    } as never);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.nextContactAt?.toISOString()).toBe("2026-12-05T01:00:00.000Z");
    expect(after.lastContactAt?.toISOString()).toBe("2026-10-25T01:00:00.000Z");
  });
});

describe("事务回滚验证（验收项）", () => {
  it("线索行更新失败时整体回滚：沟通记录不落库、线索字段不变", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "回滚验证客户" });
    const versionBefore = lead.dataVersion;

    // 强制事务内 lead.updateMany 抛错（真实事务回调抛错 → Prisma 自动 ROLLBACK）
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
              if (prop === "lead") {
                return new Proxy(
                  Reflect.get(target, prop, target) as typeof target.lead,
                  {
                    get(t, p) {
                      if (p === "updateMany") {
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
      createInteraction(sales, lead.id, baseInput() as never),
    ).rejects.toThrow("forced failure for rollback test");
    spy.mockRestore();

    const count = await prisma.interaction.count({ where: { leadId: lead.id } });
    expect(count).toBe(0);
    const after = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.lastContactAt).toBeNull();
    expect(after.dataVersion).toBe(versionBefore);
    const events = await prisma.leadEvent.count({ where: { leadId: lead.id } });
    expect(events).toBe(1); // 仅 created
  });
});

describe("列表与越权", () => {
  it("列表按沟通时间倒序；管理员可读（C10）", async () => {
    const sales = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const lead = await createLead(sales, { name: "列表排序客户" });
    for (const occurredAt of ["2026-10-22 09:00", "2026-10-24 09:00", "2026-10-23 09:00"]) {
      await createInteraction(
        sales,
        lead.id,
        baseInput({ occurredAt }) as never,
      );
    }

    const rows = await listInteractions(sales, lead.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.occurredAt.getTime())).toEqual(
      [...rows.map((row) => row.occurredAt.getTime())].sort((a, b) => b - a),
    );

    const forAdmin = await listInteractions(admin, lead.id);
    expect(forAdmin).toHaveLength(3);
  });

  it("销售 A 对 B 的线索/沟通记录：新增、列表、修正一律 404", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, { name: "B 的沟通私有客户" });
    const created = await createInteraction(b, leadB.id, baseInput() as never);

    await expectApiError(
      () => createInteraction(a, leadB.id, baseInput() as never),
      404,
    );
    await expectApiError(() => listInteractions(a, leadB.id), 404);
    await expectApiError(
      () =>
        updateInteraction(a, created.interaction.id, {
          occurredAt: "2026-10-24 10:00",
          channel: "phone",
          direction: "outbound",
          connected: true,
          effective: true,
        } as never),
      404,
    );

    // B 本人正常读写
    const rows = await listInteractions(b, leadB.id);
    expect(rows).toHaveLength(1);
  });
});
