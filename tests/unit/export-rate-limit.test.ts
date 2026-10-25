import { describe, expect, it } from "vitest";
import { createExportRateLimiter } from "@/server/services/exports";
import { buildImportTemplateFields } from "@/lib/import/template";

// 导出限流（§8.1：5 次/小时/用户）+ 模板列组装规则（T05）。

describe("createExportRateLimiter", () => {
  it("窗口内第 6 次被拒绝；窗口滑动后恢复", () => {
    let now = 1_000_000;
    const limiter = createExportRateLimiter({ now: () => now });
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.record("user-a")).toBe(true);
    }
    expect(limiter.record("user-a")).toBe(false);
    // 其他用户不受影响
    expect(limiter.record("user-b")).toBe(true);
    // 前进 61 分钟：最早一次滑出窗口
    now += 61 * 60 * 1000;
    expect(limiter.record("user-a")).toBe(true);
  });

  it("按用户隔离", () => {
    const limiter = createExportRateLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.record("u1")).toBe(true);
    }
    expect(limiter.record("u1")).toBe(false);
    expect(limiter.record("u2")).toBe(true);
  });
});

describe("buildImportTemplateFields", () => {
  const builtin = [
    { key: "name", label: "客户名称" },
    { key: "city", label: "城市" },
    { key: "contact_phone", label: "联系方式" },
    { key: "contract_expiry", label: "合同/到期时间" },
    { key: "considering_switch", label: "是否考虑更换系统" },
  ];

  it("name 恒为第一列；内置列附带格式提示；自定义列附带类型/必填/可选值提示", () => {
    const fields = buildImportTemplateFields(builtin, [
      {
        key: "vip_level",
        label: "客户等级",
        type: "single_select",
        options: [{ value: "a", label: "A 类" }, { value: "b", label: "B 类" }],
      },
      { key: "quota", label: "配额", type: "number", validation: { required: true, min: 0 } },
      { key: "signed_at", label: "签约日期", type: "date" },
    ]);
    expect(fields.map((field) => field.key)).toEqual([
      "name",
      "city",
      "contact_phone",
      "contract_expiry",
      "considering_switch",
      "vip_level",
      "quota",
      "signed_at",
    ]);
    expect(fields[0]!.hint).toContain("必填");
    expect(fields[3]!.hint).toContain("YYYY-MM-DD");
    expect(fields[4]!.hint).toContain("是 或 否");
    expect(fields[5]!.hint).toContain("a / b");
    expect(fields[6]!.hint).toContain("必填");
    expect(fields[7]!.hint).toContain("YYYY-MM-DD");
    // 示例行：name 提供示例值（提醒删除），无示例的字段留空
    expect(fields[0]!.example).toContain("示例");
    expect(fields[1]!.example).toBe("杭州");
    expect(fields[5]!.example).toBe("");
  });
});
