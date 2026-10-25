import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestUser,
  getPresetStage,
} from "./helpers";
import { listLeads } from "@/server/services/leads";

// T04 验收项「组合筛选结果与 SQL 手查一致；分页正确」：
// 用固定 25 条数据（互不相同的 updated_at 保证排序确定）与手写 SQL
// 逐项对账——列表服务的 where/排序/分页与 SQL 语义必须完全一致。

afterAll(cleanupTestUsers);

const TOTAL = 25;

/** 直插 leads（显式 createdAt/updatedAt 保证排序确定；不经服务层，事件不适用本测试） */
async function seedLeads(
  ownerId: string,
  stageNew: string,
  stageContacted: string,
): Promise<void> {
  const data = Array.from({ length: TOTAL }, (_, i) => ({
    name: `对账客户${String(i).padStart(2, "0")}`,
    city: i % 2 === 0 ? "武汉" : "南昌",
    industry: i % 3 === 0 ? "快消" : "制造",
    contactName: `联系人${i}`,
    contactPhone: i % 5 === 0 ? `1390000${String(1000 + i)}` : null,
    stageId: i % 4 === 0 ? stageContacted : stageNew,
    priority: (i % 3 === 0 ? "high" : "mid") as "high" | "mid",
    ownerId,
    dataVersion: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
    updatedAt: new Date(Date.UTC(2026, 0, 2, 0, i)),
  }));
  await prisma.lead.createMany({ data });
}

async function rawIds(
  whereSql: Prisma.Sql,
  limit: number,
  offset: number,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM leads
    WHERE deleted_at IS NULL ${whereSql}
    ORDER BY updated_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.map((row) => row.id);
}

async function rawTotal(whereSql: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*) AS count FROM leads
    WHERE deleted_at IS NULL ${whereSql}
  `);
  return Number(rows[0]?.count ?? 0);
}

describe("组合筛选与分页：与 SQL 手查逐项一致", () => {
  it("无筛选分页：每页条数、顺序、total 与 SQL 完全一致；翻页无重叠无遗漏", async () => {
    const sales = await createTestUser("sales");
    const newStage = await getPresetStage("new_lead");
    const contacted = await getPresetStage("contacted");
    await seedLeads(sales.id, newStage.id, contacted.id);

    // Prisma 参数以 text 传入，uuid 列需显式转换
    const scope = Prisma.sql`AND owner_id = ${sales.id}::uuid`;
    const page1 = await listLeads(sales, { page: 1, pageSize: 20 });
    const page2 = await listLeads(sales, { page: 2, pageSize: 20 });

    expect(page1.total).toBe(TOTAL);
    expect(page1.total).toBe(await rawTotal(scope));
    expect(page1.items).toHaveLength(20);
    expect(page2.items).toHaveLength(5);
    expect(page1.items.map((item) => item.id)).toEqual(
      await rawIds(scope, 20, 0),
    );
    expect(page2.items.map((item) => item.id)).toEqual(
      await rawIds(scope, 20, 20),
    );
    // 无重叠、无遗漏
    const all = [...page1.items, ...page2.items].map((item) => item.id);
    expect(new Set(all).size).toBe(TOTAL);
  });

  it("组合筛选（城市+阶段+优先级+关键词）与 SQL 一致", async () => {
    const sales = await createTestUser("sales");
    const newStage = await getPresetStage("new_lead");
    const contacted = await getPresetStage("contacted");
    await seedLeads(sales.id, newStage.id, contacted.id);

    const query = {
      page: 1,
      pageSize: 100,
      city: "武汉",
      stageId: newStage.id,
      priority: "high" as const,
      keyword: "对账客户",
    };
    const result = await listLeads(sales, query);

    const whereSql = Prisma.sql`AND owner_id = ${sales.id}::uuid
      AND city = ${query.city}
      AND stage_id = ${query.stageId}::uuid
      AND priority = 'high'
      AND (name ILIKE ${`%${query.keyword}%`}
        OR contact_name ILIKE ${`%${query.keyword}%`}
        OR contact_phone LIKE ${`%${query.keyword}%`})`;
    expect(result.total).toBe(await rawTotal(whereSql));
    expect(result.items.map((item) => item.id)).toEqual(
      await rawIds(whereSql, 100, 0),
    );
  });

  it("关键词命中联系人/电话字段与 SQL 一致；软删除行不出现", async () => {
    const sales = await createTestUser("sales");
    const newStage = await getPresetStage("new_lead");
    await seedLeads(sales.id, newStage.id, newStage.id);

    const byContact = await listLeads(sales, {
      page: 1,
      pageSize: 100,
      keyword: "联系人3",
    });
    const contactWhere = Prisma.sql`AND owner_id = ${sales.id}::uuid
      AND (name ILIKE '%联系人3%' OR contact_name ILIKE '%联系人3%' OR contact_phone LIKE '%联系人3%')`;
    expect(byContact.total).toBe(await rawTotal(contactWhere));

    const byPhone = await listLeads(sales, {
      page: 1,
      pageSize: 100,
      keyword: "13900001000",
    });
    expect(byPhone.total).toBe(1);
    expect(byPhone.items[0]?.contactPhone).toBe("13900001000");

    // 软删除第一条后，列表与 total 同步少 1
    const first = await prisma.lead.findFirstOrThrow({
      where: { ownerId: sales.id },
      orderBy: { updatedAt: "asc" },
    });
    await prisma.lead.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });
    const afterDelete = await listLeads(sales, { page: 1, pageSize: 100 });
    expect(afterDelete.total).toBe(TOTAL - 1);
  });

  it("数据范围：销售的 ownerId 参数无效（强制本人）；管理员按负责人筛选与 SQL 一致", async () => {
    const salesA = await createTestUser("sales");
    const salesB = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const newStage = await getPresetStage("new_lead");
    await seedLeads(salesA.id, newStage.id, newStage.id);
    await seedLeads(salesB.id, newStage.id, newStage.id);

    // 销售 A 试图用 ownerId=B 拉取 B 的数据 → 仍只有本人
    const scoped = await listLeads(salesA, {
      page: 1,
      pageSize: 100,
      ownerId: salesB.id,
    });
    expect(scoped.total).toBe(TOTAL);
    expect(scoped.items.every((item) => item.ownerId === salesA.id)).toBe(true);

    // 管理员按负责人筛选
    const filtered = await listLeads(admin, {
      page: 1,
      pageSize: 100,
      ownerId: salesB.id,
    });
    const ownerWhere = Prisma.sql`AND owner_id = ${salesB.id}::uuid`;
    expect(filtered.total).toBe(await rawTotal(ownerWhere));
    expect(filtered.items.map((item) => item.id)).toEqual(
      await rawIds(ownerWhere, 100, 0),
    );

    // 管理员无筛选 = 全库非删除线索（与 SQL 对照，开发库可能含其他数据）
    const all = await listLeads(admin, { page: 1, pageSize: 100 });
    expect(all.total).toBe(await rawTotal(Prisma.empty));
    expect(all.total).toBeGreaterThanOrEqual(TOTAL * 2);
  });
});
