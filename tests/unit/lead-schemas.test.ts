import { describe, expect, it } from "vitest";
import {
  leadCreateSchema,
  leadListQuerySchema,
  leadStageTransitionSchema,
  leadUpdateSchema,
  parseShanghaiDate,
  providedBuiltinKeys,
} from "../../src/lib/schemas/lead";
import {
  fieldDefCreateSchema,
  fieldDefUpdateSchema,
  stageCreateSchema,
  stageUpdateSchema,
} from "../../src/lib/schemas/settings";
import { buildStageSnapshot } from "../../src/server/services/stages";

// T03 验收项固化：
// 1. 空值可保存——除客户名称外全字段可空，空串归一化为 null；
// 2. 前后端一致——API 与表单共用本 Schema 模块；
// 3. 语义锚点不可经 API 写入（改名改码后指标口径不变的结构保证）。

describe("leadCreateSchema —— 空值可保存", () => {
  it("仅客户名称即可通过（其余字段全部缺省）", () => {
    const parsed = leadCreateSchema.parse({ name: "武汉某商贸有限公司" });
    expect(parsed.name).toBe("武汉某商贸有限公司");
    expect(parsed.city).toBeUndefined();
    expect(parsed.customValues).toBeUndefined();
  });

  it("全字段空串提交归一化为 null，不报错", () => {
    const parsed = leadCreateSchema.parse({
      name: "测试客户",
      city: "",
      industry: "  ",
      contactPhone: "",
      salesTeamSize: "",
      consideringSwitch: "",
      contractExpiry: "",
      nextContactAt: "",
      remark: "",
    });
    expect(parsed.city).toBeNull();
    expect(parsed.industry).toBeNull();
    expect(parsed.contactPhone).toBeNull();
    expect(parsed.salesTeamSize).toBeNull();
    expect(parsed.contractExpiry).toBeNull();
    expect(parsed.nextContactAt).toBeNull();
    expect(parsed.remark).toBeNull();
    expect(parsed.consideringSwitch).toBeNull();
  });

  it("名称必填：空串/空白/缺失均拒绝", () => {
    expect(() => leadCreateSchema.parse({ name: "" })).toThrow();
    expect(() => leadCreateSchema.parse({ name: "   " })).toThrow();
    expect(() => leadCreateSchema.parse({})).toThrow();
  });

  it("文本超长、电话非法、人数非整数、进位日期均拒绝", () => {
    expect(() => leadCreateSchema.parse({ name: "x", city: "武".repeat(65) })).toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", contactPhone: "abc" })).toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", contactPhone: "13800138000" })).not.toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", salesTeamSize: 1.5 })).toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", salesTeamSize: "12" })).not.toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", contractExpiry: "2026-02-30" })).toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", contractExpiry: "2026-10-25" })).not.toThrow();
  });

  it("布尔字段接受 true/false 及表单字符串，归一化为 boolean/null", () => {
    const parsed = leadCreateSchema.parse({
      name: "x",
      consideringSwitch: "true",
      hasClearDemand: "false",
    });
    expect(parsed.consideringSwitch).toBe(true);
    expect(parsed.hasClearDemand).toBe(false);
  });

  it("核实状态与优先级枚举校验", () => {
    expect(() =>
      leadCreateSchema.parse({ name: "x", currentSystemStatus: "confirmed" }),
    ).not.toThrow();
    expect(() =>
      leadCreateSchema.parse({ name: "x", currentSystemStatus: "maybe" }),
    ).toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", priority: "high" })).not.toThrow();
    expect(() => leadCreateSchema.parse({ name: "x", priority: "urgent" })).toThrow();
  });
});

describe("leadUpdateSchema —— 局部更新与乐观并发", () => {
  it("dataVersion 必填；未提交字段为 undefined（不覆盖）", () => {
    const parsed = leadUpdateSchema.parse({ dataVersion: 3, city: "合肥" });
    expect(parsed.dataVersion).toBe(3);
    expect(parsed.city).toBe("合肥");
    expect(parsed.name).toBeUndefined();
    expect(() => leadUpdateSchema.parse({ city: "合肥" })).toThrow();
  });

  it("显式提交空名称被拒绝（不能把必填字段清空）", () => {
    expect(() => leadUpdateSchema.parse({ dataVersion: 1, name: "" })).toThrow();
    expect(() => leadUpdateSchema.parse({ dataVersion: 1, name: null })).toThrow();
  });

  it("阶段不在编辑面：stageId 被剥离（阶段流转只走 /stage 端点）", () => {
    const parsed = leadUpdateSchema.parse({
      dataVersion: 1,
       
      stageId: "0b7e3f7a-1111-4222-8333-444455556666",
    } as never);
    expect("stageId" in parsed).toBe(false);
  });

  it("自定义字段值类型受限（string | number | null）", () => {
    expect(() =>
      leadUpdateSchema.parse({ dataVersion: 1, customValues: { cf_a: "x" } }),
    ).not.toThrow();
    expect(() =>
      leadUpdateSchema.parse({ dataVersion: 1, customValues: { cf_a: { nested: true } } }),
    ).toThrow();
  });
});

describe("parseShanghaiDate —— 本地时间统一按 +08:00 解释（C13）", () => {
  it("纯日期 → 当日 00:00 +08:00", () => {
    expect(parseShanghaiDate("2026-10-25").toISOString()).toBe("2026-10-24T16:00:00.000Z");
  });

  it("无时区日期时间 → 按 +08:00（T 或空格分隔、可选秒）", () => {
    expect(parseShanghaiDate("2026-10-25T14:30").toISOString()).toBe("2026-10-25T06:30:00.000Z");
    expect(parseShanghaiDate("2026-10-25 14:30:00").toISOString()).toBe("2026-10-25T06:30:00.000Z");
  });

  it("带时区的完整 ISO 串按其时区解析", () => {
    expect(parseShanghaiDate("2026-10-25T00:00:00Z").toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });
});

describe("阶段与字段配置 Schema —— 语义锚点不可写入", () => {
  it("stageCreate/Update 均剥离 semanticKey（API 永远写不进锚点）", () => {
    const created = stageCreateSchema.parse({
      code: "custom_stage",
      name: "自定义阶段",
       
      semanticKey: "qualified",
    } as never);
    expect("semanticKey" in created).toBe(false);

    const updated = stageUpdateSchema.parse({
      code: "custom_stage2",
       
      semanticKey: "won",
    } as never);
    expect("semanticKey" in updated).toBe(false);
  });

  it("阶段编码格式与大写字母拒绝", () => {
    expect(() => stageCreateSchema.parse({ code: "ok_code", name: "名" })).not.toThrow();
    expect(() => stageCreateSchema.parse({ code: "BadCode", name: "名" })).toThrow();
    expect(() => stageCreateSchema.parse({ code: "1abc", name: "名" })).toThrow();
  });

  it("stageUpdate 至少一项修改", () => {
    expect(() => stageUpdateSchema.parse({})).toThrow();
    expect(() => stageUpdateSchema.parse({ isActive: true })).not.toThrow();
  });

  it("单选字段必须带选项；选项值重复拒绝；非法正则拒绝", () => {
    expect(() =>
      fieldDefCreateSchema.parse({ key: "cf_x", label: "x", type: "single_select" }),
    ).toThrow();
    expect(() =>
      fieldDefCreateSchema.parse({
        key: "cf_x",
        label: "x",
        type: "single_select",
        options: [
          { value: "a", label: "A" },
          { value: "a", label: "B" },
        ],
      }),
    ).toThrow();
    expect(() =>
      fieldDefCreateSchema.parse({
        key: "cf_x",
        label: "x",
        type: "text",
        validation: { pattern: "[" },
      }),
    ).toThrow();
  });

  it("字段定义 key/type 不可修改：更新面不接受这两个属性", () => {
    const updated = fieldDefUpdateSchema.parse({
       
      key: "cf_new_key",
       
      type: "number",
      label: "新名称",
    } as never);
    expect("key" in updated).toBe(false);
    expect("type" in updated).toBe(false);
    expect(updated.label).toBe("新名称");
  });
});

describe("buildStageSnapshot —— 历史快照与口径不变性（K2）", () => {
  it("快照固化当时的编码/名称/锚点，与阶段行后续修改解耦", () => {
    const stage = { id: "id-1", code: "qualified", name: "合格商机", semanticKey: "qualified" };
    const snapshot = buildStageSnapshot(stage);
    expect(snapshot).toEqual({
      id: "id-1",
      code: "qualified",
      name: "合格商机",
      semanticKey: "qualified",
    });
    // 阶段行改名改码后，快照对象保持当时的值（深拷贝语义）
    stage.code = "qualified_v2";
    stage.name = "合格商机（新）";
    expect(snapshot.code).toBe("qualified");
    expect(snapshot.name).toBe("合格商机");
    expect(snapshot.semanticKey).toBe("qualified");
  });

  it("自定义阶段快照 semanticKey 为 null（不参与指标口径）", () => {
    const snapshot = buildStageSnapshot({
      id: "id-2",
      code: "custom_stage",
      name: "自定义",
      semanticKey: null,
    });
    expect(snapshot.semanticKey).toBeNull();
  });
});

describe("providedBuiltinKeys —— 提交键映射为内置字段定义键", () => {
  it("camelCase 入参键映射到 snake_case 定义键，忽略非内置键", () => {
    expect(
      providedBuiltinKeys({ contactName: "张三", customValues: {}, dataVersion: 2 }),
    ).toEqual(["contact_name"]);
    expect(providedBuiltinKeys({ name: "x", city: "武汉" })).toEqual(["name", "city"]);
  });
});

describe("leadListQuerySchema / leadStageTransitionSchema", () => {
  it("分页参数缺省与上限", () => {
    const parsed = leadListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.pageSize).toBe(20);
    expect(() => leadListQuerySchema.parse({ pageSize: "101" })).toThrow();
    expect(leadListQuerySchema.parse({ pageSize: "50", page: "2" }).pageSize).toBe(50);
  });

  it("阶段流转必须带合法 UUID 与版本号", () => {
    expect(() =>
      leadStageTransitionSchema.parse({
        stageId: "0b7e3f7a-1111-4222-8333-444455556666",
        dataVersion: 1,
      }),
    ).not.toThrow();
    expect(() => leadStageTransitionSchema.parse({ stageId: "not-uuid", dataVersion: 1 })).toThrow();
    expect(() =>
      leadStageTransitionSchema.parse({
        stageId: "0b7e3f7a-1111-4222-8333-444455556666",
      }),
    ).toThrow();
  });
});
