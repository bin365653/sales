import { describe, expect, it } from "vitest";
import { ApiError } from "@/server/http/api";
import { assertMappingValid } from "@/server/services/imports";
import { importConfirmSchema, importMappingSchema, leadsExportCreateSchema } from "@/lib/schemas/import";
import { leadListQuerySchema } from "@/lib/schemas/lead";

// 映射合法性规则 + 导入/导出入参 Schema（T05）。

interface Target {
  key: string;
  label: string;
  kind: "builtin" | "custom";
  type?: "text" | "number" | "date" | "single_select";
}

function fieldDefsOf(builtinKeys: string[], custom: Target[] = [], requiredCustomKeys: string[] = []) {
  const targets: Target[] = [
    ...builtinKeys.map((key) => ({ key, label: `${key}标签`, kind: "builtin" as const })),
    ...custom,
  ];
  return {
    targets,
    targetByKey: new Map(targets.map((target) => [target.key, target])),
    activeCustomDefs: custom.map((target) => ({
      key: target.key,
      type: target.type ?? "text",
      validation: requiredCustomKeys.includes(target.key) ? { required: true } : undefined,
    })),
  };
}

const HEADERS = ["客户名称", "城市", "联系方式"];

function expectApiError(fn: () => void, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("assertMappingValid", () => {
  const defs = fieldDefsOf(["name", "city", "contact_phone"]);

  it("合法映射通过（含不导入列）", () => {
    expect(() =>
      assertMappingValid(HEADERS, { "0": "name", "1": "city", "2": null }, defs),
    ).not.toThrow();
  });

  it("未映射客户名称 → mapping_invalid", () => {
    expectApiError(
      () => assertMappingValid(HEADERS, { "0": "city", "1": null }, defs),
      "mapping_invalid",
    );
  });

  it("两个文件列映射同一目标 → mapping_invalid", () => {
    expectApiError(
      () =>
        assertMappingValid(HEADERS, { "0": "name", "1": "name", "2": null }, defs),
      "mapping_invalid",
    );
  });

  it("目标不存在或已停用 → mapping_invalid", () => {
    expectApiError(
      () =>
        assertMappingValid(HEADERS, { "0": "name", "1": "no_such_field" }, defs),
      "mapping_invalid",
    );
  });

  it("列下标越界 → mapping_invalid", () => {
    expectApiError(
      () => assertMappingValid(HEADERS, { "0": "name", "99": "city" }, defs),
      "mapping_invalid",
    );
  });

  it("必填自定义字段未映射 → mapping_invalid（在映射阶段拦截而非逐行报错）", () => {
    const withRequiredCustom = fieldDefsOf(
      ["name", "city"],
      [{ key: "signed_at", label: "签约日期", kind: "custom", type: "date" }],
      ["signed_at"],
    );
    expectApiError(
      () =>
        assertMappingValid(HEADERS, { "0": "name", "1": "city" }, withRequiredCustom),
      "mapping_invalid",
    );
    expect(() =>
      assertMappingValid(
        HEADERS,
        { "0": "name", "1": "city", "2": "signed_at" },
        withRequiredCustom,
      ),
    ).not.toThrow();
  });
});

describe("导入/导出入参 Schema", () => {
  it("importMappingSchema：列下标字符串键，值为目标或 null", () => {
    const parsed = importMappingSchema.parse({ mapping: { "0": "name", "1": null } });
    expect(parsed.mapping).toEqual({ "0": "name", "1": null });
  });

  it("importConfirmSchema：决定仅允许 skip / create_new", () => {
    expect(importConfirmSchema.safeParse({}).success).toBe(true);
    expect(
      importConfirmSchema.safeParse({
        decisions: [{ rowId: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8fc", decision: "create_new" }],
      }).success,
    ).toBe(true);
    expect(
      importConfirmSchema.safeParse({
        decisions: [{ rowId: "not-uuid", decision: "skip" }],
      }).success,
    ).toBe(false);
    expect(
      importConfirmSchema.safeParse({
        decisions: [{ rowId: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8fc", decision: "overwrite" }],
      }).success,
    ).toBe(false);
  });

  it("leadsExportCreateSchema：format 必填 xlsx/csv；filters 复用列表 Schema（含默认值）", () => {
    const parsed = leadsExportCreateSchema.parse({ format: "csv" });
    expect(parsed.filters).toBeUndefined();
    const withFilters = leadsExportCreateSchema.parse({
      format: "xlsx",
      filters: { city: "武汉", keyword: "科技" },
    });
    expect(withFilters.filters).toMatchObject({ city: "武汉", keyword: "科技", page: 1 });
    expect(leadsExportCreateSchema.safeParse({ format: "pdf" }).success).toBe(false);
    expect(leadListQuerySchema.parse({}).page).toBe(1);
  });
});
