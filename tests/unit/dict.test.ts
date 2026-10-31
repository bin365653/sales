import { describe, expect, it } from "vitest";
import {
  DICT_FIELD_KEYS,
  DICT_FIELD_KEY_SET,
  isNextGenMeta,
} from "@/lib/dict";
import { BUILTIN_LEAD_FIELD_KEYS } from "@/lib/lead-fields";
import { buildImportTemplateFields } from "@/lib/import/template";

// V2.0-T02 数据字典元数据与模板提示。

describe("字典字段白名单", () => {
  it("12 个字典字段全部是内置线索字段（snake_case 物理列名）", () => {
    expect(DICT_FIELD_KEYS).toHaveLength(12);
    for (const key of DICT_FIELD_KEYS) {
      expect(BUILTIN_LEAD_FIELD_KEYS.has(key)).toBe(true);
      expect(DICT_FIELD_KEY_SET.has(key)).toBe(true);
    }
  });

  it("isNextGenMeta：仅布尔 true 判定新一代", () => {
    expect(isNextGenMeta({ isNextGen: true })).toBe(true);
    expect(isNextGenMeta({ isNextGen: "true" })).toBe(false);
    expect(isNextGenMeta({})).toBe(false);
    expect(isNextGenMeta(null)).toBe(false);
  });
});

describe("导入模板字典提示", () => {
  it("字典启用字段在填写说明中给出可选值；非字典字段保持原提示", () => {
    const dictValues = new Map<string, string[]>([
      ["current_system", ["舟谱", "爱快消", "商圈云"]],
    ]);
    const fields = buildImportTemplateFields(
      [
        { key: "name", label: "客户名称" },
        { key: "current_system", label: "当前使用软件" },
        { key: "city", label: "城市" },
      ],
      [],
      dictValues,
    );
    const currentSystem = fields.find((field) => field.key === "current_system");
    expect(currentSystem?.hint).toContain("须从字典选择");
    expect(currentSystem?.hint).toContain("舟谱 / 爱快消 / 商圈云");
    const city = fields.find((field) => field.key === "city");
    expect(city?.hint).toBe("可留空");
  });
});
