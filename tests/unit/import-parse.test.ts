import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  assertUploadLimits,
  parseImportFile,
  FileParseError,
} from "@/lib/import/parse";

// 解析层（T05）：XLSX/CSV → 表头 + 单元格矩阵。
// 关键行为：日期单元格转 YYYY-MM-DD、富文本拍平、CSV 前导零保留、
// GB18030 回退、行数/大小/类型白名单限制（M8）、结构性 CSV 错误整体拒绝。

async function buildXlsx(rows: (string | number | boolean | Date | null)[][]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) {
    sheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function csvBytes(text: string, encode: "utf8" | "utf8-bom" = "utf8"): Uint8Array {
  if (encode === "utf8-bom") {
    return new Uint8Array([...new TextEncoder().encode("\uFEFF" + text)]);
  }
  return new TextEncoder().encode(text);
}

describe("上传限制（M8）", () => {
  it("仅允许 .xlsx / .csv", () => {
    expect(() => assertUploadLimits("data.xls", 10)).toThrowError(FileParseError);
    expect(() => assertUploadLimits("data.txt", 10)).toThrowError(FileParseError);
    expect(() => assertUploadLimits("DATA.XLSX", 10)).not.toThrow();
    expect(() => assertUploadLimits("导入.CSV", 10)).not.toThrow();
  });

  it("超过 10MB 拒绝", () => {
    expect(() => assertUploadLimits("a.csv", 10 * 1024 * 1024 + 1)).toThrowError(
      FileParseError,
    );
    expect(() => assertUploadLimits("a.csv", 10 * 1024 * 1024)).not.toThrow();
  });
});

describe("XLSX 解析", () => {
  it("表头 + 数据行；日期单元格转 YYYY-MM-DD；空单元格为 null", async () => {
    const bytes = await buildXlsx([
      ["客户名称", "城市", "合同/到期时间"],
      ["客户A", "杭州", new Date(Date.UTC(2027, 5, 30))],
      ["客户B", null, null],
    ]);
    const parsed = await parseImportFile("a.xlsx", bytes);
    expect(parsed.headers).toEqual(["客户名称", "城市", "合同/到期时间"]);
    expect(parsed.rows).toEqual([
      ["客户A", "杭州", "2027-06-30"],
      ["客户B", null, null],
    ]);
  });

  it("非 ZIP 内容拒绝（invalid_xlsx）", async () => {
    await expect(
      parseImportFile("a.xlsx", new TextEncoder().encode("not a zip")),
    ).rejects.toMatchObject({ code: "invalid_xlsx" });
  });

  it("只有表头没有数据行 → empty_file", async () => {
    const bytes = await buildXlsx([["客户名称", "城市"]]);
    await expect(parseImportFile("a.xlsx", bytes)).rejects.toMatchObject({
      code: "empty_file",
    });
  });
});

describe("CSV 解析", () => {
  it("基本解析：逗号分隔、跳过空行、缺列补 null、超表头尾列忽略", async () => {
    const csv = "客户名称,城市,联系方式\n客户A,杭州,13800138000\n客户B\n\n";
    const parsed = await parseImportFile("a.csv", csvBytes(csv));
    expect(parsed.headers).toEqual(["客户名称", "城市", "联系方式"]);
    expect(parsed.rows).toEqual([
      ["客户A", "杭州", "13800138000"],
      ["客户B", null, null],
    ]);
  });

  it("电话前导零不被数字推断破坏", async () => {
    const csv = "客户名称,联系方式\n客户A,0013800138000\n";
    const parsed = await parseImportFile("a.csv", csvBytes(csv));
    expect(parsed.rows[0]![1]).toBe("0013800138000");
  });

  it("带引号与换行的单元格正确还原", async () => {
    const csv = '客户名称,备注\n"杭州,某某","第一行\n第二行"\n';
    const parsed = await parseImportFile("a.csv", csvBytes(csv));
    expect(parsed.rows[0]).toEqual(["杭州,某某", "第一行\n第二行"]);
  });

  it("UTF-8 BOM 被剥离，不污染首个表头", async () => {
    const parsed = await parseImportFile("a.csv", csvBytes("客户名称,城市\n客户A,杭州\n", "utf8-bom"));
    expect(parsed.headers[0]).toBe("客户名称");
  });

  it("无 BOM 的 GB18030 内容按 GB18030 解码（Excel 中文默认保存编码）", async () => {
    // "甲,乙\n甲,乙" 的 GB18030 字节（甲=0xBCD7 乙=0xD2D2）：非法 UTF-8 → 回退 GB18030
    const bytes = new Uint8Array([
      0xbc, 0xd7, 0x2c, 0xd2, 0xd2, 0x0a, 0xbc, 0xd7, 0x2c, 0xd2, 0xd2,
    ]);
    const parsed = await parseImportFile("a.csv", bytes);
    expect(parsed.headers).toEqual(["甲", "乙"]);
    expect(parsed.rows[0]).toEqual(["甲", "乙"]);
  });

  it("引号不匹配等结构性错误整体拒绝（invalid_csv）", async () => {
    const csv = '客户名称,城市\n"未闭合,杭州\n';
    await expect(parseImportFile("a.csv", csvBytes(csv))).rejects.toMatchObject({
      code: "invalid_csv",
    });
  });
});

describe("行数上限（M8：≤5000）", () => {
  it("超过 5000 数据行拒绝（row_limit）", async () => {
    const lines = ["客户名称,城市"];
    for (let i = 0; i < 5001; i += 1) {
      lines.push(`客户${i},杭州`);
    }
    await expect(
      parseImportFile("a.csv", csvBytes(lines.join("\n"))),
    ).rejects.toMatchObject({ code: "row_limit" });
  });

  it("恰好 5000 行通过", async () => {
    const lines = ["客户名称,城市"];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(`客户${i},杭州`);
    }
    const parsed = await parseImportFile("a.csv", csvBytes(lines.join("\n")));
    expect(parsed.rows).toHaveLength(5000);
  });
});
