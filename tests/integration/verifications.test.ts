import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser, getPresetStage } from "./helpers";
import {
  createLead,
  getLeadDetail,
  insertLeadWithEvent,
  updateLead,
} from "@/server/services/leads";
import { applyInteractionWrite } from "@/server/services/interaction-write";
import { interactionCreateSchema } from "@/lib/schemas/interaction";
import { getFieldVerifications } from "@/server/services/lead-verifications";
import { ApiError } from "@/server/http/api";

// V2.0-T01 验收项（数据侧）：
// ③ 编辑改值 → 状态自动 unverified + 核实人/时间更新；
// ④ updated 事件 detail 含 from/to/statusFrom/statusTo，联系方式不落明文；
// - 显式状态（verifications map / 旧状态键别名）优先并镜像旧列；
// - 沟通「本次确认」source=interaction 且旧列同步；
// - 导入通道 source=import（全部有值字段 unverified）；
// - 白名单外核实输入 400；越权写入 404（权限走既有 leads 通道）。

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

describe("新建与核实元数据落库", () => {
  it("新建带值：核实行 unverified + 五元组齐全；旧列镜像一致", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "核实元数据客户",
      currentSystem: "舟谱",
      industry: "快消-酒水",
    });

    const rows = await getFieldVerifications(lead.id);
    const currentSystem = rows.find((row) => row.fieldKey === "current_system");
    expect(currentSystem).toMatchObject({
      status: "unverified",
      source: "manual",
      verifiedBy: sales.id,
    });
    expect(currentSystem?.verifiedAt).toBeInstanceOf(Date);
    expect(currentSystem?.note).toBeNull();

    const industry = rows.find((row) => row.fieldKey === "industry");
    expect(industry?.status).toBe("unverified");

    // 旧状态列镜像（verification 优先口径）
    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.currentSystemStatus).toBe("unverified");

    // 唯一约束：lead + field_key 一行
    expect(rows.filter((row) => row.fieldKey === "current_system")).toHaveLength(1);
  });

  it("显式 stated（客户自述待复核）：核实行与旧列同置 stated", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "自述待复核客户",
      qinceInterest: true,
      verifications: { qince_interest: "stated" },
    });
    const rows = await getFieldVerifications(lead.id);
    expect(rows.find((row) => row.fieldKey === "qince_interest")).toMatchObject({
      status: "stated",
      source: "manual",
      verifiedBy: sales.id,
    });
    expect(lead.qinceInterest).toBe(true);
  });

  it("旧状态键别名兼容：currentSystemStatus=confirmed 同步核实行", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "别名通道客户",
      currentSystem: "管家婆",
      currentSystemStatus: "confirmed",
    });
    const rows = await getFieldVerifications(lead.id);
    expect(rows.find((row) => row.fieldKey === "current_system")).toMatchObject({
      status: "confirmed",
      source: "manual",
    });
    expect(lead.currentSystemStatus).toBe("confirmed");
  });

  it("白名单外核实输入 400（不静默忽略）", async () => {
    const sales = await createTestUser("sales");
    await expectApiError(
      () =>
        createLead(sales, {
          name: "白名单外客户",
          verifications: { contact_phone: "confirmed" },
        }),
      400,
      "verification_field_invalid",
    );
  });
});

describe("编辑改值自动置待核实（验收③）", () => {
  it("confirmed 字段改值 → unverified + 核实人/时间更新 + 旧列镜像 + 事件留痕", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "改值待核实客户",
      currentSystem: "管家婆",
      currentSystemStatus: "confirmed",
    });
    const before = (await getFieldVerifications(lead.id)).find(
      (row) => row.fieldKey === "current_system",
    );
    expect(before?.status).toBe("confirmed");
    expect(before?.verifiedAt).toBeInstanceOf(Date);

    const updated = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      currentSystem: "舟谱",
    });
    expect(updated.currentSystemStatus).toBe("unverified");

    const after = (await getFieldVerifications(lead.id)).find(
      (row) => row.fieldKey === "current_system",
    );
    expect(after?.status).toBe("unverified");
    expect(after?.source).toBe("manual");
    expect(after?.verifiedBy).toBe(sales.id);
    expect(after?.verifiedAt?.getTime()).toBeGreaterThanOrEqual(
      before?.verifiedAt?.getTime() ?? 0,
    );

    // updated 事件：changed 含 from/to/statusFrom/statusTo（验收④）
    const detail = await getLeadDetail(sales, lead.id);
    const updatedEvent = detail.events.find((event) => event.eventType === "updated");
    expect(updatedEvent).toBeTruthy();
    const changed = (updatedEvent?.detail as { changed?: Record<string, unknown> })
      .changed;
    expect(changed?.current_system).toEqual({
      from: "管家婆",
      to: "舟谱",
      statusFrom: "confirmed",
      statusTo: "unverified",
    });
  });

  it("清空值 → unknown（核实行与旧列同步）；无变化保存不产生事件", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "清空值客户",
      industry: "快消",
    });
    const cleared = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      industry: null,
    });
    expect(cleared.industry).toBeNull();
    const row = (await getFieldVerifications(lead.id)).find(
      (item) => item.fieldKey === "industry",
    );
    expect(row?.status).toBe("unknown");

    // 无变化保存：无 updated 事件（fields 事件不因重复提交产生）
    const eventsBefore = await prisma.leadEvent.count({
      where: { leadId: lead.id, eventType: "updated" },
    });
    await updateLead(sales, lead.id, {
      dataVersion: cleared.dataVersion,
      industry: null,
    });
    const eventsAfter = await prisma.leadEvent.count({
      where: { leadId: lead.id, eventType: "updated" },
    });
    expect(eventsAfter).toBe(eventsBefore);
  });

  it("联系方式变更：事件只记「已变更」不落明文（验收④脱敏）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "电话脱敏客户",
      contactPhone: "13800001111",
    });
    await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      contactPhone: "13911112222",
    });
    const detail = await getLeadDetail(sales, lead.id);
    const updatedEvent = detail.events.find((event) => event.eventType === "updated");
    const serialized = JSON.stringify(updatedEvent?.detail ?? {});
    expect(serialized).toContain("已变更");
    expect(serialized).not.toContain("13911112222");
    expect(serialized).not.toContain("13800001111");
  });

  it("getLeadDetail 返回 verifications 五元组", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "详情核实行客户" });
    const detail = await getLeadDetail(sales, lead.id);
    expect(Array.isArray(detail.verifications)).toBe(true);
    expect(detail.verifications.every((row) => row.leadId === lead.id)).toBe(true);
  });

  it("越权编辑他人线索 404（核实写入经权限层）", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, { name: "B 的核实客户", industry: "快消" });
    await expectApiError(
      () =>
        updateLead(a, leadB.id, {
          dataVersion: leadB.dataVersion,
          industry: "越权",
          verifications: { industry: "confirmed" },
        }),
      404,
    );
  });
});

describe("沟通「本次确认」与导入通道", () => {
  it("沟通确认：source=interaction + 置 confirmed + 旧列镜像", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "沟通确认客户",
      currentSystem: "舟谱",
    });
    const withStage = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      include: { stage: true },
    });
    const input = interactionCreateSchema.parse({
      occurredAt: "2026-10-31 10:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      currentSystemConfirmed: "舟谱",
      confirmCurrentSystem: true,
    });
    await prisma.$transaction((tx) =>
      applyInteractionWrite(tx, withStage, sales.id, input),
    );

    const row = (await getFieldVerifications(lead.id)).find(
      (item) => item.fieldKey === "current_system",
    );
    expect(row).toMatchObject({
      status: "confirmed",
      source: "interaction",
      verifiedBy: sales.id,
    });
    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(fresh.currentSystemStatus).toBe("confirmed");
  });

  it("导入确认：source=import，全部有值字段 unverified", async () => {
    const sales = await createTestUser("sales");
    const stage = await getPresetStage("new_lead");
    await prisma.$transaction((tx) =>
      insertLeadWithEvent(
        tx,
        sales,
        {
          name: "导入核实客户",
          currentSystem: "爱快消",
          contractExpiry: "2027-06-30",
          industry: "快消",
        },
        undefined,
        { stageId: stage.id, eventType: "imported", verificationSource: "import" },
      ),
    );
    const imported = await prisma.lead.findFirstOrThrow({
      where: { name: "导入核实客户", ownerId: sales.id },
    });
    const rows = await getFieldVerifications(imported.id);
    expect(rows.find((row) => row.fieldKey === "current_system")).toMatchObject({
      status: "unverified",
      source: "import",
    });
    expect(rows.find((row) => row.fieldKey === "industry")).toMatchObject({
      status: "unverified",
      source: "import",
    });
    expect(imported.currentSystemStatus).toBe("unverified");
  });
});
