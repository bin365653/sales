import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
  type TestUser,
} from "./helpers";
import { createLead, listLeads } from "@/server/services/leads";
import { applyInteractionWrite } from "@/server/services/interaction-write";
import { interactionCreateSchema } from "@/lib/schemas/interaction";
import { leadListQuerySchema } from "@/lib/schemas/lead";

// V2.0-T03 验收项（数据侧）：
// ① 新字段空值可保存（不强迫假数据）；
// ② 沟通「本次确认」扩展：确认动作后 DB 五元组齐变（值 + confirmed + 来源/核实人/时间
//    + updated 事件留痕）；勾选无值 400（Schema 层拒绝）；
// ③ 列表经营筛选（象限/意愿/新一代/到期视图/到期月）与 SQL 对账一致；
// - 到期年月归一化入库（YYYY-MM → 当月 1 日）。

afterAll(cleanupTestUsers);

describe("新字段空值与到期月粒度", () => {
  it("仅名称可创建（20 个新字段全空）；到期 YYYY-MM 入库当月 1 日", async () => {
    const sales = await createTestUser("sales");
    const empty = await createLead(sales, { name: "全空字段客户" });
    expect(empty.nextGenMobileOrder).toBeNull();
    expect(empty.qinceInterest).toBeNull();
    expect(empty.salesTeamScale).toBeNull();
    expect(empty.quadrantCode).toBeNull();
    // V2.0-T04：创建即计算完善度（核心 0/7 → incomplete）
    expect(empty.profileStatus).toBe("incomplete");

    const monthly = await createLead(sales, {
      name: "月粒度到期客户",
      contractExpiry: "2027-06",
    });
    expect(monthly.contractExpiry?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });
});

describe("沟通「本次确认」扩展（验收②）", () => {
  let sales: TestUser;
  let leadId: string;
  let withStage: Awaited<ReturnType<typeof setupLead>>;

  async function setupLead() {
    const lead = await createLead(sales, { name: "确认扩展客户" });
    return prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      include: { stage: true },
    });
  }

  beforeAll(async () => {
    sales = await createTestUser("sales");
    withStage = await setupLead();
    leadId = withStage.id;
  });

  it("勾选确认即写值 + 置 confirmed + 核实元数据同事务 + updated 事件留痕", async () => {
    const input = interactionCreateSchema.parse({
      occurredAt: "2026-10-31 11:00",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      currentSystemConfirmed: "舟谱",
      confirmCurrentSystem: true,
      confirmNextGen: true,
      nextGenConfirmed: "true",
      confirmQinceInterest: true,
      qinceInterestConfirmed: "true",
      confirmExpiry: true,
      expiryMonthConfirmed: "2027-06",
    });
    await prisma.$transaction((tx) =>
      applyInteractionWrite(tx, withStage, sales.id, input),
    );

    const fresh = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    // 值写入（确认即写值，V2.0 §5）
    expect(fresh.currentSystem).toBe("舟谱");
    expect(fresh.nextGenMobileOrder).toBe(true);
    expect(fresh.qinceInterest).toBe(true);
    expect(fresh.contractExpiry?.toISOString()).toBe("2027-06-01T00:00:00.000Z");
    // 旧状态列镜像（current_system 属于 V1.0 四列）
    expect(fresh.currentSystemStatus).toBe("confirmed");

    // 核实五元组：四条 confirmed/interaction/核实人/时间
    const rows = await prisma.leadFieldVerification.findMany({
      where: { leadId },
    });
    for (const fieldKey of [
      "current_system",
      "next_gen_mobile_order",
      "qince_interest",
      "contract_expiry",
    ]) {
      const row = rows.find((item) => item.fieldKey === fieldKey);
      expect(row, fieldKey).toBeTruthy();
      expect(row!.status).toBe("confirmed");
      expect(row!.source).toBe("interaction");
      expect(row!.verifiedBy).toBe(sales.id);
      expect(row!.verifiedAt).toBeInstanceOf(Date);
    }

    // updated 事件留痕（changed 含 from/to/statusTo，来源 interaction）
    const event = await prisma.leadEvent.findFirstOrThrow({
      where: { leadId, eventType: "updated", detail: { path: ["source"], equals: "interaction" } },
      orderBy: { occurredAt: "desc" },
    });
    const detail = event.detail as {
      changed: Record<string, { from: unknown; to: unknown; statusTo: string }>;
    };
    expect(detail.changed.next_gen_mobile_order).toMatchObject({
      from: null,
      to: true,
      statusTo: "confirmed",
    });
    expect(detail.changed.contract_expiry).toMatchObject({
      from: null,
      to: "2027-06-01",
    });
  });

  it("勾选确认但无值 → 400（空值确认会让分类轴停在未知）", async () => {
    const missingValue = interactionCreateSchema.safeParse({
      occurredAt: "2026-10-31 11:30",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      confirmNextGen: true,
    });
    expect(missingValue.success).toBe(false);
    if (!missingValue.success) {
      const paths = missingValue.error.issues.map((issue) => issue.path.join("."));
      expect(paths).toContain("nextGenConfirmed");
    }

    const missingExpiry = interactionCreateSchema.safeParse({
      occurredAt: "2026-10-31 11:30",
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      confirmExpiry: true,
    });
    expect(missingExpiry.success).toBe(false);
  });

  it("确认动作触发象限重算的前置数据已就位（T04 断言象限 c）", async () => {
    // 本用例客户：新一代=否（手工）+ 有意愿=是 → C·第三象限由 T04 重算写入；
    // T03 阶段仅断言双轴已确认（confirmed）已由上一用例落库。
    const rows = await prisma.leadFieldVerification.findMany({
      where: { leadId },
    });
    const nextGen = rows.find((row) => row.fieldKey === "next_gen_mobile_order");
    const interest = rows.find((row) => row.fieldKey === "qince_interest");
    expect(nextGen?.status).toBe("confirmed");
    expect(interest?.status).toBe("confirmed");
  });
});

describe("列表经营筛选与 SQL 对账（验收③）", () => {
  let sales: TestUser;

  beforeAll(async () => {
    sales = await createTestUser("sales");
    const stage = await getPresetStage("new_lead");
    const base = {
      ownerId: sales.id,
      stageId: stage.id,
    };
    // 四象限 + 待完善
    await prisma.lead.create({ data: { ...base, name: "筛-A客户", quadrantCode: "a" } });
    await prisma.lead.create({ data: { ...base, name: "筛-C客户", quadrantCode: "c" } });
    await prisma.lead.create({ data: { ...base, name: "筛-待完善客户" } });
    // 意愿 / 新一代（未知≠否）
    await prisma.lead.create({
      data: { ...base, name: "筛-有意愿", qinceInterest: true },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-明确无意愿", qinceInterest: false },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-新一代是", nextGenMobileOrder: true },
    });
    // 到期：上月（过期）/ 当月 / +6 / +7 / null
    const monthStart = (offset: number): Date => {
      const now = new Date();
      const utc = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1),
      );
      return utc;
    };
    await prisma.lead.create({
      data: { ...base, name: "筛-已过期", contractExpiry: monthStart(-1) },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-当月到期", contractExpiry: monthStart(0) },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-半年边界", contractExpiry: monthStart(6) },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-超半年", contractExpiry: monthStart(7) },
    });
    await prisma.lead.create({
      data: { ...base, name: "筛-到期未知" },
    });
  });

  async function listNames(query: Record<string, string>): Promise<string[]> {
    const parsed = leadListQuerySchema.parse({ page: 1, pageSize: 100, ...query });
    const result = await listLeads(sales, parsed);
    return result.items
      .filter((lead) => lead.name.startsWith("筛-"))
      .map((lead) => lead.name)
      .sort();
  }

  it("象限筛选：a / c / pending（画像待完善 = quadrant_code 为 null 的全部客户）", async () => {
    expect(await listNames({ quadrant: "a" })).toEqual(["筛-A客户"]);
    expect(await listNames({ quadrant: "c" })).toEqual(["筛-C客户"]);
    // 待完善 = quadrant_code null：除显式 a/c 外的全部夹具（含到期/意愿夹具）
    expect(await listNames({ quadrant: "pending" })).toEqual([
      "筛-当月到期",
      "筛-待完善客户",
      "筛-到期未知",
      "筛-明确无意愿",
      "筛-有意愿",
      "筛-新一代是",
      "筛-半年边界",
      "筛-超半年",
      "筛-已过期",
    ].sort());
  });

  it("意愿/新一代筛选：未知不当否（no 只命中显式 false）", async () => {
    expect(await listNames({ qinceInterest: "yes" })).toEqual(["筛-有意愿"]);
    expect(await listNames({ qinceInterest: "no" })).toEqual(["筛-明确无意愿"]);
    expect(await listNames({ nextGen: "yes" })).toEqual(["筛-新一代是"]);
    expect(await listNames({ nextGen: "no" })).toEqual([]);
  });

  it("到期视图筛选：过期/半年内（含第 6 月边界）/超半年不含在半年内", async () => {
    const expired = await listNames({ expiryView: "expired" });
    expect(expired).toEqual(["筛-已过期"]);
    const within6m = await listNames({ expiryView: "within_6m" });
    expect(within6m).toEqual(["筛-半年边界", "筛-当月到期"]);
    // within_6m 不含超半年（筛-超半年 +7 不出现）
    const within1m = await listNames({ expiryView: "within_1m" });
    expect(within1m).toEqual(["筛-当月到期"]);
    // 未知：到期为 null 的全部客户（未填到期即未知；A/C 夹具同样无到期）
    const unknown = await listNames({ expiryView: "unknown" });
    expect(unknown).toEqual([
      "筛-A客户",
      "筛-C客户",
      "筛-待完善客户",
      "筛-到期未知",
      "筛-明确无意愿",
      "筛-有意愿",
      "筛-新一代是",
    ].sort());
  });

  it("到期年月筛选：命中指定月（含当月 1 日）", async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    expect(await listNames({ expiryMonth: month })).toEqual(["筛-当月到期"]);
  });
});
