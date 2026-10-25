// 导入文件解析（T05，实施计划 §2.1 ExcelJS + PapaParse；限制 M8：≤10MB / ≤5000 行）。
//
// 解析层职责（不含业务校验——那属于映射阶段，错误原因才能按字段给准）：
// - XLSX：ZIP 魔数校验 + 第一个工作表；富文本/公式/超链接单元格拍平为文本；
//   日期单元格转为 "YYYY-MM-DD"（ExcelJS 按.UTC 读出序列日期）；
// - CSV：UTF-8 BOM 优先，无 BOM 时严格 UTF-8 解码失败回退 GB18030（Excel 中文默认编码）；
//   关闭动态类型推断（避免 "0013" 这类带前导零的号码被转成数字）；
// - 输出统一为 headers + 单元格矩阵（string | number | boolean | null），
//   空白行剔除、超表头的尾列忽略、缺单元格补 null。

import ExcelJS from "exceljs";
import Papa from "papaparse";

export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

/** 解析后的统一结构：headers[i] 对应 rows[r][i] */
export interface ParsedSheet {
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

export type CellPrimitive = string | number | boolean | null;

export class FileParseError extends Error {
  constructor(
    readonly code:
      | "unsupported_type"
      | "file_too_large"
      | "row_limit"
      | "invalid_xlsx"
      | "invalid_csv"
      | "empty_file",
    message: string,
  ) {
    super(message);
    this.name = "FileParseError";
  }
}

/** 校验上传限制（扩展名白名单 + 大小），在解析前调用 */
export function assertUploadLimits(
  filename: string,
  sizeBytes: number,
): void {
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".xlsx") && !lower.endsWith(".csv")) {
    throw new FileParseError(
      "unsupported_type",
      "仅支持 .xlsx 或 .csv 文件",
    );
  }
  if (sizeBytes > IMPORT_MAX_FILE_BYTES) {
    throw new FileParseError(
      "file_too_large",
      "文件不能超过 10MB",
    );
  }
}

/** ExcelJS 单元格值 → 基础类型（富文本拼接 / 公式取结果 / 超链接取文本 / 日期转 YYYY-MM-DD） */
function cellToPrimitive(value: unknown): CellPrimitive {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return value as string | number | boolean;
  }
  if (type === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText)) {
      return (obj.richText as { text?: unknown }[])
        .map((part) =>
          typeof part.text === "string" ? part.text : "",
        )
        .join("");
    }
    if ("result" in obj) {
      return cellToPrimitive(obj.result);
    }
    if ("text" in obj) {
      return cellToPrimitive(obj.text);
    }
    if ("error" in obj) {
      // 单元格为 Excel 错误值（#N/A 等）：原样保留，交给字段校验给出准确错误
      return String(obj.error);
    }
    return String(value);
  }
  return String(value);
}

function isFullyEmpty(cells: CellPrimitive[]): boolean {
  return cells.every((cell) => cell === null || (typeof cell === "string" && cell.trim() === ""));
}

/** 将一行单元格裁剪/补齐到表头宽度（超表头尾列忽略，缺单元格补 null） */
function alignRow(row: CellPrimitive[], headerCount: number): CellPrimitive[] {
  const aligned: CellPrimitive[] = [];
  for (let c = 0; c < headerCount; c += 1) {
    aligned.push(row[c] ?? null);
  }
  return aligned;
}

async function parseXlsx(bytes: Uint8Array): Promise<ParsedSheet> {
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new FileParseError("invalid_xlsx", "文件不是有效的 XLSX 格式");
  }
  let workbook: ExcelJS.Workbook;
  try {
    // exceljs 的 d.ts 自声明全局 Buffer（extends ArrayBuffer）与 Node Buffer
    // 类型不兼容，但运行时 load 直通 JSZip（接受 Uint8Array），按其入参类型断言。
    workbook = await new ExcelJS.Workbook().xlsx.load(
      bytes as unknown as Parameters<ExcelJS.Workbook["xlsx"]["load"]>[0],
    );
  } catch {
    throw new FileParseError("invalid_xlsx", "文件不是有效的 XLSX 格式");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new FileParseError("empty_file", "文件中没有工作表");
  }
  // eachRow 拿到的是 row.values（1 起始稀疏数组）→ 统一转 0 起始密集数组
  const rawRows: CellPrimitive[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values = Array.isArray(row.values) ? row.values : [];
    const dense: CellPrimitive[] = [];
    for (let i = 1; i < values.length; i += 1) {
      dense.push(cellToPrimitive(values[i]));
    }
    rawRows.push(dense);
  });
  return buildSheetFromMatrix(rawRows);
}

function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 无 BOM 且非合法 UTF-8：按 GB18030（Excel 中文默认保存编码）解读；
    // 极端环境缺 ICU 中文编码表时退回无损替换的 UTF-8（保可用性）
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

function parseCsv(bytes: Uint8Array): ParsedSheet {
  const text = decodeCsvBytes(bytes);
  const result = Papa.parse<string[]>(text, {
    skipEmptyLines: "greedy",
  });
  // 引号不闭合等结构性错误：整文件拒绝，避免静默错列；
  // 分隔符自动探测失败（单列文件）不算错误，Papa 自动回退逗号
  const fatal = (result.errors ?? []).some((error) => error.code === "MissingQuotes");
  if (fatal) {
    throw new FileParseError("invalid_csv", "CSV 文件格式不合法（引号或分隔符异常）");
  }
  const rawRows = (result.data as unknown[][]).map((cells) =>
    cells.map((cell) => {
      if (cell === null || cell === undefined) {
        return null;
      }
      const type = typeof cell;
      if (type === "string" || type === "number" || type === "boolean") {
        return cell as CellPrimitive;
      }
      return String(cell);
    }),
  );
  return buildSheetFromMatrix(rawRows);
}

/** 行列矩阵 → 表头 + 数据行（表头取首个非全空行；行数上限在此统一执行） */
function buildSheetFromMatrix(rawRows: CellPrimitive[][]): ParsedSheet {
  const headerRowIndex = rawRows.findIndex((row) => !isFullyEmpty(row));
  const headerCells = headerRowIndex >= 0 ? rawRows[headerRowIndex] : undefined;
  if (!headerCells || headerRowIndex === rawRows.length - 1) {
    throw new FileParseError("empty_file", "文件没有可导入的数据行");
  }
  // 表头宽度 = 最后一个非空表头单元格；全空表头列保留占位名，仍可手动映射
  let lastHeaderCol = -1;
  for (let c = 0; c < headerCells.length; c += 1) {
    if (headerCells[c] !== null) {
      lastHeaderCol = c;
    }
  }
  if (lastHeaderCol === -1) {
    throw new FileParseError("empty_file", "文件缺少表头行");
  }
  const headers: string[] = [];
  for (let c = 0; c <= lastHeaderCol; c += 1) {
    const cell = headerCells[c] ?? null;
    const name = typeof cell === "string" && cell.trim() !== "" ? cell.trim() : `未命名列${c + 1}`;
    headers.push(name);
  }

  const rows: CellPrimitive[][] = [];
  for (let r = headerRowIndex + 1; r < rawRows.length; r += 1) {
    const source = rawRows[r];
    if (!source || isFullyEmpty(source)) {
      continue;
    }
    rows.push(alignRow(source, headers.length));
  }
  if (rows.length === 0) {
    throw new FileParseError("empty_file", "文件没有可导入的数据行");
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    throw new FileParseError(
      "row_limit",
      `数据行数 ${rows.length} 超过单次导入上限 ${IMPORT_MAX_ROWS} 行`,
    );
  }
  return { headers, rows };
}

/** 按文件名分流解析（限制校验须先经 assertUploadLimits） */
export async function parseImportFile(
  filename: string,
  bytes: Uint8Array,
): Promise<ParsedSheet> {
  return filename.toLowerCase().endsWith(".csv") ? parseCsv(bytes) : parseXlsx(bytes);
}
