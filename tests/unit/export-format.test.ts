import { describe, expect, it } from "vitest";
import {
  buildCsvContent,
  buildLeadExportTable,
  escapeFormulaCell,
  type ExportLeadRow,
} from "@/lib/import/export-format";

// T05 验收项「导出公式转义」：= + - @ 与制表符开头的单元格加 ' 前缀，
// XLSX 与 CSV 同一规则；CSV 输出带 UTF-8 BOM（防中文乱码）。

describe("escapeFormulaCell（CSV 公式注入转义）", () => {
  it("= + - @ 开头的文本加 ' 前缀", () => {
    expect(escapeFormulaCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(escapeFormulaCell("+cmd|'/C calc'!A0")).toBe("'+cmd|'/C calc'!A0");
    expect(escapeFormulaCell("-2+1|cmd")).toBe("'-2+1|cmd");
    expect(escapeFormulaCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("制表符/回车开头同样转义（分隔符注入）", () => {
    expect(escapeFormulaCell("\t=1+1")).toBe("'\t=1+1");
    expect(escapeFormulaCell("\r=1+1")).toBe("'\r=1+1");
  });

  it("普通文本、负号在中间、纯数字不动", () => {
    expect(escapeFormulaCell("杭州客户")).toBe("杭州客户");
    expect(escapeFormulaCell("价格-面议")).toBe("价格-面议");
    expect(escapeFormulaCell("13800138000")).toBe("13800138000");
    expect(escapeFormulaCell("")).toBe("");
  });
});

const baseRow: ExportLeadRow = {
  name: "正常客户A",
  city: "杭州",
  industry: null,
  mainCategory: null,
  contactName: null,
  contactTitle: null,
  contactPhone: "13800138000",
  source: null,
  salesTeamSize: null,
  revenueRange: null,
  salesMode: null,
  currentSystem: null,
  systemModules: null,
  contractExpiry: null,
  knownPains: null,
  consideringSwitch: true,
  hasClearDemand: null,
  purchaseTime: null,
  budget: null,
  decisionMaker: null,
  decisionProcess: null,
  mainConcerns: null,
  remark: null,
  currentSystemStatus: "unknown",
  contractExpiryStatus: "confirmed",
  purchaseTimeStatus: "unknown",
  decisionMakerStatus: "unknown",
  priority: "high",
  lastContactAt: null,
  nextContactAt: null,
  createdAt: new Date("2026-10-25T02:00:00Z"),
  updatedAt: new Date("2026-10-25T02:00:00Z"),
};

describe("buildLeadExportTable", () => {
  it("布尔转 是/否、优先级/核实状态转中文、公式单元格转义", () => {
    const evil: ExportLeadRow = {
      ...baseRow,
      name: "=HYPERLINK(\"http://evil\",\"点我\")",
      city: "+86城市",
    };
    const table = buildLeadExportTable(
      [
        { lead: baseRow, ctx: { stageName: "新线索", ownerName: "张三", customValues: null } },
        { lead: evil, ctx: { stageName: "新线索", ownerName: "张三", customValues: null } },
      ],
      [],
    );
    const nameIdx = table.headers.indexOf("客户名称");
    const cityIdx = table.headers.indexOf("城市");
    expect(table.cells[0]![nameIdx]).toBe("正常客户A");
    expect(table.cells[1]![nameIdx]).toBe("'=HYPERLINK(\"http://evil\",\"点我\")");
    expect(table.cells[1]![cityIdx]).toBe("'+86城市");

    const boolIdx = table.headers.indexOf("是否考虑更换系统");
    expect(table.cells[0]![boolIdx]).toBe("是");
    expect(table.cells[0]![table.headers.indexOf("是否有明确需求")]).toBe("");

    const priorityIdx = table.headers.indexOf("优先级");
    expect(table.cells[0]![priorityIdx]).toBe("高");
    const statusIdx = table.headers.indexOf("合同到期核实状态");
    expect(table.cells[0]![statusIdx]).toBe("已确认");
    const stageIdx = table.headers.indexOf("客户阶段");
    expect(table.cells[0]![stageIdx]).toBe("新线索");
    const ownerIdx = table.headers.indexOf("负责人");
    expect(table.cells[0]![ownerIdx]).toBe("张三");
  });

  it("自定义字段仅当导出结果中存在值时成列（含停用字段），值按类型输出", () => {
    const table = buildLeadExportTable(
      [
        {
          lead: baseRow,
          ctx: { stageName: "新线索", ownerName: "张三", customValues: { vip_level: "重要", quota: 42 } },
        },
        {
          lead: baseRow,
          ctx: { stageName: "新线索", ownerName: "李四", customValues: null },
        },
      ],
      [
        { key: "vip_level", label: "客户等级" },
        { key: "quota", label: "配额" },
        { key: "unused", label: "无值字段" },
      ],
    );
    expect(table.headers).toContain("客户等级");
    expect(table.headers).toContain("配额");
    expect(table.headers).not.toContain("无值字段");
    const vipIdx = table.headers.indexOf("客户等级");
    expect(table.cells[0]![vipIdx]).toBe("重要");
    expect(table.cells[1]![vipIdx]).toBe("");
    const quotaIdx = table.headers.indexOf("配额");
    expect(table.cells[0]![quotaIdx]).toBe(42);
  });

  it("表头顺序：内置列（V2 起含 20 个画像扩展字段）→ 自定义 → 管理列", () => {
    const table = buildLeadExportTable([], []);
    expect(table.headers[0]).toBe("客户名称");
    expect(table.headers).toContain("备注");
    expect(table.headers).toContain("是否新一代手机开单");
    expect(table.headers).toContain("是否愿意沟通了解勤策");
    expect(table.headers).toContain("软件到期时间");
    expect(table.headers.at(-1)).toBe("更新时间");
    for (const label of ["客户阶段", "优先级", "负责人", "最近联系时间", "创建时间"]) {
      expect(table.headers).toContain(label);
    }
  });
});

describe("buildCsvContent", () => {
  it("带 UTF-8 BOM；含逗号/引号/换行的单元格正确加引号转义", () => {
    const csv = buildCsvContent(
      ["客户名称", "备注"],
      [["杭州,某某", '他说"你好"\n第二行'], ["正常", null]],
    );
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain('"杭州,某某"');
    expect(csv).toContain('"他说""你好""\n第二行"');
  });
});
