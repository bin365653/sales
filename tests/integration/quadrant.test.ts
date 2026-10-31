import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser } from "./helpers";
import { createLead, updateLead } from "@/server/services/leads";
import { computeProfileStatus } from "@/server/services/profile";
import { ApiError } from "@/server/http/api";

// 《迭代开发V2.1》验收 7 项逐条自动化（V2.0-T04）：
// 1. 两个维度都确认时正确进入四象限；
// 2. 任一维度未知时不进入四象限（画像待完善）；
// 3. 客户修改系统类型后分类正确变化（quadrant_changed 留痕）；
// 4. 客户意愿变化后分类正确变化；
// 5. 字段修改历史保留；
// 6. 原有客户、沟通记录和任务不丢失；
// 7. 不同账号的数据权限仍然有效。
// 另：stated 口径（P3）单测已在 tests/unit/expiry-quadrant.test.ts 固化，
// 本文件补 stated 轴的集成链路；完善度三态（P5）单测+集成固化。

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

const CONFIRMED_ALL = {
  current_system: "confirmed",
  next_gen_mobile_order: "confirmed",
  qince_interest: "confirmed",
  contract_expiry: "confirmed",
  industry: "confirmed",
  main_category: "confirmed",
  sales_team_scale: "confirmed",
} as const;

describe("验收 1/2：象限进入与待完善", () => {
  it("双确认（在用新一代+有意愿）→ A·第一象限 + quadrant_changed 事件 + 完善度", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "象限A客户",
      nextGenMobileOrder: true,
      qinceInterest: true,
      verifications: {
        next_gen_mobile_order: "confirmed",
        qince_interest: "confirmed",
      },
    });
    expect(lead.quadrantCode).toBe("a");
    expect(lead.quadrantComputedAt).toBeInstanceOf(Date);
    expect(lead.profileStatus).toBe("incomplete"); // 核心 2/7

    const event = await prisma.leadEvent.findFirstOrThrow({
      where: { leadId: lead.id, eventType: "quadrant_changed" },
    });
    const detail = event.detail as {
      from: string | null;
      to: string;
      basis: { x: { value: boolean; status: string }; y: { value: boolean; status: string } };
    };
    expect(detail.from).toBeNull();
    expect(detail.to).toBe("a");
    expect(detail.basis.x).toMatchObject({ value: true, status: "confirmed" });
    expect(detail.basis.y).toMatchObject({ value: true, status: "confirmed" });
  });

  it("任一维度未确认 → 不进象限（quadrant=null，未知不当否）", async () => {
    const sales = await createTestUser("sales");
    // x 确认 true，y 值存在但未核实（unverified 不算确认）
    const lead = await createLead(sales, {
      name: "象限待完善客户",
      nextGenMobileOrder: true,
      qinceInterest: true,
      verifications: { next_gen_mobile_order: "confirmed" },
    });
    expect(lead.quadrantCode).toBeNull();
    // y 无核实动作 → 无核实行 → unconfirmed
    expect(lead.profileStatus).toBe("incomplete");

    // 双 unknown（纯创建无值）
    const empty = await createLead(sales, { name: "象限全未知客户" });
    expect(empty.quadrantCode).toBeNull();
    expect(empty.profileStatus).toBe("incomplete");
  });

  it("stated（客户自述待复核）按已确认进入象限（P3 集成链路）", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "象限自述客户",
      nextGenMobileOrder: false,
      qinceInterest: true,
      verifications: {
        next_gen_mobile_order: "stated",
        qince_interest: "stated",
      },
    });
    expect(lead.quadrantCode).toBe("c");
  });
});

describe("验收 3/4/5：分类正确变化与历史保留", () => {
  it("修改系统类型（新一代）→ A→C；修改意愿 → C→D；全程事件留痕", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "分类变化客户",
      nextGenMobileOrder: true,
      qinceInterest: true,
      verifications: { next_gen_mobile_order: "confirmed", qince_interest: "confirmed" },
    });
    expect(lead.quadrantCode).toBe("a");

    // 3. 客户改用非新一代系统（值变化 → 状态自动 unverified → 退出象限），
    //    重新自述确认 → C·第三象限
    const step1 = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      nextGenMobileOrder: false,
    });
    expect(step1.quadrantCode).toBeNull(); // 值变化自动置待核实 → 不再双确认

    const step2 = await updateLead(sales, lead.id, {
      dataVersion: step1.dataVersion,
      verifications: { next_gen_mobile_order: "confirmed" },
    });
    expect(step2.quadrantCode).toBe("c");

    // 4. 意愿变化：有意愿 → 无意愿 → C→D
    const step3 = await updateLead(sales, step2.id, {
      dataVersion: step2.dataVersion,
      qinceInterest: false,
      verifications: { qince_interest: "confirmed" },
    });
    expect(step3.quadrantCode).toBe("d");

    // quadrant_changed 事件链：null→a→null→c→d（历史只追加；JSONB null 反序列化为 null）
    const events = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, eventType: "quadrant_changed" },
      orderBy: { occurredAt: "asc" },
    });
    expect(
      events.map((event) => (event.detail as { to: string | null }).to),
    ).toEqual(["a", null, "c", "d"]);
    // 第一个事件的 from 为 null（初始分类）
    expect((events[0]!.detail as { from: string | null }).from).toBeNull();

    // 5. 字段修改历史保留：updated 事件含 changed 明细（值+状态变化）
    const updates = await prisma.leadEvent.findMany({
      where: { leadId: lead.id, eventType: "updated" },
      orderBy: { occurredAt: "asc" },
    });
    const firstChanged = updates[0]!.detail as {
      changed: Record<string, { from: unknown; to: unknown; statusTo: string }>;
    };
    expect(firstChanged.changed.next_gen_mobile_order).toMatchObject({
      from: true,
      to: false,
      statusTo: "unverified",
    });
  });
});

describe("验收 6：原有客户、沟通记录和任务不丢失", () => {
  it("画像编辑前后：沟通记录与任务数量与内容不变，象限随编辑更新", async () => {
    const sales = await createTestUser("sales");
    const lead = await createLead(sales, {
      name: "回归完整客户",
      nextGenMobileOrder: true,
      qinceInterest: true,
      verifications: { next_gen_mobile_order: "confirmed", qince_interest: "confirmed" },
    });
    const interaction = await prisma.interaction.create({
      data: {
        leadId: lead.id,
        userId: sales.id,
        occurredAt: new Date("2026-10-30T02:00:00.000Z"),
        channel: "phone",
        direction: "outbound",
        connected: true,
        effective: true,
        feedback: "原始沟通内容保持不变",
      },
    });
    const task = await prisma.task.create({
      data: {
        leadId: lead.id,
        assigneeId: sales.id,
        createdBy: sales.id,
        type: "follow_up",
        title: "原始任务保持不变",
        dueAt: new Date("2026-11-05T02:00:00.000Z"),
      },
    });

    await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      industry: "快消-酒水",
      verifications: { industry: "confirmed" },
    });

    const freshInteraction = await prisma.interaction.findUniqueOrThrow({
      where: { id: interaction.id },
    });
    expect(freshInteraction.feedback).toBe("原始沟通内容保持不变");
    expect(freshInteraction.effective).toBe(true);
    const freshTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(freshTask.title).toBe("原始任务保持不变");
    expect(freshTask.status).toBe("pending");
    // 客户本体与历史事件都在
    const events = await prisma.leadEvent.count({ where: { leadId: lead.id } });
    expect(events).toBeGreaterThanOrEqual(3); // created + quadrant_changed + updated
  });
});

describe("验收 7：跨账号数据权限", () => {
  it("销售 A 不能改 B 的客户（404），B 的象限不被越权修改", async () => {
    const a = await createTestUser("sales");
    const b = await createTestUser("sales");
    const leadB = await createLead(b, {
      name: "B 的象限客户",
      nextGenMobileOrder: true,
      qinceInterest: true,
      verifications: { next_gen_mobile_order: "confirmed", qince_interest: "confirmed" },
    });
    expect(leadB.quadrantCode).toBe("a");

    await expectApiError(
      () =>
        updateLead(a, leadB.id, {
          dataVersion: leadB.dataVersion,
          qinceInterest: false,
          verifications: { qince_interest: "confirmed" },
        }),
      404,
    );

    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: leadB.id } });
    expect(fresh.quadrantCode).toBe("a"); // 未被越权改动
    const changed = await prisma.leadEvent.count({
      where: { leadId: leadB.id, eventType: "quadrant_changed" },
    });
    expect(changed).toBe(1); // 仅创建时一次
  });
});

describe("画像完善度三态（P5）", () => {
  it("核心未全核实=incomplete；核心 7/7+辅助<60%=basic；≥60%=deep", async () => {
    const sales = await createTestUser("sales");
    // basic：核心 7 全确认、辅助 0
    const basic = await createLead(sales, {
      name: "完善度basic客户",
      currentSystem: "舟谱",
      nextGenMobileOrder: true,
      qinceInterest: true,
      contractExpiry: "2027-06",
      industry: "快消",
      mainCategory: "酒水",
      salesTeamScale: "20-49人",
      verifications: { ...CONFIRMED_ALL },
    });
    expect(basic.profileStatus).toBe("basic");
    expect(basic.quadrantCode).toBe("a");

    // deep：核心 7 + 辅助 12/19（63% ≥ 60%）
    const deep = await updateLead(sales, basic.id, {
      dataVersion: basic.dataVersion,
      revenueRange: "1000-3000万",
      salesTeamSize: 30,
      salesMode: "访销",
      knownPains: "开单效率低",
      purchaseTime: "2026年Q4",
      decisionMaker: "王总",
      softwareVersion: "舟谱云版",
      customerCount: 120,
      businessMgmtMode: "业务员打卡",
      orderMgmtMode: "手机开单",
      deliveryMgmtMode: "自有配送",
      financeMgmtMode: "系统对账",
      verifications: {
        revenue_range: "confirmed",
        sales_team_size: "confirmed",
        sales_mode: "confirmed",
        known_pains: "confirmed",
        purchase_time: "confirmed",
        decision_maker: "confirmed",
        software_version: "confirmed",
        customer_count: "confirmed",
        business_mgmt_mode: "confirmed",
        order_mgmt_mode: "confirmed",
        delivery_mgmt_mode: "confirmed",
        finance_mgmt_mode: "confirmed",
      },
    });
    expect(deep.profileStatus).toBe("deep");
    expect(deep.lastProfileVerifiedAt).toBeInstanceOf(Date);

    // computeProfileStatus 纯函数边界：19 项辅助确认 11 项 = 57.9% < 60% → basic
    const rows = Object.entries({
      ...CONFIRMED_ALL,
      revenue_range: "confirmed",
      sales_team_size: "confirmed",
      sales_mode: "confirmed",
      known_pains: "confirmed",
      purchase_time: "confirmed",
      decision_maker: "confirmed",
      software_version: "confirmed",
      customer_count: "confirmed",
      business_mgmt_mode: "confirmed",
      delivery_mgmt_mode: "confirmed",
      finance_mgmt_mode: "confirmed",
    }).map(([fieldKey, status]) => ({ fieldKey, status }));
    expect(rows.filter((row) => !["current_system", "next_gen_mobile_order", "qince_interest", "contract_expiry", "industry", "main_category", "sales_team_scale"].includes(row.fieldKey))).toHaveLength(11);
    expect(computeProfileStatus(rows).profileStatus).toBe("basic");
  });
});
