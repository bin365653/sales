import { afterAll, describe, expect, it } from "vitest";
import { ApiError } from "@/server/http/api";
import { prisma } from "@/server/db";
import {
  cleanupTestUsers,
  createTestFieldDef,
  createTestStage,
  createTestUser,
  getPresetStage,
  registerTestFieldDef,
  registerTestStage,
  uniqueSuffix,
} from "./helpers";
import {
  createStage,
  getStageBySemanticKey,
  listStages,
  updateStage,
} from "@/server/services/stages";
import {
  createFieldDef,
  listFieldDefs,
  updateFieldDef,
} from "@/server/services/lead-fields";
import {
  createLead,
  getLeadDetail,
  transitionStage,
  updateLead,
} from "@/server/services/leads";

// T03 验收项（配置侧）：
// - 新增阶段出现在可选列表（启用阶段列表）；
// - 改名/改码后历史事件快照可读、指标锚点不变（集成验证 + 单测固化 Schema 面）；
// - 停用阶段不可作为新流转目标；
// - 自定义字段校验（服务端执行、与共享引擎一致）；
// - 配置写权限仅管理员（服务层之上由路由 assertAdmin 把关，权限判定单测见 permissions.test.ts）。

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

describe("阶段全配置（K2/C02）", () => {
  it("新增阶段出现在启用阶段列表（可选列表），排序生效", async () => {
    const admin = await createTestUser("admin");
    const suffix = uniqueSuffix();
    const created = await createStage(admin, {
      code: `t_stage_${suffix}`,
      name: "测试自定义阶段",
      sortOrder: 999,
    });
    registerTestStage(created.id);
    expect(created.semanticKey).toBeNull(); // 自定义阶段无语义锚点

    const active = await listStages({ activeOnly: true });
    const found = active.find((stage) => stage.id === created.id);
    expect(found).toBeDefined();
    expect(found?.name).toBe("测试自定义阶段");

    // 排序按 sortOrder
    const codes = active.map((stage) => stage.code);
    expect(codes.indexOf("new_lead")).toBeLessThan(codes.indexOf(`t_stage_${suffix}`));
  });

  it("编码唯一：重复编码 409", async () => {
    const admin = await createTestUser("admin");
    const suffix = uniqueSuffix();
    await createTestStage({ code: `dup_${suffix}`, name: "已存在" });
    await expectApiError(
      () => createStage(admin, { code: `dup_${suffix}`, name: "撞码" }),
      409,
      "stage_code_conflict",
    );
  });

  it("改名/改码后：历史事件快照仍按当时编码/名称可读，指标锚点不变", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const suffix = uniqueSuffix();

    const custom = await createTestStage({ code: `hist_${suffix}`, name: "旧名称" });
    const lead = await createLead(sales, { name: "历史快照验证客户" });
    // 通过真实服务路径流转，产生 stage_changed 事件（含当时快照）
    const moved = await transitionStage(sales, lead.id, {
      stageId: custom.id,
      dataVersion: lead.dataVersion,
    });
    expect(moved.changed).toBe(true);

    // 改名 + 改码
    const renamed = await updateStage(admin, custom.id, {
      name: "新名称",
      code: `hist2_${suffix}`,
    });
    expect(renamed.name).toBe("新名称");
    expect(renamed.code).toBe(`hist2_${suffix}`);

    // 历史事件快照不受影响：仍可读当时的编码/名称
    const detail = await getLeadDetail(sales, lead.id);
    const changedEvent = detail.events.find((event) => event.eventType === "stage_changed");
    expect(changedEvent).toBeDefined();
    const snapshot = changedEvent?.stageSnapshot as {
      to: { code: string; name: string; semanticKey: string | null };
    };
    expect(snapshot.to.code).toBe(`hist_${suffix}`);
    expect(snapshot.to.name).toBe("旧名称");
    expect(snapshot.to.semanticKey).toBeNull();

    // 指标锚点：预置阶段改名后，语义锚点仍解析到同一行（口径不变）
    const qualifiedBefore = (await getStageBySemanticKey("qualified"))!;
    await updateStage(admin, qualifiedBefore.id, { name: "合格商机（改名验证）" });
    const qualifiedAfter = (await getStageBySemanticKey("qualified"))!;
    expect(qualifiedAfter.id).toBe(qualifiedBefore.id);
    expect(qualifiedAfter.semanticKey).toBe("qualified");
    expect(qualifiedAfter.name).toBe("合格商机（改名验证）");
    await updateStage(admin, qualifiedBefore.id, { name: "合格商机" }); // 还原
  });

  it("停用阶段：不可作为新流转目标；已处于该阶段的线索不受影响", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const suffix = uniqueSuffix();

    const stage = await createTestStage({ code: `off_${suffix}`, name: "待停用阶段" });
    const lead = await createLead(sales, {
      name: "停用阶段验证客户",
      stageId: stage.id,
    });
    expect(lead.stage.id).toBe(stage.id);

    await updateStage(admin, stage.id, { isActive: false });

    // 新建：不可指定停用阶段
    await expectApiError(
      () => createLead(sales, { name: "不可用", stageId: stage.id }),
      400,
      "stage_inactive",
    );

    // 流转：不可流转到停用阶段
    await expectApiError(
      () =>
        transitionStage(sales, lead.id, {
          stageId: stage.id,
          dataVersion: lead.dataVersion,
        }),
      400,
      "stage_inactive",
    );

    // 处于停用阶段的线索仍可读、仍可流转离开
    const detail = await getLeadDetail(sales, lead.id);
    expect(detail.lead.stageId).toBe(stage.id);
    const newLead = await getPresetStage("new_lead");
    const out = await transitionStage(sales, lead.id, {
      stageId: newLead.id,
      dataVersion: lead.dataVersion,
    });
    expect(out.changed).toBe(true);

    // 启用列表不含停用阶段；管理员全量列表可见
    const active = await listStages({ activeOnly: true });
    expect(active.some((item) => item.id === stage.id)).toBe(false);
    const all = await listStages({ activeOnly: false });
    expect(all.some((item) => item.id === stage.id)).toBe(true);
  });
});

describe("自定义字段（C12）", () => {
  it("新建字段定义：进入启用列表；key 重复与内置 key 冲突 409", async () => {
    const admin = await createTestUser("admin");
    const suffix = uniqueSuffix();

    const def = await createFieldDef(admin, {
      key: `cf_note_${suffix}`,
      label: "渠道备注",
      type: "text",
      validation: { maxLength: 50 },
    });
    registerTestFieldDef(def.id);
    expect(def.isBuiltin).toBe(false);
    const active = await listFieldDefs({ activeOnly: true });
    expect(active.some((item) => item.id === def.id)).toBe(true);

    await expectApiError(
      () => createFieldDef(admin, { key: `cf_note_${suffix}`, label: "重复", type: "text" }),
      409,
      "field_key_conflict",
    );
    await expectApiError(
      () => createFieldDef(admin, { key: "city", label: "撞内置", type: "text" }),
      409,
      "field_key_conflict",
    );
  });

  it("内置字段保护：不可改选项/校验规则；客户名称不可停用", async () => {
    const admin = await createTestUser("admin");
    const cityDef = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "city" },
    });
    await expectApiError(
      () => updateFieldDef(admin, cityDef.id, { validation: { required: true } }),
      400,
      "builtin_field_immutable",
    );
    const nameDef = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "name" },
    });
    await expectApiError(
      () => updateFieldDef(admin, nameDef.id, { isActive: false }),
      400,
      "field_required_core",
    );
  });

  it("线索提交走同一校验引擎：类型/范围/选项/必填在服务端执行", async () => {
    const sales = await createTestUser("sales");
    const suffix = uniqueSuffix();

    const fleetDef = await createTestFieldDef({
      key: `cf_fleet_${suffix}`,
      label: "配送车辆数",
      type: "number",
      validation: { min: 1, max: 50 },
    });
    const regionDef = await createTestFieldDef({
      key: `cf_region_${suffix}`,
      label: "重点区域",
      type: "single_select",
      options: [
        { value: "hubei", label: "湖北" },
        { value: "anhui", label: "安徽" },
      ],
    });
    const mustDef = await createTestFieldDef({
      key: `cf_must_${suffix}`,
      label: "必填备注",
      type: "text",
      validation: { required: true },
    });

    try {
      // 新建：必填缺失 → 400
      await expectApiError(
        () =>
          createLead(sales, {
            name: "校验客户",
            customValues: { [`cf_fleet_${suffix}`]: 3 },
          }),
        400,
        "custom_field_invalid",
      );

      // 单选项外的值 → 400
      await expectApiError(
        () =>
          createLead(sales, {
            name: "校验客户",
            customValues: {
              [`cf_must_${suffix}`]: "ok",
              [`cf_region_${suffix}`]: "jiangxi",
            },
          }),
        400,
        "custom_field_invalid",
      );

      // 合法提交：数字字符串归一化为数字
      const lead = await createLead(sales, {
        name: "校验客户",
        customValues: {
          [`cf_must_${suffix}`]: "必填值",
          [`cf_fleet_${suffix}`]: "5",
          [`cf_region_${suffix}`]: "hubei",
        },
      });
      expect(lead.customValues).toEqual({
        [`cf_must_${suffix}`]: "必填值",
        [`cf_fleet_${suffix}`]: 5,
        [`cf_region_${suffix}`]: "hubei",
      });

      // 编辑：局部提交保留未触及键；null 清空；范围外拒绝
      const updated = await updateLead(sales, lead.id, {
        dataVersion: lead.dataVersion,
        customValues: { [`cf_fleet_${suffix}`]: null },
      });
      expect(updated.customValues).toEqual({
        [`cf_must_${suffix}`]: "必填值",
        [`cf_region_${suffix}`]: "hubei",
      });
      await expectApiError(
        () =>
          updateLead(sales, lead.id, {
            dataVersion: updated.dataVersion,
            customValues: { [`cf_fleet_${suffix}`]: 99 },
          }),
        400,
        "custom_field_invalid",
      );
    } finally {
      // 立即移除（含必填字段），避免影响本文件后续用例的线索创建
      await prisma.leadFieldDef.deleteMany({
        where: { id: { in: [fleetDef.id, regionDef.id, mustDef.id] } },
      });
    }
  });

  it("停用内置字段后提交该字段被拒绝；重新启用恢复", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const cityDef = await prisma.leadFieldDef.findUniqueOrThrow({
      where: { key: "city" },
    });

    try {
      await updateFieldDef(admin, cityDef.id, { isActive: false });
      await expectApiError(
        () => createLead(sales, { name: "停用字段客户", city: "武汉" }),
        400,
        "field_disabled",
      );
      // 不提交该字段则不受影响（空值可保存）
      const lead = await createLead(sales, { name: "停用字段客户" });
      expect(lead.city).toBeNull();

      await updateFieldDef(admin, cityDef.id, { isActive: true });
      const restored = await updateLead(sales, lead.id, {
        dataVersion: lead.dataVersion,
        city: "武汉",
      });
      expect(restored.city).toBe("武汉");
    } finally {
      // 城市是共享内置配置：任何路径（含断言失败）都必须还原，否则污染其他用例与后续运行
      await prisma.leadFieldDef.update({
        where: { id: cityDef.id },
        data: { isActive: true },
      });
    }
  });

  it("停用自定义字段：提交值被拒绝，存量数据保留", async () => {
    const admin = await createTestUser("admin");
    const sales = await createTestUser("sales");
    const suffix = uniqueSuffix();
    const def = await createTestFieldDef({
      key: `cf_arch_${suffix}`,
      label: "即将停用",
      type: "text",
    });

    const lead = await createLead(sales, {
      name: "归档字段客户",
      customValues: { [`cf_arch_${suffix}`]: "存量值" },
    });
    await updateFieldDef(admin, def.id, { isActive: false });

    await expectApiError(
      () =>
        updateLead(sales, lead.id, {
          dataVersion: lead.dataVersion,
          customValues: { [`cf_arch_${suffix}`]: "新值" },
        }),
      400,
      "custom_field_invalid",
    );
    // 存量数据不动
    const detail = await getLeadDetail(sales, lead.id);
    expect(detail.lead.customValues).toEqual({ [`cf_arch_${suffix}`]: "存量值" });
  });

  it("未知自定义字段键被拒绝", async () => {
    const sales = await createTestUser("sales");
    await expectApiError(
      () =>
        createLead(sales, {
          name: "未知字段客户",
          customValues: { cf_not_defined_anywhere: "x" },
        }),
      400,
      "custom_field_invalid",
    );
  });
});
