import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/server/http/api";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser, getPresetStage } from "./helpers";
import { leadCreateSchema } from "@/lib/schemas/lead";
import {
  createLead,
  getLeadDetail,
  listLeads,
  softDeleteLead,
  transitionStage,
  updateLead,
} from "@/server/services/leads";

// T03 验收项（数据侧）：
// - 空值可保存（除客户名称外全字段可空）；
// - 新建/编辑/详情/软删除闭环，lead_events 全程留痕；
// - dataVersion 乐观并发控制（冲突 409）；
// - 阶段流转写前后状态与快照；同阶段流转幂等；
// - 越权：销售 A/B 数据互不可见（404），管理员全量。

afterAll(cleanupTestUsers);

async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      if (code) {
        expect(error.code).toBe(code);
      }
      return error;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("新建与空值可保存", () => {
  it("仅客户名称即可创建：空值落库为 null，版本为 1，事件含阶段快照", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "武汉测试商贸一号" });

    expect(lead.ownerId).toBe(sales.id);
    expect(lead.dataVersion).toBe(1);
    expect(lead.deletedAt).toBeNull();
    expect(lead.city).toBeNull();
    expect(lead.contactPhone).toBeNull();
    expect(lead.contractExpiry).toBeNull();
    expect(lead.customValues).toBeNull();

    // 默认阶段 = new_lead 语义锚点
    const newLeadStage = await getPresetStage("new_lead");
    expect(lead.stageId).toBe(newLeadStage.id);
    expect(lead.stage.semanticKey).toBe("new_lead");

    const detail = await getLeadDetail(sales, lead.id);
    expect(detail.events.map((event) => event.eventType)).toEqual(["created"]);
    const created = detail.events[0]!;
    expect(created.toStageId).toBe(newLeadStage.id);
    expect(created.stageSnapshot).toEqual({
      to: {
        id: newLeadStage.id,
        code: newLeadStage.code,
        name: newLeadStage.name,
        semanticKey: "new_lead",
      },
    });
    expect(created.actorId).toBe(sales.id);
  });

  it("全字段合法提交：核实状态、优先级、本地日期按 +08:00 解释", async () => {
    const sales = await createTestUser("sales");
    // 表单原始值（字符串数字/布尔/日期）先经共享 Schema 归一化，再进服务（与路由一致）
    const input = leadCreateSchema.parse({
      name: "合肥测试商贸二号",
      city: "合肥",
      contactPhone: "0551-65123456",
      salesTeamSize: "15",
      contractExpiry: "2027-03-31",
      currentSystemStatus: "confirmed",
      priority: "high",
      nextContactAt: "2026-10-26 09:30",
      consideringSwitch: "true",
    });
    const lead = await createLead(sales, input);
    expect(lead.salesTeamSize).toBe(15);
    expect(lead.consideringSwitch).toBe(true);
    expect(lead.currentSystemStatus).toBe("confirmed");
    expect(lead.priority).toBe("high");
    expect(lead.contractExpiry?.toISOString()).toBe("2027-03-31T00:00:00.000Z");
    // 2026-10-26 09:30 +08:00 = 01:30Z
    expect(lead.nextContactAt?.toISOString()).toBe("2026-10-26T01:30:00.000Z");
  });
});

describe("编辑与乐观并发（data_version）", () => {
  it("局部更新只改提交字段；版本 +1；写 updated 事件（只记字段名）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "编辑验证客户",
      city: "武汉",
      remark: "初始备注",
    });

    const updated = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      city: "南昌",
      contactName: "王经理",
    });
    expect(updated.city).toBe("南昌");
    expect(updated.contactName).toBe("王经理");
    expect(updated.remark).toBe("初始备注"); // 未提交字段不动
    expect(updated.dataVersion).toBe(2);

    const detail = await getLeadDetail(sales, lead.id);
    const updatedEvent = detail.events.find((event) => event.eventType === "updated");
    expect(updatedEvent?.detail).toEqual({
      fields: expect.arrayContaining(["city", "contact_name"]),
    });
  });

  it("显式 null 清空字段", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "清空验证客户", city: "武汉" });
    const updated = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      city: null,
    });
    expect(updated.city).toBeNull();
    expect(updated.dataVersion).toBe(2);
  });

  it("过期版本 409；删除后操作 404", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "并发验证客户" });

    // 模拟他人先改（版本推进）
    const first = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      city: "第一改",
    });
    // 用旧版本再改 → 409
    await expectApiError(
      () =>
        updateLead(sales, lead.id, {
          dataVersion: lead.dataVersion,
          city: "第二改",
        }),
      409,
      "version_conflict",
    );
    // 用当前版本可继续
    const second = await updateLead(sales, lead.id, {
      dataVersion: first.dataVersion,
      city: "第二改",
    });
    expect(second.city).toBe("第二改");
    expect(second.dataVersion).toBe(3);

    // 软删除后：编辑/详情均 404
    await softDeleteLead(sales, lead.id);
    await expectApiError(
      () => updateLead(sales, lead.id, { dataVersion: second.dataVersion, city: "x" }),
      404,
    );
    await expectApiError(() => getLeadDetail(sales, lead.id), 404);
  });
});

describe("阶段流转", () => {
  it("流转写 from/to 快照与操作人；同阶段幂等不写事件", async () => {
    const sales = await createTestUser("sales");
    const qualified = await getPresetStage("qualified");
    const lead = await createLead(sales, { name: "流转验证客户" });

    const result = await transitionStage(sales, lead.id, {
      stageId: qualified.id,
      dataVersion: lead.dataVersion,
    });
    expect(result.changed).toBe(true);
    expect(result.lead.stageId).toBe(qualified.id);
    expect(result.lead.dataVersion).toBe(2);

    // 幂等：同阶段再流转 changed=false，版本不动
    const again = await transitionStage(sales, lead.id, {
      stageId: qualified.id,
      dataVersion: 2,
    });
    expect(again.changed).toBe(false);
    expect(again.lead.dataVersion).toBe(2);

    const detail = await getLeadDetail(sales, lead.id);
    const changedEvents = detail.events.filter(
      (event) => event.eventType === "stage_changed",
    );
    expect(changedEvents).toHaveLength(1);
    const event = changedEvents[0]!;
    expect(event.actorId).toBe(sales.id);
    expect(event.fromStageId).toBe(lead.stageId);
    expect(event.toStageId).toBe(qualified.id);
    expect(event.stageSnapshot).toMatchObject({
      from: { semanticKey: "new_lead" },
      to: { semanticKey: "qualified", code: qualified.code, name: qualified.name },
    });
  });

  it("流转到不存在阶段 404；过期版本 409", async () => {
    const sales = await createTestUser("sales");
    const qualified = await getPresetStage("qualified");
    const lead = await createLead(sales, { name: "流转异常验证客户" });

    await expectApiError(
      () =>
        transitionStage(sales, lead.id, {
          stageId: "0b7e3f7a-0000-4000-8000-000000000000",
          dataVersion: lead.dataVersion,
        }),
      404,
    );
    await expectApiError(
      () =>
        transitionStage(sales, lead.id, {
          stageId: qualified.id,
          dataVersion: lead.dataVersion - 1,
        }),
      409,
      "version_conflict",
    );
  });
});

describe("软删除（M1/C11）", () => {
  it("删除后列表与详情不可见，事件保留，审计留痕", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, { name: "软删除验证客户", city: "九江" });
    const eventsBefore = await prisma.leadEvent.count({
      where: { leadId: lead.id },
    });
    expect(eventsBefore).toBe(1); // created

    await softDeleteLead(sales, lead.id);

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.dataVersion).toBe(2);

    await expectApiError(() => getLeadDetail(sales, lead.id), 404);
    const listed = await listLeads(sales, { page: 1, pageSize: 100 });
    expect(listed.items.some((item) => item.id === lead.id)).toBe(false);

    // 事件保留（created + deleted）
    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(events.map((event) => event.eventType)).toEqual(["created", "deleted"]);

    // 审计留痕
    const audit = await prisma.auditLog.findFirst({
      where: { action: "lead.deleted", objectId: lead.id },
    });
    expect(audit?.userId).toBe(sales.id);
  });
});

describe("越权与数据范围（§8.2 固定用例）", () => {
  it("销售 A 对 B 的线索：读/写/删/流转一律 404", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const qualified = await getPresetStage("qualified");
    const leadB = await createLead(b, { name: "B 的私有客户" });

    await expectApiError(() => getLeadDetail(a, leadB.id), 404);
    await expectApiError(
      () => updateLead(a, leadB.id, { dataVersion: leadB.dataVersion, city: "越权" }),
      404,
    );
    await expectApiError(
      () =>
        transitionStage(a, leadB.id, {
          stageId: qualified.id,
          dataVersion: leadB.dataVersion,
        }),
      404,
    );
    await expectApiError(() => softDeleteLead(a, leadB.id), 404);

    // B 本人正常
    const detail = await getLeadDetail(b, leadB.id);
    expect(detail.lead.name).toBe("B 的私有客户");
  });

  it("列表范围：销售仅本人；管理员全量且可按负责人筛选", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const admin = await createTestUser("admin");
    await createLead(a, { name: "A-范围验证客户甲" });
    await createLead(b, { name: "B-范围验证客户乙" });

    const forA = await listLeads(a, { page: 1, pageSize: 100 });
    expect(forA.items.length).toBeGreaterThan(0);
    expect(forA.items.every((item) => item.ownerId === a.id)).toBe(true);
    expect(forA.items.some((item) => item.name === "B-范围验证客户乙")).toBe(false);

    const forAdmin = await listLeads(admin, { page: 1, pageSize: 100 });
    const adminNames = forAdmin.items.map((item) => item.name);
    expect(adminNames).toContain("A-范围验证客户甲");
    expect(adminNames).toContain("B-范围验证客户乙");

    const filtered = await listLeads(admin, {
      page: 1,
      pageSize: 100,
      ownerId: b.id,
    });
    expect(filtered.items.every((item) => item.ownerId === b.id)).toBe(true);
    expect(filtered.items.some((item) => item.name === "B-范围验证客户乙")).toBe(true);
  });

  it("管理员可读他人的线索详情（C10 全量查看）", async () => {
    const sales = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const lead = await createLead(sales, { name: "管理员查看客户" });
    const detail = await getLeadDetail(admin, lead.id);
    expect(detail.lead.name).toBe("管理员查看客户");
  });

  it("关键词搜索命中名称/电话，筛选条件生效", async () => {
    const sales = await createTestUser("sales");
    const suffix = `${Date.now() % 1000000}`;
    await createLead(sales, {
      name: `关键词客户${suffix}甲`,
      contactName: "刘联系人",
      contactPhone: "13900001111",
      city: "武汉",
      industry: "快消",
    });
    await createLead(sales, { name: `另一客户${suffix}乙`, city: "南昌", industry: "快消" });

    const byName = await listLeads(sales, {
      page: 1,
      pageSize: 100,
      keyword: `关键词客户${suffix}`,
    });
    expect(byName.items).toHaveLength(1);

    const byPhone = await listLeads(sales, {
      page: 1,
      pageSize: 100,
      keyword: "13900001111",
    });
    expect(byPhone.items).toHaveLength(1);

    const byCity = await listLeads(sales, { page: 1, pageSize: 100, city: "南昌" });
    expect(byCity.items.length).toBeGreaterThan(0);
    expect(byCity.items.every((item) => item.city === "南昌")).toBe(true);
    expect(byCity.items.some((item) => item.name === `另一客户${suffix}乙`)).toBe(true);

    const byCityIndustry = await listLeads(sales, {
      page: 1,
      pageSize: 100,
      city: "武汉",
      industry: "快消",
    });
    expect(
      byCityIndustry.items.some((item) => item.name === `关键词客户${suffix}甲`),
    ).toBe(true);
  });

  it("分页：total/page/pageSize 正确", async () => {
    const sales = await createTestUser("sales");
    const prefix = `分页客户${Date.now() % 100000}`;
    for (let i = 0; i < 5; i += 1) {
      await createLead(sales, { name: `${prefix}-${i}` });
    }
    const page1 = await listLeads(sales, { page: 1, pageSize: 2, keyword: prefix });
    const page2 = await listLeads(sales, { page: 2, pageSize: 2, keyword: prefix });
    const page3 = await listLeads(sales, { page: 3, pageSize: 2, keyword: prefix });
    expect(page1.total).toBe(5);
    expect(page1.items).toHaveLength(2);
    expect(page2.items).toHaveLength(2);
    expect(page3.items).toHaveLength(1);
    const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(5);
  });
});
