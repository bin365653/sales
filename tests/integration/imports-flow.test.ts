import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  cleanupTestUsers,
  createTestFieldDef,
  createTestUser,
  type TestUser,
} from "./helpers";
import { createLead } from "@/server/services/leads";
import {
  confirmImport,
  getImportPreview,
  saveImportMapping,
  uploadImport,
} from "@/server/services/imports";

// T05 导入全流程（固定样例文件，验收项：错误行原因准确、重复检出
// （手机号精确 + 名称城市疑似）、确认前不入库）。
// 样例行固定为 8 行：2 有效 / 3 错误（电话、假日期、名称为空）/
// 3 重复（库内手机号精确、库内名称+城市疑似、文件内重复）。

afterAll(cleanupTestUsers);

const HEADERS = [
  "客户名称",
  "城市",
  "联系方式",
  "合同/到期时间",
  "业务员人数",
  "是否考虑更换系统",
];

const SAMPLE_ROWS: (string | number | null)[][] = [
  ["武汉光谷科技有限公司", "武汉", "13900000001", "2027-01-31", 25, "是"], // 1 有效
  ["上海临港智能制造", "上海", "021-6555-1234", "", 18, "否"], // 2 有效
  ["深圳南山贸易", "深圳", "电话见面谈", "", "", ""], // 3 错误：电话
  ["苏州园区精密", "苏州", "13900000004", "2026-02-30", "", ""], // 4 错误：假日期
  ["", "北京", "13900000005", "", "", ""], // 5 错误：名称为空
  ["杭州滨江新客户", "杭州", "+86 138 0013 8000", "", "", ""], // 6 精确重复（库内 A）
  ["既有客户乙", "上海", "", "", "", ""], // 7 疑似重复（库内 B，名称+城市）
  ["文件内重复客户", "广州", "13900000001", "", "", ""], // 8 文件内重复（与第 1 行电话相同）
];

async function buildSampleXlsx(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("客户");
  sheet.addRow(HEADERS);
  for (const row of SAMPLE_ROWS) {
    sheet.addRow(row);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}

function buildSampleCsv(): Uint8Array {
  const lines = [HEADERS.join(",")];
  for (const row of SAMPLE_ROWS) {
    lines.push(row.map((cell) => (cell === null || cell === "" ? "" : String(cell))).join(","));
  }
  return new TextEncoder().encode(`\uFEFF${lines.join("\n")}`);
}

async function expectApiError(
  fn: () => Promise<unknown>,
  status: number,
  code?: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      expect(error.status).toBe(status);
      if (code) {
        expect(error.code).toBe(code);
      }
      return;
    }
    throw error;
  }
  throw new Error("预期抛出 ApiError，但未抛出");
}

describe("导入全流程（固定样例文件）", () => {
  let sales: TestUser;
  let leadA: { id: string; name: string };

  beforeAll(async () => {
    sales = await createTestUser("sales");
    leadA = await createLead(sales, {
      name: "既有客户甲",
      city: "武汉",
      contactPhone: "13800138000",
    });
    await createLead(sales, { name: "既有客户乙", city: "上海" });
  });

  it("上传前置校验：类型白名单 / 非法 XLSX / 行数上限 / 大小上限", async () => {
    await expectApiError(
      () => uploadImport(sales, { filename: "名单.txt", bytes: new TextEncoder().encode("x") }),
      400,
      "unsupported_type",
    );
    await expectApiError(
      () => uploadImport(sales, { filename: "a.xlsx", bytes: new TextEncoder().encode("not zip") }),
      400,
      "invalid_xlsx",
    );
    const lines = ["客户名称,城市"];
    for (let i = 0; i < 5001; i += 1) {
      lines.push(`客户${i},杭州`);
    }
    await expectApiError(
      () =>
        uploadImport(sales, {
          filename: "big.csv",
          bytes: new TextEncoder().encode(lines.join("\n")),
        }),
      400,
      "row_limit",
    );
    await expectApiError(
      () =>
        uploadImport(sales, {
          filename: "huge.csv",
          bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        }),
      400,
      "file_too_large",
    );
  });

  it("上传 XLSX：自动映射成功，计数 2 有效 / 3 错误 / 3 重复，且确认前不入库", async () => {
    const bytes = await buildSampleXlsx();
    const result = await uploadImport(sales, { filename: "固定样例.xlsx", bytes });
    expect(result.headers).toEqual(HEADERS);
    // 表头与字段 label 一致 → 自动映射全命中
    expect(result.mapping["0"]).toBe("name");
    expect(result.mapping["2"]).toBe("contact_phone");
    expect(result.counts).toEqual({ total: 8, valid: 2, error: 3, dup: 3 });

    const leadCount = await prisma.lead.count({ where: { ownerId: sales.id } });
    expect(leadCount).toBe(2); // 仅 beforeAll 的既有客户，样例文件未入库
    // 批次状态 pending
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: result.batchId },
    });
    expect(batch.status).toBe("pending");
    expect(batch.fileHash).toHaveLength(64);
  });

  it("错误行原因逐条准确（与表单校验同源）", async () => {
    const bytes = await buildSampleXlsx();
    const upload = await uploadImport(sales, { filename: "错误明细.xlsx", bytes });
    const preview = await getImportPreview(sales, upload.batchId, {
      tab: "error",
      page: 1,
      pageSize: 50,
    });
    expect(preview.total).toBe(3);
    const byRowNo = new Map(preview.rows.map((row) => [row.rowNo, row]));
    expect(byRowNo.get(3)!.errors).toEqual([
      { key: "contact_phone", label: "联系方式", message: "联系方式仅支持数字及 + - ( ) 空格" },
    ]);
    expect(byRowNo.get(4)!.errors).toEqual([
      { key: "contract_expiry", label: "合同/到期时间", message: "合同/到期时间不是有效的日历日期" },
    ]);
    expect(byRowNo.get(5)!.errors).toEqual([
      { key: "name", label: "客户名称", message: "请输入客户名称" },
    ]);
  });

  it("重复检出：手机号精确（含 +86/横线变体）+ 名称城市疑似 + 文件内重复", async () => {
    const bytes = await buildSampleXlsx();
    const upload = await uploadImport(sales, { filename: "重复检出.xlsx", bytes });
    const preview = await getImportPreview(sales, upload.batchId, {
      tab: "dup",
      page: 1,
      pageSize: 50,
    });
    expect(preview.total).toBe(3);
    const byRowNo = new Map(preview.rows.map((row) => [row.rowNo, row]));

    const exact = byRowNo.get(6)!;
    expect(exact.dupType).toBe("exact");
    expect(exact.dupLeadId).toBe(leadA.id);
    expect(exact.dupLeadName).toBe("既有客户甲");
    expect(exact.decision).toBe("skip"); // 重复行默认跳过

    const fuzzy = byRowNo.get(7)!;
    expect(fuzzy.dupType).toBe("fuzzy");
    expect(fuzzy.dupLeadName).toBe("既有客户乙");

    const inFile = byRowNo.get(8)!;
    expect(inFile.dupType).toBe("exact");
    expect(inFile.dupLeadId).toBeNull();
    expect(inFile.dupRowNo).toBe(1); // 指向文件内第 1 行
  });

  it("确认导入：有效行入库 + 文件内重复行按决定仍新建；写 imported 事件与审计", async () => {
    const bytes = await buildSampleXlsx();
    const upload = await uploadImport(sales, { filename: "确认导入.xlsx", bytes });
    const dupRows = await getImportPreview(sales, upload.batchId, {
      tab: "dup",
      page: 1,
      pageSize: 50,
    });
    const inFileDupRow = dupRows.rows.find((row) => row.rowNo === 8)!;

    const result = await confirmImport(sales, upload.batchId, {
      decisions: [{ rowId: inFileDupRow.id, decision: "create_new" }],
    });
    expect(result).toEqual({ total: 8, created: 3, skipped: 5, recheckFailed: 0 });

    // 入库值核对（第 1 行）
    const created = await prisma.lead.findFirstOrThrow({
      where: { ownerId: sales.id, name: "武汉光谷科技有限公司" },
    });
    expect(created.contactPhone).toBe("13900000001");
    expect(created.contractExpiry?.toISOString().slice(0, 10)).toBe("2027-01-31");
    expect(created.salesTeamSize).toBe(25);
    expect(created.consideringSwitch).toBe(true);
    expect(created.dataVersion).toBe(1);

    // imported 事件含批次与行号
    const event = await prisma.leadEvent.findFirst({
      where: { leadId: created.id, eventType: "imported" },
    });
    expect(event?.detail).toMatchObject({
      import: { batchId: upload.batchId, rowNo: 1 },
    });

    // 审计
    const audit = await prisma.auditLog.findFirst({
      where: { userId: sales.id, action: "import.confirmed", objectId: upload.batchId },
    });
    expect(audit?.detail).toMatchObject({ created: 3, skipped: 5, total: 8 });

    // 批次终态
    const batch = await prisma.importBatch.findUniqueOrThrow({
      where: { id: upload.batchId },
    });
    expect(batch.status).toBe("confirmed");
    expect(batch.confirmedAt).not.toBeNull();

    // 重复确认 → 409
    await expectApiError(
      () => confirmImport(sales, upload.batchId, {}),
      409,
      "import_not_pending",
    );
  });

  it("CSV 路径与 XLSX 结果一致（BOM + 中文表头自动映射）", async () => {
    // 独立用户（无既有客户）：重复只剩文件内 1 条（第 8 行与第 1 行电话相同）
    const fresh = await createTestUser("sales");
    const result = await uploadImport(fresh, {
      filename: "固定样例.csv",
      bytes: buildSampleCsv(),
    });
    expect(result.counts).toEqual({ total: 8, valid: 4, error: 3, dup: 1 });
    const confirmed = await confirmImport(fresh, result.batchId, {});
    expect(confirmed.created).toBe(4);
  });

  it("映射规则：未映射客户名称 / 目标重复 → 400 mapping_invalid", async () => {
    const bytes = await buildSampleXlsx();
    const upload = await uploadImport(sales, { filename: "映射校验.xlsx", bytes });
    await expectApiError(
      () =>
        saveImportMapping(sales, upload.batchId, {
          mapping: { "0": "city", "1": null, "2": null, "3": null, "4": null, "5": null },
        }),
      400,
      "mapping_invalid",
    );
    await expectApiError(
      () =>
        saveImportMapping(sales, upload.batchId, {
          mapping: { "0": "name", "1": "name", "2": null, "3": null, "4": null, "5": null },
        }),
      400,
      "mapping_invalid",
    );
  });

  it("批次越权：他人 PATCH / 预览 / 确认一律 404", async () => {
    const bytes = await buildSampleXlsx();
    const upload = await uploadImport(sales, { filename: "越权.xlsx", bytes });
    const other = await createTestUser("sales");
    await expectApiError(
      () =>
        saveImportMapping(other, upload.batchId, {
          mapping: { "0": "name", "1": null, "2": null, "3": null, "4": null, "5": null },
        }),
      404,
      "not_found",
    );
    await expectApiError(
      () =>
        getImportPreview(other, upload.batchId, { tab: "all", page: 1, pageSize: 10 }),
      404,
      "not_found",
    );
    await expectApiError(() => confirmImport(other, upload.batchId, {}), 404, "not_found");
  });
});

describe("导入：自定义字段参与映射（C12）", () => {
  it("自定义列值落 custom_values；非法选项行报引擎错误", async () => {
    const sales = await createTestUser("sales");
    const levelDef = await createTestFieldDef({
      key: `vip_level_${Date.now() % 100000}`,
      label: "客户等级",
      type: "single_select",
      options: [{ value: "a", label: "A 类" }, { value: "b", label: "B 类" }],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("客户");
    sheet.addRow(["客户名称", "客户等级"]);
    sheet.addRow(["自定义客户甲", "a"]);
    sheet.addRow(["自定义客户乙", "z"]);
    const buffer = await workbook.xlsx.writeBuffer();

    const upload = await uploadImport(sales, {
      filename: "自定义.xlsx",
      bytes: new Uint8Array(buffer as ArrayBuffer),
    });
    expect(upload.mapping["1"]).toBe(levelDef.key); // 自动映射命中自定义列
    expect(upload.counts).toEqual({ total: 2, valid: 1, error: 1, dup: 0 });

    const errorPreview = await getImportPreview(sales, upload.batchId, {
      tab: "error",
      page: 1,
      pageSize: 10,
    });
    expect(errorPreview.rows[0]!.errors).toEqual([
      { key: levelDef.key, label: "客户等级", message: "不在可选范围内" },
    ]);

    const result = await confirmImport(sales, upload.batchId, {});
    expect(result.created).toBe(1);
    const lead = await prisma.lead.findFirstOrThrow({
      where: { ownerId: sales.id, name: "自定义客户甲" },
    });
    expect(lead.customValues).toEqual({ [levelDef.key]: "a" });
  });
});

describe("导入：管理员重复检测范围为全量（C10）", () => {
  it("管理员导入他人客户手机号 → 精确重复提示", async () => {
    const sales = await createTestUser("sales");
    const admin = await createTestUser("admin");
    const existing = await createLead(sales, {
      name: "销售甲的客户",
      contactPhone: "13911112222",
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("客户");
    sheet.addRow(["客户名称", "联系方式"]);
    sheet.addRow(["管理员的新客户", "139-1111-2222"]);
    const buffer = await workbook.xlsx.writeBuffer();

    const upload = await uploadImport(admin, {
      filename: "管理员导入.xlsx",
      bytes: new Uint8Array(buffer as ArrayBuffer),
    });
    expect(upload.counts).toEqual({ total: 1, valid: 0, error: 0, dup: 1 });
    const preview = await getImportPreview(admin, upload.batchId, {
      tab: "dup",
      page: 1,
      pageSize: 10,
    });
    expect(preview.rows[0]!.dupLeadId).toBe(existing.id);
  });

  it("销售的重复检测不泄露他人客户（他人同手机号不算重复）", async () => {
    const salesA = await createTestUser("sales");
    const salesB = await createTestUser("sales");
    await createLead(salesB, { name: "B 的客户", contactPhone: "13933334444" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("客户");
    sheet.addRow(["客户名称", "联系方式"]);
    sheet.addRow(["A 的新客户", "13933334444"]);
    const buffer = await workbook.xlsx.writeBuffer();

    const upload = await uploadImport(salesA, {
      filename: "隔离导入.xlsx",
      bytes: new Uint8Array(buffer as ArrayBuffer),
    });
    expect(upload.counts).toEqual({ total: 1, valid: 1, error: 0, dup: 0 });
  });
});
