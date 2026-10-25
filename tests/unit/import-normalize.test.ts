import { describe, expect, it } from "vitest";
import {
  coerceBooleanCell,
  isBlankCell,
  normalizeNameLike,
  normalizePhone,
} from "@/lib/import/normalize";

// M2 重复判定归一化规则 + 导入单元格矫正（T05 验收：重复检出——手机号精确
// 匹配须先去 +86/空格/横线；名称+城市疑似匹配须大小写/空白不敏感）。

describe("normalizePhone（M2 手机号标准化）", () => {
  it("去除空格、横线、括号后完全相同的号码视为相同", () => {
    expect(normalizePhone("138 0013 8000")).toBe("13800138000");
    expect(normalizePhone("138-0013-8000")).toBe("13800138000");
    expect(normalizePhone("(021) 6555 1234")).toBe("02165551234");
    expect(normalizePhone("021-6555-1234")).toBe("02165551234");
  });

  it("去 +86 / 86 / 0086 国家码前缀（剩余 11 位大陆手机号）", () => {
    expect(normalizePhone("+86 13800138000")).toBe("13800138000");
    expect(normalizePhone("8613800138000")).toBe("13800138000");
    expect(normalizePhone("008613800138000")).toBe("13800138000");
  });

  it("非大陆手机号形态保持归一化原样（不做删改）", () => {
    expect(normalizePhone("+1 555 010 9999")).toBe("15550109999");
    expect(normalizePhone("0571-8888-6666")).toBe("057188886666");
  });

  it("导入场景：+86 变体与裸号互为重复", () => {
    expect(normalizePhone("+8613800138000")).toBe(normalizePhone("13800138000"));
    expect(normalizePhone("138-0013-8000")).toBe(normalizePhone("13800138000"));
  });
});

describe("normalizeNameLike（名称/城市疑似匹配标准化）", () => {
  it("去首尾与内部多余空白、大小写不敏感", () => {
    expect(normalizeNameLike("  杭州某某   科技 有限公司 ")).toBe(
      "杭州某某 科技 有限公司",
    );
    expect(normalizeNameLike("ABC Tech")).toBe(normalizeNameLike("abc   tech"));
  });
});

describe("布尔单元格矫正", () => {
  it("常见是/否写法归一化为 boolean", () => {
    for (const word of ["是", "Y", "yes", "TRUE", "1", "有"]) {
      expect(coerceBooleanCell(word)).toBe(true);
    }
    for (const word of ["否", "N", "no", "False", "0", "无"]) {
      expect(coerceBooleanCell(word)).toBe(false);
    }
  });

  it("空值 → null；无法识别 → 原样交给 Schema 报准确错误", () => {
    expect(coerceBooleanCell("")).toBeNull();
    expect(coerceBooleanCell("   ")).toBeNull();
    expect(coerceBooleanCell(null)).toBeNull();
    expect(coerceBooleanCell("也许")).toBe("也许");
  });
});

describe("isBlankCell", () => {
  it("null / undefined / 纯空白为空，数字 0 非空", () => {
    expect(isBlankCell(null)).toBe(true);
    expect(isBlankCell(undefined)).toBe(true);
    expect(isBlankCell("  ")).toBe(true);
    expect(isBlankCell(0)).toBe(false);
    expect(isBlankCell("x")).toBe(false);
  });
});
