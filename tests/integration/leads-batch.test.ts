import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { leadBatchUpdateSchema } from "@/lib/schemas/lead";
import {
  cleanupTestUsers,
  createTestStage,
  createTestUser,
  getPresetStage,
} from "./helpers";
import { batchUpdateLeads, createLead } from "@/server/services/leads";

// T04 验收项「批量仅限允许字段」+ 批量安全语义（§8.2）：
// - 白名单字段批量生效，全程留痕（updated 事件带 batch 标记 + 审计）；
// - 阶段批量流转走单条同一套校验与快照留痕；同阶段跳过不写事件不 bump；
// - ids 混入他人线索 / 不存在 / 已删除 → 整体拒绝（404），数据零变更；
// - 停用阶段、停用的 source 内置字段 → 400；
// - 管理员可批量修改任何销售的线索（C10）。

afterAll(cleanupTestUsers);

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

describe("批量修改：白名单字段生效与留痕", () => {
  it("批量改 priority/source/nextContactAt：值生效、版本 +1、updated 事件带 batch 标记、写审计", async () => {
    const sales = await createTestUser("sales");
    const a = await createLead(sales, { name: "批量客户甲", city: "武汉" });
    const b = await createLead(sales, { name: "批量客户乙", city: "武汉" });
    const input = leadBatchUpdateSchema.parse({
      ids: [a.id, b.id],
      changes: {
        priority: "high",
        source: "展会",
        nextContactAt: "2026-10-27 10:00",
      },
    });

    const result = await batchUpdateLeads(sales, input);
    expect(result).toEqual({ total: 2, updated: 2, skipped: 0 });

    const rows = await prisma.lead.findMany({ where: { id: { in: [a.id, b.id] } } });
    for (const row of rows) {
      expect(row.priority).toBe("high");
      expect(row.source).toBe("展会");
      // 2026-10-27 10:00 +08:00 = 02:00Z
      expect(row.nextContactAt?.toISOString()).toBe("2026-10-27T02:00:00.000Z");
      expect(row.dataVersion).toBe(2);
      const event = await prisma.leadEvent.findFirst({
        where: { leadId: row.id, eventType: "updated" },
      });
      expect(event?.detail).toMatchObject({
        fields: ["priority", "source", "next_contact_at"],
        batch: true,
      });
      expect(event?.actorId).toBe(sales.id);
    }

    const audit = await prisma.auditLog.findFirst({
      where: { userId: sales.id, action: "lead.batch_updated" },
    });
    expect(audit?.detail).toMatchObject({ total: 2, updated: 2, skipped: 0 });
  });

  it("显式 null 清空批量字段（source 清空）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "批量清空客户", source: "老来源" });
    await batchUpdateLeads(
      sales,
      leadBatchUpdateSchema.parse({
        ids: [lead.id],
        changes: { source: "" },
      }),
    );
    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.source).toBeNull();
  });
});

describe("批量阶段流转", () => {
  it("批量流转写 stage_changed 快照事件；已处于目标阶段的线索跳过", async () => {
    const sales = await createTestUser("sales");
    const newLead = await getPresetStage("new_lead");
    const contacted = await getPresetStage("contacted");
    const mover = await createLead(sales, { name: "批量流转甲" });
    const stayer = await createLead(sales, { name: "批量流转乙" });
    // stayer 先挪到 contacted，再批量流转到 contacted → 应跳过
    await prisma.lead.update({
      where: { id: stayer.id },
      data: { stageId: contacted.id, dataVersion: { increment: 1 } },
    });

    const result = await batchUpdateLeads(
      sales,
      leadBatchUpdateSchema.parse({
        ids: [mover.id, stayer.id],
        changes: { stageId: contacted.id },
      }),
    );
    expect(result).toEqual({ total: 2, updated: 1, skipped: 1 });

    const movedRow = await prisma.lead.findUniqueOrThrow({
      where: { id: mover.id },
    });
    expect(movedRow.stageId).toBe(contacted.id);
    expect(movedRow.dataVersion).toBe(2);
    const event = await prisma.leadEvent.findFirst({
      where: { leadId: mover.id, eventType: "stage_changed" },
    });
    expect(event).not.toBeNull();
    expect(event?.stageSnapshot).toMatchObject({
      from: { id: newLead.id, name: newLead.name },
      to: { id: contacted.id, name: contacted.name },
    });

    // stayer：无事件、版本不变（跳过）
    const stayerRow = await prisma.lead.findUniqueOrThrow({
      where: { id: stayer.id },
    });
    expect(stayerRow.dataVersion).toBe(2); // 仅前面手动 update 的 +1
    const stayerEvents = await prisma.leadEvent.findMany({
      where: { leadId: stayer.id, eventType: "stage_changed" },
    });
    expect(stayerEvents).toHaveLength(0);
  });

  it("停用阶段不可作为批量流转目标（stage_inactive）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "停用阶段批量客户" });
    const stage = await createTestStage({
      code: `batch_inactive_${Date.now() % 100000}`,
      name: "批量停用阶段",
      isActive: false,
    });
    await expectApiError(
      () =>
        batchUpdateLeads(
          sales,
          leadBatchUpdateSchema.parse({
            ids: [lead.id],
            changes: { stageId: stage.id },
          }),
        ),
      400,
      "stage_inactive",
    );
  });
});

describe("批量整体拒绝语义（§8.2）", () => {
  it("混入他人线索：整体 404，任何一条都不被修改", async () => {
    const salesA = await createTestUser("sales");
    const salesB = await createTestUser("sales");
    const mine = await createLead(salesA, { name: "我的批量客户" });
    const others = await createLead(salesB, { name: "别人的批量客户" });

    await expectApiError(
      () =>
        batchUpdateLeads(
          salesA,
          leadBatchUpdateSchema.parse({
            ids: [mine.id, others.id],
            changes: { priority: "high" },
          }),
        ),
      404,
      "not_found",
    );

    const rows = await prisma.lead.findMany({
      where: { id: { in: [mine.id, others.id] } },
    });
    for (const row of rows) {
      expect(row.priority).toBe("mid"); // 全部未动
      expect(row.dataVersion).toBe(1);
    }
  });

  it("含不存在或已软删除的 id：整体 404", async () => {
    const sales = await createTestUser("sales");
    const alive = await createLead(sales, { name: "存活批量客户" });
    const dead = await createLead(sales, { name: "已删批量客户" });
    await prisma.lead.update({
      where: { id: dead.id },
      data: { deletedAt: new Date() },
    });

    await expectApiError(
      () =>
        batchUpdateLeads(
          sales,
          leadBatchUpdateSchema.parse({
            ids: [alive.id, dead.id],
            changes: { priority: "low" },
          }),
        ),
      404,
      "not_found",
    );

    const notExistId = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8fc";
    await expectApiError(
      () =>
        batchUpdateLeads(
          sales,
          leadBatchUpdateSchema.parse({
            ids: [alive.id, notExistId],
            changes: { priority: "low" },
          }),
        ),
      404,
      "not_found",
    );
  });

  it("source 内置字段被停用：批量提交 source 被拒绝（field_disabled），恢复后可用", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "停用字段批量客户" });
    const def = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "source" },
    });
    try {
      await prisma.leadFieldDef.update({
        where: { id: def.id },
        data: { isActive: false },
      });
      await expectApiError(
        () =>
          batchUpdateLeads(
            sales,
            leadBatchUpdateSchema.parse({
              ids: [lead.id],
              changes: { source: "展会" },
            }),
          ),
        400,
        "field_disabled",
      );
    } finally {
      await prisma.leadFieldDef.update({
        where: { id: def.id },
        data: { isActive: true },
      });
    }

    // 恢复后同一提交成功
    const result = await batchUpdateLeads(
      sales,
      leadBatchUpdateSchema.parse({
        ids: [lead.id],
        changes: { source: "展会" },
      }),
    );
    expect(result.updated).toBe(1);
  });
});

describe("管理员批量修改（C10 全量可写）", () => {
  it("管理员可批量修改他人线索", async () => {
    const sales = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const a = await createLead(sales, { name: "管理员批量甲" });
    const b = await createLead(sales, { name: "管理员批量乙" });

    const result = await batchUpdateLeads(
      admin,
      leadBatchUpdateSchema.parse({
        ids: [a.id, b.id],
        changes: { priority: "low" },
      }),
    );
    expect(result.updated).toBe(2);
    const rows = await prisma.lead.findMany({ where: { id: { in: [a.id, b.id] } } });
    for (const row of rows) {
      expect(row.priority).toBe("low");
    }
  });
});
