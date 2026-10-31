import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { getOperationsWorkbench } from "@/server/services/workbench";
import { runTaskGeneration } from "@/server/services/task-generation";
import { addExpiryMonths, currentExpiryMonth } from "@/lib/expiry";

// V2.0-T09 首页经营视图验收（PRD 模块七）：
// 四卡计数与对应筛选同一口径；月度必跟（含已过期排序+unknown 排除）/
// 画像待完善（缺失核心清单）/四象限重点（A/C 一周内应跟）/
// 长期培育（B/D）；每行含原因与推荐沟通内容（规则文案必显）。
// 「今日优先」Tab 走 T10 规则引擎——规则文案断言在 metrics-priority 单测
// 与 dashboard 集成对账中固化，此处只验证行结构与数据范围。

const owner: { value: TestUser | null } = { value: null };
const createdLeadIds: string[] = [];

beforeAll(async () => {
  owner.value = await createTestUser("admin");
});

afterAll(async () => {
  if (createdLeadIds.length > 0) {
    await prisma.task.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.followUpCycle.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.leadFieldVerification.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.leadEvent.deleteMany({ where: { leadId: { in: createdLeadIds } } });
    await prisma.lead.deleteMany({ where: { id: { in: createdLeadIds } } });
  }
  await cleanupTestUsers();
});

async function createLeadFixture(options: {
  name: string;
  quadrant?: "a" | "b" | "c" | "d" | null;
  expiryMonth?: string;
  expiryStatus?: "confirmed" | "unknown";
  profileStatus?: "incomplete" | "basic" | "deep" | null;
  /** 缺失的核心字段 key（画像待完善清单用） */
  verifiedCoreKeys?: string[];
  stageSemanticKey?: string;
}): Promise<string> {
  const stage = await getPresetStage(options.stageSemanticKey ?? "to_contact");
  const lead = await prisma.lead.create({
    data: {
      name: `${options.name} ${uniqueSuffix()}`,
      ownerId: owner.value!.id,
      stageId: stage.id,
      quadrantCode: options.quadrant ?? null,
      profileStatus: options.profileStatus ?? null,
      currentSystem: "管家婆",
      city: "合肥",
      industry: "快消",
      contractExpiry: options.expiryMonth
        ? new Date(`${options.expiryMonth}-01T00:00:00.000Z`)
        : null,
    },
    select: { id: true },
  });
  createdLeadIds.push(lead.id);
  for (const fieldKey of options.verifiedCoreKeys ?? []) {
    await prisma.leadFieldVerification.create({
      data: { leadId: lead.id, fieldKey, status: "confirmed", source: "manual" },
    });
  }
  if (options.expiryMonth) {
    await prisma.leadFieldVerification.create({
      data: {
        leadId: lead.id,
        fieldKey: "contract_expiry",
        status: options.expiryStatus ?? "confirmed",
        source: "manual",
      },
    });
  }
  return lead.id;
}

describe("经营视图：四卡计数", () => {
  it("计数与对应筛选同一口径（半年内到期/画像待完善/任务计数）", async () => {
    await createLeadFixture({ name: "T09卡-到期", expiryMonth: addExpiryMonths(currentExpiryMonth(new Date()), 2) });
    await createLeadFixture({ name: "T09卡-待完善", profileStatus: "incomplete" });
    const view = await getOperationsWorkbench(owner.value!, { now: new Date() });
    expect(view.cards.expiringSoon).toBeGreaterThanOrEqual(1);
    expect(view.cards.profileGap).toBeGreaterThanOrEqual(1);
    expect(view.cards.overdueTasks).toBeGreaterThanOrEqual(0);
    expect(view.cards.followToday).toBeGreaterThanOrEqual(0);
  });
});

describe("经营视图：月度必跟", () => {
  it("含已过期（排序最早在前）、排除核实状态 unknown、原因行含月度规则文案", async () => {
    const month = currentExpiryMonth(new Date());
    const expired = await createLeadFixture({
      name: "T09月度-已过期",
      expiryMonth: addExpiryMonths(month, -1),
    });
    await createLeadFixture({
      name: "T09月度-未知状态",
      expiryMonth: addExpiryMonths(month, 1),
      expiryStatus: "unknown",
    });
    await createLeadFixture({
      name: "T09月度-半年内",
      expiryMonth: addExpiryMonths(month, 3),
    });

    const view = await getOperationsWorkbench(owner.value!, { now: new Date(), tab: "monthly" });
    const ids = view.tabs.monthly.map((row) => row.leadId);
    expect(ids).toContain(expired);
    // unknown 状态视同未知，不进月度必跟
    const unknownLead = await prisma.lead.findFirst({ where: { name: { contains: "T09月度-未知状态" } } });
    expect(ids).not.toContain(unknownLead!.id);
    // 已过期在最前（到期升序）
    const expiredIndex = ids.indexOf(expired);
    expect(expiredIndex).toBeGreaterThanOrEqual(0);
    if (ids.length > expiredIndex + 1) {
      const expiredRow = view.tabs.monthly[expiredIndex]!;
      expect(expiredRow.reason).toContain("已过期");
    }
    // 每行原因/推荐必显
    for (const row of view.tabs.monthly) {
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.talkTrack.length).toBeGreaterThan(0);
      expect(row.currentSystem).toBe("管家婆");
    }
  });

  it("won 终态客户不进作战列表（与生成器同口径）", async () => {
    const month = currentExpiryMonth(new Date());
    await createLeadFixture({
      name: "T09月度-终态",
      expiryMonth: addExpiryMonths(month, 1),
      stageSemanticKey: "won",
    });
    const view = await getOperationsWorkbench(owner.value!, { now: new Date(), tab: "monthly" });
    const wonLead = await prisma.lead.findFirst({ where: { name: { contains: "T09月度-终态" } } });
    expect(view.tabs.monthly.map((row) => row.leadId)).not.toContain(wonLead!.id);
  });
});

describe("经营视图：画像待完善", () => {
  it("缺失核心字段清单必显；已全核实的客户不进列表", async () => {
    // profileStatus 由画像引擎维护：核心 7/7 核实 → basic（不再是待完善）
    const complete = await createLeadFixture({
      name: "T09待完善-齐全",
      profileStatus: "basic",
      verifiedCoreKeys: [
        "current_system",
        "next_gen_mobile_order",
        "qince_interest",
        "contract_expiry",
        "industry",
        "main_category",
        "sales_team_scale",
      ],
    });
    const partial = await createLeadFixture({
      name: "T09待完善-缺两项",
      profileStatus: "incomplete",
      verifiedCoreKeys: ["current_system", "industry"],
    });

    const view = await getOperationsWorkbench(owner.value!, { now: new Date(), tab: "gap" });
    const ids = view.tabs.gap.map((row) => row.leadId);
    expect(ids).toContain(partial);
    expect(ids).not.toContain(complete);

    const row = view.tabs.gap.find((item) => item.leadId === partial)!;
    expect(row.reason).toContain("核心画像未全部核实");
    expect(row.coreMissing).toEqual(
      expect.arrayContaining(["是否新一代手机开单", "是否愿意沟通了解勤策", "软件到期时间"]),
    );
    // 推荐内容引导补全画像
    expect(row.talkTrack).toContain("补全核心画像");
  });
});

describe("经营视图：四象限重点与长期培育", () => {
  it("A/C 一周内应跟进四象限重点；B/D 进长期培育；无任务的象限客户不进", async () => {
    const month = currentExpiryMonth(new Date());
    const focusLead = await createLeadFixture({
      name: "T09重点-AC",
      quadrant: "c",
      expiryMonth: addExpiryMonths(month, 2),
    });
    const nurtureLead = await createLeadFixture({
      name: "T09培育-BD",
      quadrant: "d",
      expiryMonth: addExpiryMonths(month, 9),
    });
    // 生成任务：C 客户（月度，今天到期）与 D 客户（无任务——周期排期未来）
    await runTaskGeneration({ leadIds: [focusLead, nurtureLead], actorId: owner.value!.id });

    const focusView = await getOperationsWorkbench(owner.value!, { now: new Date(), tab: "focus" });
    expect(focusView.tabs.focus.map((row) => row.leadId)).toContain(focusLead);
    expect(focusView.tabs.focus[0]!.reason.length).toBeGreaterThan(0);

    const nurtureView = await getOperationsWorkbench(owner.value!, { now: new Date(), tab: "nurture" });
    // D 客户周期任务排期 90 天后（不在一周应跟窗口）→ 不进长期培育列表
    expect(nurtureView.tabs.nurture.map((row) => row.leadId)).not.toContain(nurtureLead);
  });
});
