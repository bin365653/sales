import { describe, expect, it } from "vitest";
import { validateRowByMapping } from "@/server/services/imports";
import type { FieldDefLike } from "@/lib/lead-field-validation";

// T05 验收项「错误行原因准确」：行级错误文案与表单校验同源
// （leadCreateSchema + 自定义字段引擎），中文原因逐字段给出。

interface Target {
  key: string;
  label: string;
  kind: "builtin" | "custom";
  type?: "text" | "number" | "date" | "single_select";
  options?: unknown;
  validation?: unknown;
}

function makeFieldDefs(builtin: { key: string; label: string }[], custom: Target[]) {
  const targets: Target[] = [
    ...builtin.map((field) => ({ ...field, kind: "builtin" as const })),
    ...custom,
  ];
  return {
    targets,
    targetByKey: new Map(targets.map((target) => [target.key, target])),
    activeCustomDefs: custom as FieldDefLike[],
  };
}

const CUSTOM_TARGETS: Target[] = [
  {
    key: "vip_level",
    label: "客户等级",
    kind: "custom",
    type: "single_select",
    options: [{ value: "a", label: "A 类" }, { value: "b", label: "B 类" }],
  },
  { key: "quota", label: "配额", kind: "custom", type: "number", validation: { min: 0, max: 100 } },
  { key: "signed_at", label: "签约日期", kind: "custom", type: "date", validation: { required: true } },
];

const FIELD_DEFS = makeFieldDefs(
  [
    { key: "name", label: "客户名称" },
    { key: "city", label: "城市" },
    { key: "contact_phone", label: "联系方式" },
    { key: "contract_expiry", label: "合同/到期时间" },
    { key: "sales_team_size", label: "业务员人数" },
    { key: "considering_switch", label: "是否考虑更换系统" },
  ],
  CUSTOM_TARGETS,
);

// 列顺序：0 名称 / 1 城市 / 2 电话 / 3 到期 / 4 人数 / 5 换系统 / 6 等级 / 7 配额 / 8 签约日期
const FULL_MAPPING: Record<string, string | null> = {
  "0": "name",
  "1": "city",
  "2": "contact_phone",
  "3": "contract_expiry",
  "4": "sales_team_size",
  "5": "considering_switch",
  "6": "vip_level",
  "7": "quota",
  "8": "signed_at",
};

function validate(cells: (string | number | boolean | null)[]) {
  return validateRowByMapping(FIELD_DEFS, FULL_MAPPING, cells);
}

describe("导入行校验（错误原因准确）", () => {
  it("合法行：值全部落位，数字字符串归一化，布尔 是/否 转布尔", () => {
    const result = validate([
      "  杭州某某科技有限公司 ",
      "杭州",
      "138-0013-8000",
      "2027-06-30",
      "35",
      "是",
      "a",
      "42",
      "2026-01-15",
    ]);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.payload.name).toBe("杭州某某科技有限公司");
    expect(result.normalized?.payload.contactPhone).toBe("138-0013-8000");
    expect(result.normalized?.payload.contractExpiry).toBe("2027-06-30");
    expect(result.normalized?.payload.salesTeamSize).toBe(35);
    expect(result.normalized?.payload.consideringSwitch).toBe(true);
    expect(result.normalized?.customValues).toEqual({
      vip_level: "a",
      quota: 42,
      signed_at: "2026-01-15",
    });
  });

  it("客户名称为空：报「客户名称：请输入客户名称」", () => {
    const result = validate(["  ", "杭州", null, null, null, null, null, null, "2026-01-15"]);
    expect(result.errors).toEqual([
      { key: "name", label: "客户名称", message: "请输入客户名称" },
    ]);
  });

  it("电话格式非法：报联系方式的格式原因", () => {
    const result = validate(["客户", "杭州", "电话见备注", null, null, null, null, null, "2026-01-15"]);
    expect(result.errors).toEqual([
      { key: "contact_phone", label: "联系方式", message: "联系方式仅支持数字及 + - ( ) 空格" },
    ]);
  });

  it("假日期 2026-02-30：报日历日期原因（不静默进位）", () => {
    const result = validate(["客户", "杭州", null, "2026-02-30", null, null, null, null, "2026-01-15"]);
    expect(result.errors).toEqual([
      { key: "contract_expiry", label: "合同/到期时间", message: "合同/到期时间不是有效的日历日期" },
    ]);
  });

  it("业务员人数非整数：报整数原因", () => {
    const result = validate(["客户", "杭州", null, null, "12.5", null, null, null, "2026-01-15"]);
    expect(result.errors).toEqual([
      { key: "sales_team_size", label: "业务员人数", message: "业务员人数须为整数" },
    ]);
  });

  it("布尔列填了无法识别的值：报中文原因", () => {
    const result = validate(["客户", "杭州", null, null, null, "也许", null, null, "2026-01-15"]);
    expect(result.errors).toEqual([
      { key: "considering_switch", label: "是否考虑更换系统", message: "仅支持填写 是 / 否" },
    ]);
  });

  it("多个错误一并给出，顺序按内置→自定义", () => {
    const result = validate(["", "杭州", "abc", "2026-13-01", "-3", "也许", "x", "999", ""]);
    const keys = result.errors.map((issue) => issue.key);
    expect(keys).toEqual([
      "name",
      "contact_phone",
      "contract_expiry",
      "sales_team_size",
      "considering_switch",
      "vip_level",
      "quota",
      "signed_at",
    ]);
    expect(result.normalized).toBeNull();
  });

  it("必填自定义日期缺失与非法选项/超范围数字按引擎文案报错", () => {
    const result = validate(["客户", "杭州", null, null, null, null, "z", "999", ""]);
    expect(result.errors).toEqual([
      { key: "vip_level", label: "客户等级", message: "不在可选范围内" },
      { key: "quota", label: "配额", message: "不能大于 100" },
      { key: "signed_at", label: "签约日期", message: "为必填项，不能留空" },
    ]);
  });

  it("数字单元格落到文本列自动转字符串（带前导零的电话不丢零）", () => {
    const result = validate(["客户", "杭州", 13800138000, null, null, null, null, null, "2026-01-15"]);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.payload.contactPhone).toBe("13800138000");
  });

  it("未映射的列（null 目标）不参与校验（该用例不含必填自定义字段）", () => {
    const noRequiredDefs = makeFieldDefs(
      [
        { key: "name", label: "客户名称" },
        { key: "city", label: "城市" },
        { key: "contact_phone", label: "联系方式" },
      ],
      [CUSTOM_TARGETS[0]!],
    );
    const sparse: Record<string, string | null> = { "0": "name", "1": null, "2": "contact_phone" };
    const result = validateRowByMapping(noRequiredDefs, sparse, ["客户", "乱填也不报", "13800138000"]);
    expect(result.errors).toEqual([]);
    expect(result.normalized?.payload.city).toBeUndefined();
  });
});
