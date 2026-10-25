// 生成静态导入模板文件（T05 交付物：templates/客户导入模板.xlsx 与 .csv）。
//
// 静态模板覆盖全部内置字段（与 seed 的字段定义同源：BUILTIN_LEAD_FIELDS）；
// 运行期的自定义字段列由 GET /api/imports/template 动态生成（始终最新）。
// 用法：npm run templates:generate（字段定义变化后重新执行并提交）。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_LEAD_FIELDS } from "../src/lib/lead-fields";
import {
  buildImportTemplateCsv,
  buildImportTemplateFields,
  buildImportTemplateXlsx,
} from "../src/lib/import/template";

async function main(): Promise<void> {
  // 静态模板 = 全部内置字段（假设均启用；自定义字段走动态端点）
  const fields = buildImportTemplateFields(
    BUILTIN_LEAD_FIELDS.map((field) => ({ key: field.key, label: field.label })),
    [],
  );
  const outDir = join(process.cwd(), "templates");
  mkdirSync(outDir, { recursive: true });

  const xlsx = await buildImportTemplateXlsx(fields);
  writeFileSync(join(outDir, "客户导入模板.xlsx"), xlsx);

  const csv = buildImportTemplateCsv(fields);
  writeFileSync(join(outDir, "客户导入模板.csv"), csv, "utf8");

  console.log(
    `[templates] 已生成 ${fields.length} 列模板：templates/客户导入模板.xlsx 与 .csv`,
  );
}

void main();
