// 导出格式化（T05，验收项：导出范围正确且公式转义）。
//
// - 公式注入转义（R6）：以 = + - @ 或制表符/回车开头的文本单元格加 "'" 前缀，
//   XLSX 与 CSV 同一规则（ExcelJS 对 "=" 开头的字符串会按公式写入，必须先转义）；
// - 值格式化：布尔 → 是/否；优先级/核实状态 → 中文文案；纯日期列按 UTC 日期、
//   时间戳按 Asia/Shanghai（决策 C13，复用 lib/format）；
// - 自定义字段列只导出"导出结果中至少有一个值"的字段（含已停用但有值的字段，
//   与详情页展示口径一致，保证数据可迁移不丢失）。

import ExcelJS from "exceljs";
import Papa from "papaparse";
import { BUILTIN_LEAD_FIELDS } from "@/lib/lead-fields";
import {
  formatFactStatus,
  formatPriority,
  toShanghaiDateTimeString,
  toUtcDateString,
} from "@/lib/format";
import type { CellPrimitive } from "@/lib/import/parse";

/** 公式注入转义：恶意单元格（=cmd|... / +1... / -2... / @SUM...）不再被 Excel 当公式执行 */
export function escapeFormulaCell(value: string): string {
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function booleanText(value: boolean | null | undefined): string {
  if (value === true) {
    return "是";
  }
  if (value === false) {
    return "否";
  }
  return "";
}

/** 导出一行的来源数据（Prisma Lead 满足该结构类型；lib 层不依赖 Prisma） */
export interface ExportLeadRow {
  name: string;
  city: string | null;
  industry: string | null;
  mainCategory: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactPhone: string | null;
  source: string | null;
  salesTeamSize: number | null;
  revenueRange: string | null;
  salesMode: string | null;
  currentSystem: string | null;
  systemModules: string | null;
  contractExpiry: Date | null;
  knownPains: string | null;
  consideringSwitch: boolean | null;
  hasClearDemand: boolean | null;
  purchaseTime: string | null;
  budget: string | null;
  decisionMaker: string | null;
  decisionProcess: string | null;
  mainConcerns: string | null;
  remark: string | null;
  currentSystemStatus: string;
  contractExpiryStatus: string;
  purchaseTimeStatus: string;
  decisionMakerStatus: string;
  priority: string;
  lastContactAt: Date | null;
  nextContactAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExportLeadContext {
  stageName: string;
  ownerName: string;
  customValues: Record<string, unknown> | null;
}

const MANAGEMENT_COLUMNS: ReadonlyArray<{
  key: string;
  label: string;
  read: (row: ExportLeadRow, ctx: ExportLeadContext) => CellPrimitive;
}> = [
  { key: "stage", label: "客户阶段", read: (_r, c) => c.stageName },
  { key: "priority", label: "优先级", read: (r) => formatPriority(r.priority) },
  { key: "owner", label: "负责人", read: (_r, c) => c.ownerName },
  { key: "current_system_status", label: "当前使用系统核实状态", read: (r) => formatFactStatus(r.currentSystemStatus) },
  { key: "contract_expiry_status", label: "合同到期核实状态", read: (r) => formatFactStatus(r.contractExpiryStatus) },
  { key: "purchase_time_status", label: "采购时间核实状态", read: (r) => formatFactStatus(r.purchaseTimeStatus) },
  { key: "decision_maker_status", label: "决策人核实状态", read: (r) => formatFactStatus(r.decisionMakerStatus) },
  { key: "last_contact_at", label: "最近联系时间", read: (r) => (r.lastContactAt ? toShanghaiDateTimeString(r.lastContactAt) : "") },
  { key: "next_contact_at", label: "下次联系时间", read: (r) => (r.nextContactAt ? toShanghaiDateTimeString(r.nextContactAt) : "") },
  { key: "created_at", label: "创建时间", read: (r) => toShanghaiDateTimeString(r.createdAt) },
  { key: "updated_at", label: "更新时间", read: (r) => toShanghaiDateTimeString(r.updatedAt) },
];

function builtinCellValue(row: ExportLeadRow, key: string): CellPrimitive {
  switch (key) {
    case "name": return row.name;
    case "city": return row.city ?? "";
    case "industry": return row.industry ?? "";
    case "main_category": return row.mainCategory ?? "";
    case "contact_name": return row.contactName ?? "";
    case "contact_title": return row.contactTitle ?? "";
    case "contact_phone": return row.contactPhone ?? "";
    case "source": return row.source ?? "";
    case "sales_team_size": return row.salesTeamSize ?? "";
    case "revenue_range": return row.revenueRange ?? "";
    case "sales_mode": return row.salesMode ?? "";
    case "current_system": return row.currentSystem ?? "";
    case "system_modules": return row.systemModules ?? "";
    case "contract_expiry": return row.contractExpiry ? toUtcDateString(row.contractExpiry) : "";
    case "known_pains": return row.knownPains ?? "";
    case "considering_switch": return booleanText(row.consideringSwitch);
    case "has_clear_demand": return booleanText(row.hasClearDemand);
    case "purchase_time": return row.purchaseTime ?? "";
    case "budget": return row.budget ?? "";
    case "decision_maker": return row.decisionMaker ?? "";
    case "decision_process": return row.decisionProcess ?? "";
    case "main_concerns": return row.mainConcerns ?? "";
    case "remark": return row.remark ?? "";
    default: return "";
  }
}

/** 生成导出表（表头 + 已转义/格式化的单元格矩阵）；customDefs 含启用与停用字段 */
export function buildLeadExportTable(
  rows: { lead: ExportLeadRow; ctx: ExportLeadContext }[],
  customDefs: { key: string; label: string }[],
): { headers: string[]; cells: CellPrimitive[][] } {
  const usedCustomKeys = customDefs.filter((def) =>
    rows.some(({ ctx }) => {
      const value = ctx.customValues?.[def.key];
      return value !== undefined && value !== null && value !== "";
    }),
  );

  const headers = [
    ...BUILTIN_LEAD_FIELDS.map((field) => field.label),
    ...usedCustomKeys.map((def) => def.label),
    ...MANAGEMENT_COLUMNS.map((column) => column.label),
  ];

  const cells = rows.map(({ lead, ctx }) => {
    const builtin = BUILTIN_LEAD_FIELDS.map((field) => builtinCellValue(lead, field.key));
    const custom = usedCustomKeys.map((def) => {
      const value = ctx.customValues?.[def.key];
      if (typeof value === "number") {
        return value;
      }
      return typeof value === "string" ? value : "";
    });
    const management = MANAGEMENT_COLUMNS.map((column) => column.read(lead, ctx));
    return [...builtin, ...custom, ...management].map((cell) =>
      typeof cell === "string" ? escapeFormulaCell(cell) : cell,
    );
  });

  return { headers, cells };
}

/** CSV 文本（含 UTF-8 BOM 防中文乱码）；单元格已在上层转义 */
export function buildCsvContent(headers: string[], cells: CellPrimitive[][]): string {
  const text = Papa.unparse({
    fields: headers,
    data: cells.map((row) => row.map((cell) => (cell === null ? "" : String(cell)))),
  });
  return `\uFEFF${text}`;
}

/** XLSX 工作簿字节 */
export async function buildXlsxContent(
  headers: string[],
  cells: CellPrimitive[][],
  sheetName: string,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of cells) {
    sheet.addRow(row.map((cell) => (cell === null ? "" : cell)));
  }
  headers.forEach((_header, index) => {
    sheet.getColumn(index + 1).width = 16;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
