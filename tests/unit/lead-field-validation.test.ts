import { describe, expect, it } from "vitest";
import {
  findInactiveBuiltinKeys,
  isValidDateString,
  validateCustomValues,
} from "../../src/lib/lead-field-validation";

// 自定义字段校验引擎（T03 验收：字段校验含自定义字段，前后端共用同一实现）。
// 引擎为纯函数：这里固化全部类型与规则行为，供 API 服务与前端表单共同依赖。

describe("isValidDateString", () => {
  it("接受真实日历日期，拒绝进位日期与错误格式", () => {
    expect(isValidDateString("2026-10-25")).toBe(true);
    expect(isValidDateString("2024-02-29")).toBe(true); // 闰年
    expect(isValidDateString("2026-02-30")).toBe(false); // JS Date 会静默进位到 3 月
    expect(isValidDateString("2027-02-29")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-1-1")).toBe(false);
    expect(isValidDateString("2026/10/25")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });
});

describe("validateCustomValues —— text", () => {
  const defs = [
    {
      key: "cf_channel_note",
      type: "text" as const,
      validation: { minLength: 2, maxLength: 5, pattern: "^[\\u4e00-\\u9fa5]+$" },
    },
  ];

  it("合法文本通过并原样返回", () => {
    const result = validateCustomValues(defs, { cf_channel_note: "商超配送" });
    expect(result.issues).toEqual([]);
    expect(result.values).toEqual({ cf_channel_note: "商超配送" });
  });

  it("长度与正则规则生效", () => {
    expect(validateCustomValues(defs, { cf_channel_note: "一" }).issues[0]?.message).toContain("少于");
    expect(validateCustomValues(defs, { cf_channel_note: "超过五个字了" }).issues[0]?.message).toContain("超过");
    expect(validateCustomValues(defs, { cf_channel_note: "abcde" }).issues[0]?.message).toContain("格式");
  });

  it("非法类型报错", () => {
    expect(validateCustomValues(defs, { cf_channel_note: 123 }).issues[0]?.message).toContain("文本");
  });
});

describe("validateCustomValues —— number", () => {
  const defs = [
    { key: "cf_vehicles", type: "number" as const, validation: { min: 1, max: 50 } },
  ];

  it("数字与数字字符串均归一化为数字", () => {
    expect(validateCustomValues(defs, { cf_vehicles: 3 }).values).toEqual({ cf_vehicles: 3 });
    expect(validateCustomValues(defs, { cf_vehicles: "3" }).values).toEqual({ cf_vehicles: 3 });
  });

  it("范围与非法值报错", () => {
    expect(validateCustomValues(defs, { cf_vehicles: 0 }).issues[0]?.message).toContain("小于");
    expect(validateCustomValues(defs, { cf_vehicles: 51 }).issues[0]?.message).toContain("大于");
    expect(validateCustomValues(defs, { cf_vehicles: "abc" }).issues[0]?.message).toContain("数字");
    expect(validateCustomValues(defs, { cf_vehicles: true }).issues[0]?.message).toContain("数字");
  });
});

describe("validateCustomValues —— date", () => {
  const defs = [{ key: "cf_visit_date", type: "date" as const }];

  it("合法日期通过；进位日期与错误格式拒绝", () => {
    expect(validateCustomValues(defs, { cf_visit_date: "2026-10-25" }).issues).toEqual([]);
    expect(validateCustomValues(defs, { cf_visit_date: "2026-02-30" }).issues[0]?.message).toContain("日期");
    expect(validateCustomValues(defs, { cf_visit_date: "2026-10-25T00:00" }).issues[0]?.message).toContain("日期");
  });
});

describe("validateCustomValues —— single_select", () => {
  const defs = [
    {
      key: "cf_region",
      type: "single_select" as const,
      options: [
        { value: "hubei", label: "湖北" },
        { value: "anhui", label: "安徽" },
      ],
    },
  ];

  it("选项 value 命中通过（label 改名不影响存量 value）", () => {
    expect(validateCustomValues(defs, { cf_region: "hubei" }).issues).toEqual([]);
  });

  it("不在选项内的值拒绝", () => {
    expect(validateCustomValues(defs, { cf_region: "jiangxi" }).issues[0]?.message).toContain("可选范围");
    expect(validateCustomValues(defs, { cf_region: "湖北" }).issues[0]?.message).toContain("可选范围");
  });
});

describe("validateCustomValues —— required 与空值", () => {
  const defs = [
    { key: "cf_required_note", type: "text" as const, validation: { required: true } },
  ];

  it("非必填字段 null/空串/缺席均不报错且不产出值", () => {
    const optional = [{ key: "cf_optional", type: "text" as const }];
    for (const value of [null, "", undefined]) {
      const result = validateCustomValues(optional, { cf_optional: value as null });
      expect(result.issues).toEqual([]);
      expect(result.values).toEqual({});
    }
  });

  it("必填字段显式提交空值报错", () => {
    for (const value of [null, ""]) {
      const result = validateCustomValues(defs, { cf_required_note: value });
      expect(result.issues[0]?.message).toContain("必填");
    }
  });

  it("requireAll（新建）时必填字段缺席也报错；默认（编辑）时缺席不校验", () => {
    expect(
      validateCustomValues(defs, {}, { requireAll: true }).issues[0]?.message,
    ).toContain("必填");
    expect(validateCustomValues(defs, {}).issues).toEqual([]);
  });
});

describe("validateCustomValues —— 未知字段", () => {
  it("定义之外的非空键报未知；空值键忽略", () => {
    const defs = [{ key: "cf_known", type: "text" as const }];
    expect(
      validateCustomValues(defs, { cf_unknown: "x" }).issues[0]?.message,
    ).toContain("未知");
    expect(validateCustomValues(defs, { cf_unknown: null }).issues).toEqual([]);
  });
});

describe("findInactiveBuiltinKeys", () => {
  it("只返回已停用且出现在提交中的内置字段键", () => {
    const defs = [
      { key: "city", isActive: true },
      { key: "industry", isActive: false },
    ];
    expect(findInactiveBuiltinKeys(defs, ["city", "industry", "cf_custom"])).toEqual(["industry"]);
    expect(findInactiveBuiltinKeys(defs, ["city"])).toEqual([]);
  });
});
