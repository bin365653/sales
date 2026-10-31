// 导入模板生成（T05 交付物之一：templates/ 客户导入模板 + GET /api/imports/template）。
//
// 模板列 = 启用中的内置字段（BUILTIN_LEAD_FIELDS 顺序，name 恒在首位）+ 启用中的自定义字段；
// 动态生成的模板天然包含当前全部自定义字段，静态文件（scripts 生成入库）覆盖内置字段。
// 第二个工作表为逐列填写说明（必填/格式约束），与导入校验文案同源。

import ExcelJS from "exceljs";
import { buildCsvContent } from "@/lib/import/export-format";

export interface ImportTemplateField {
  key: string;
  label: string;
  hint: string;
  example: string;
}

const EXAMPLE_VALUES: Record<string, string> = {
  name: "杭州某某科技有限公司（示例行，导入前请删除）",
  city: "杭州",
  industry: "机械设备",
  contact_name: "张三",
  contact_title: "信息部经理",
  contact_phone: "13800138000",
  source: "展会获客",
  sales_team_size: "35",
  sales_mode: "直销+渠道",
  current_system: "某品牌ERP",
  contract_expiry: "2027-06-30",
  considering_switch: "是",
  has_clear_demand: "否",
  purchase_time: "2026年Q2",
  budget: "20-50万",
};

const BUILTIN_HINTS: Record<string, string> = {
  name: "必填；不超过 128 字",
  contact_phone: "数字及 + - ( ) 空格；与已有客户手机号相同会提示重复",
  sales_team_size: "不小于 1 的整数",
  contract_expiry: "日期格式 YYYY-MM-DD",
  considering_switch: "填 是 或 否，可留空",
  has_clear_demand: "填 是 或 否，可留空",
};

function customHint(
  def: { validation?: unknown; options?: unknown },
): string {
  const rules =
    typeof def.validation === "object" && def.validation !== null
      ? (def.validation as Record<string, unknown>)
      : {};
  const parts: string[] = [];
  if (rules.required === true) {
    parts.push("必填");
  }
  if (Array.isArray(def.options)) {
    const values = def.options
      .map((option) =>
        typeof option === "object" && option !== null && "value" in option
          ? String((option as { value: unknown }).value)
          : "",
      )
      .filter(Boolean);
    if (values.length > 0) {
      parts.push(`可选值：${values.join(" / ")}`);
    }
  }
  return parts.join("；");
}

/**
 * 组装模板列与填写说明。
 * @param activeBuiltin 启用中的内置字段（key=物理列名）
 * @param activeCustom  启用中的自定义字段（按 sortOrder 排序后传入）
 * @param dictValues    字典启用字段 → 启用值列表（V2.0-T02：填写说明给出可选值）
 */
export function buildImportTemplateFields(
  activeBuiltin: { key: string; label: string }[],
  activeCustom: {
    key: string;
    label: string;
    type: "text" | "number" | "date" | "single_select";
    options?: unknown;
    validation?: unknown;
  }[],
  dictValues?: Map<string, string[]>,
): ImportTemplateField[] {
  const builtinByKey = new Map(activeBuiltin.map((field) => [field.key, field]));
  const fields: ImportTemplateField[] = [];
  // name 恒为第一列（必填锚点），其余按 BUILTIN_LEAD_FIELDS 固定顺序
  const orderedKeys = [
    "name",
    ...activeBuiltin.map((f) => f.key).filter((key) => key !== "name"),
  ];
  for (const key of orderedKeys) {
    const def = builtinByKey.get(key);
    if (!def) {
      continue;
    }
    const dictHint = dictValues?.get(key);
    const hint = dictHint?.length
      ? `须从字典选择；可选值：${dictHint.join(" / ")}`
      : (BUILTIN_HINTS[key] ?? "可留空");
    fields.push({
      key,
      label: def.label,
      hint,
      example: EXAMPLE_VALUES[key] ?? "",
    });
  }
  for (const def of activeCustom) {
    const typeHint =
      def.type === "date"
        ? "日期格式 YYYY-MM-DD"
        : def.type === "number"
          ? "数字"
          : "";
    const hint = [customHint(def), typeHint].filter(Boolean).join("；") || "可留空";
    fields.push({ key: def.key, label: def.label, hint, example: "" });
  }
  return fields;
}

/** XLSX 模板：第一工作表为列头 + 示例行，第二工作表为填写说明 */
export async function buildImportTemplateXlsx(
  fields: ImportTemplateField[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客户导入");
  sheet.addRow(fields.map((field) => field.label));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.addRow(fields.map((field) => field.example));

  const guide = workbook.addWorksheet("填写说明");
  guide.addRow(["列名", "填写说明"]);
  guide.getRow(1).font = { bold: true };
  for (const field of fields) {
    guide.addRow([field.label, field.hint]);
  }
  guide.getColumn(1).width = 24;
  guide.getColumn(2).width = 48;

  sheet.columns.forEach((column, index) => {
    column.width = Math.max(12, Math.min(28, (fields[index]?.label.length ?? 8) + 6));
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** CSV 模板（UTF-8 BOM） */
export function buildImportTemplateCsv(
  fields: ImportTemplateField[],
): string {
  return buildCsvContent(
    fields.map((field) => field.label),
    [fields.map((field) => field.example)],
  );
}
