import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { cleanupTestUsers, createTestUser } from "./helpers";
import {
  createDictEntry,
  deactivateDictEntry,
  getEnabledDictValueMap,
  listDictEntries,
  updateDictEntry,
} from "@/server/services/dicts";
import { createLead, updateLead } from "@/server/services/leads";
import { ApiError } from "@/server/http/api";
import { DICT_FIELD_KEYS } from "@/lib/dict";

// V2.0-T02 数据字典验收项（数据侧）：
// ① 仅管理员可写（销售 403 + 审计留痕）；
// ② 启用字典后提交非法值 400（新建/编辑），错误原因中文准确；
// ③ 字典值合法提交通过；存量非字典值可显示、编辑提交旧值须改选（400）；
// ④ 停用值不再可选（提交 400），启用恢复可选；
// ⑤ dict_enabled 旗标随启用值数量自动同步（首个启用值启用、全停用关闭）；
// ⑥ 白名单外 fieldKey 404。

afterAll(cleanupTestUsers);

// 字典条目是全局数据：清理测试涉及字段的历史残留（含此前失败运行遗留），
// 保证测试可重复执行；审计由 cleanupTestUsers 按 userId 回收；
// current_system 为 seed 预置数据，不在清理范围。
async function cleanupTestDictEntries(): Promise<void> {
  await prisma.dictEntry.deleteMany({
    where: {
      fieldKey: { in: ["warehouse_type", "sales_mode", "purchase_intent"] },
    },
  });
}

beforeAll(cleanupTestDictEntries);
afterAll(cleanupTestDictEntries);

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

describe("字典 CRUD 与权限", () => {
  it("仅管理员可写：销售 POST/PATCH/DELETE 一律 403", async () => {
    const sales = await createTestUser("sales");
    await expectApiError(
      () => createDictEntry(sales, "industry", { value: "快消-酒水" }),
      403,
    );
    await expectApiError(
      () => updateDictEntry(sales, "industry", "00000000-0000-4000-8000-000000000000", { value: "x" }),
      403,
    );
    await expectApiError(
      () => deactivateDictEntry(sales, "industry", "00000000-0000-4000-8000-000000000000"),
      403,
    );
  });

  it("管理员建值 → dict_enabled 自动置真；停用最后一个值 → 自动关闭；审计留痕", async () => {
    const admin = await createTestUser("admin");
    const created = await createDictEntry(admin, "warehouse_type", {
      value: "平仓",
    });
    expect(created).toMatchObject({ value: "平仓", isActive: true, sortOrder: 1 });

    let def = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "warehouse_type" },
    });
    expect(def.dictEnabled).toBe(true);

    // 重复创建（启用中）→ 409
    await expectApiError(
      () => createDictEntry(admin, "warehouse_type", { value: "平仓" }),
      409,
      "dict_value_conflict",
    );

    // 停用 → dict_enabled 关闭；历史数据不受影响（无行删除）
    await deactivateDictEntry(admin, "warehouse_type", created.id);
    def = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "warehouse_type" },
    });
    expect(def.dictEnabled).toBe(false);
    const row = await prisma.dictEntry.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.isActive).toBe(false);

    // 重新创建同值 → 复用停用行（复活）而非重复占行
    const revived = await createDictEntry(admin, "warehouse_type", { value: "平仓" });
    expect(revived.id).toBe(created.id);
    expect(revived.isActive).toBe(true);

    // 审计留痕
    const audits = await prisma.auditLog.findMany({
      where: { objectType: "dict_entry", objectId: created.id },
    });
    expect(audits.map((audit) => audit.action)).toEqual(
      expect.arrayContaining(["dict.entry_created", "dict.entry_deactivated"]),
    );
  });

  it("白名单外 fieldKey 404；改值冲突 409", async () => {
    const admin = await createTestUser("admin");
    await expectApiError(
      () => createDictEntry(admin, "contact_phone", { value: "x" }),
      404,
    );
    await expectApiError(
      () => listDictEntries("not_a_field"),
      404,
    );
    const a = await createDictEntry(admin, "sales_mode", { value: "访销" });
    const b = await createDictEntry(admin, "sales_mode", { value: "车销" });
    await expectApiError(
      () => updateDictEntry(admin, "sales_mode", b.id, { value: "访销" }),
      409,
      "dict_value_conflict",
    );
    // 清理本用例字典值（全局数据：恢复到测试前状态）
    await deactivateDictEntry(admin, "sales_mode", a.id);
    await deactivateDictEntry(admin, "sales_mode", b.id);
  });
});

describe("字典启用校验（新建/编辑）", () => {
  it("启用字典后：非法值 400（错误原因中文准确）；字典值通过；null 清空放行", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    await createDictEntry(admin, "purchase_intent", { value: "一个月内" });
    await createDictEntry(admin, "purchase_intent", { value: "三个月内" });

    await expectApiError(
      () =>
        createLead(sales, {
          name: "字典校验客户",
          purchaseIntent: "下半年看看",
        }),
      400,
      "dict_value_invalid",
    );

    const lead = await createLead(sales, {
      name: "字典合法客户",
      purchaseIntent: "一个月内",
    });
    expect(lead.purchaseIntent).toBe("一个月内");

    // 编辑提交非法值 → 400；清空（null）放行
    await expectApiError(
      () =>
        updateLead(sales, lead.id, {
          dataVersion: lead.dataVersion,
          purchaseIntent: "明年再说",
        }),
      400,
      "dict_value_invalid",
    );
    const cleared = await updateLead(sales, lead.id, {
      dataVersion: lead.dataVersion,
      purchaseIntent: null,
    });
    expect(cleared.purchaseIntent).toBeNull();

    // 未触及字段不校验（编辑其他字段不因字典受阻）
    const untouched = await updateLead(sales, lead.id, {
      dataVersion: cleared.dataVersion,
      city: "合肥",
    });
    expect(untouched.city).toBe("合肥");

    // 清理（全局数据）
    const entries = await prisma.dictEntry.findMany({
      where: { fieldKey: "purchase_intent" },
    });
    for (const entry of entries) {
      await deactivateDictEntry(admin, "purchase_intent", entry.id);
    }
  });

  it("存量非字典值：可显示（原样读取），编辑提交旧值须改选（400）", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    // 字典启用前创建（自由文本值）
    const legacy = await createLead(sales, {
      name: "存量自由值客户",
      salesMode: "直销+渠道混合",
    });
    expect(legacy.salesMode).toBe("直销+渠道混合");

    await createDictEntry(admin, "sales_mode", { value: "访销" });
    await createDictEntry(admin, "sales_mode", { value: "车销" });

    // 编辑提交旧的非字典值 → 拒绝（不静默改写）
    await expectApiError(
      () =>
        updateLead(sales, legacy.id, {
          dataVersion: legacy.dataVersion,
          salesMode: "直销+渠道混合",
          city: "武汉",
        }),
      400,
      "dict_value_invalid",
    );

    // 改选字典值 → 通过
    const updated = await updateLead(sales, legacy.id, {
      dataVersion: legacy.dataVersion,
      salesMode: "车销",
    });
    expect(updated.salesMode).toBe("车销");

    const entries = await prisma.dictEntry.findMany({
      where: { fieldKey: "sales_mode" },
    });
    for (const entry of entries) {
      await deactivateDictEntry(admin, "sales_mode", entry.id);
    }
  });

  it("seed 幂等：current_system 预置 8 项（3 新一代标记）重复执行不重复", async () => {
    const entries = await prisma.dictEntry.findMany({
      where: { fieldKey: "current_system" },
      orderBy: { sortOrder: "asc" },
    });
    expect(entries.length).toBe(8);
    const nextGen = entries.filter(
      (entry) => (entry.meta as { isNextGen?: boolean } | null)?.isNextGen === true,
    );
    expect(nextGen.map((entry) => entry.value).sort()).toEqual([
      "商圈云",
      "爱快消",
      "舟谱",
    ]);
    const def = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "current_system" },
    });
    expect(def.dictEnabled).toBe(true);
  });

  it("getEnabledDictValueMap：只含 dict_enabled 字段的启用值", async () => {
    const map = await getEnabledDictValueMap();
    expect(map.has("current_system")).toBe(true);
    for (const key of DICT_FIELD_KEYS) {
      if (key !== "current_system") {
        // 其他字段在测试中可能被启用或停用，但值域必与启用旗标一致
        const def = await prisma.leadFieldDef.findUniqueOrThrow({ where: { key } });
        expect(map.has(key)).toBe(def.dictEnabled);
      }
    }
  });
});
