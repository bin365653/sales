import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import Papa from "papaparse";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { createTestFieldDef, createTestUser, cleanupTestUsers, type TestUser } from "./helpers";
import { createLead } from "@/server/services/leads";
import { leadListQuerySchema } from "@/lib/schemas/lead";
import {
  createLeadsExport,
  createMyDataExport,
  getExportFile,
} from "@/server/services/exports";

// T05 导出（验收项：导出范围正确且公式转义）。
// - 范围：与列表同一 where 构造器，SQL 手查对账；销售仅本人，管理员全量/可按负责人；
// - 转义：= + - @ 开头单元格加 ' 前缀（CSV 与 XLSX 同规则）；
// - 个人全量 ZIP 仅含本人客户；下载仅创建者可用；限流 5 次/小时（429）。

/** 与 API 层一致地构造导出筛选（Zod 默认值补全 page/pageSize） */
function query(partial: Record<string, unknown>) {
  return leadListQuerySchema.parse(partial);
}

/** exceljs 的 d.ts 自声明 Buffer（extends ArrayBuffer）与 Node Buffer 不兼容，运行时兼容 */
function asXlsxLoadBuffer(bytes: Buffer): ArrayBuffer {
  return bytes as unknown as ArrayBuffer;
}

afterAll(cleanupTestUsers);

/** createTestUser 已在 helpers 登记清理；此处仅统一语义（每个用例独立用户） */
async function newUser(role: "sales" | "admin"): Promise<TestUser> {
  return createTestUser(role);
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

async function parseCsvExport(
  user: TestUser,
  id: string,
): Promise<{ headers: string[]; rows: string[][]; raw: string }> {
  const file = await getExportFile(user, id);
  const raw = Buffer.from(file.bytes).toString("utf8");
  const text = raw.replace(/^\uFEFF/, "");
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const [headers = [], ...rows] = parsed.data as string[][];
  return { headers, rows, raw };
}

describe("客户列表导出（范围正确 + 公式转义）", () => {
  it("按筛选导出与手写 SQL 对账一致；CSV 带 BOM；公式单元格被转义", async () => {
    const sales = await newUser("sales");
    const other = await newUser("sales");
    await createLead(other, { name: "别人家的客户", city: "武汉" });

    await createLead(sales, { name: "武汉正常客户", city: "武汉" });
    await createLead(sales, {
      name: "=HYPERLINK(\"http://evil\",\"点我\")",
      city: "武汉",
      contactPhone: "13800000000",
    });
    await createLead(sales, { name: "上海客户", city: "上海" });

    const created = await createLeadsExport(sales, {
      format: "csv",
      filters: query({ city: "武汉" }),
    });
    expect(created.rowCount).toBe(2);

    // SQL 手查对账
    const expected = await prisma.lead.findMany({
      where: { ownerId: sales.id, city: "武汉", deletedAt: null },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    expect(expected).toHaveLength(2);

    const csv = await parseCsvExport(sales, created.id);
    expect(csv.raw.startsWith("\uFEFF")).toBe(true);
    const nameIdx = csv.headers.indexOf("客户名称");
    const names = csv.rows.map((row) => row[nameIdx]);
    // 恶意名称已加 ' 前缀，且不包含他人数据
    expect(names).toContain("'=HYPERLINK(\"http://evil\",\"点我\")");
    expect(names).toContain("武汉正常客户");
    expect(names).not.toContain("别人家的客户");
    expect(csv.rows).toHaveLength(2);
    // 含管理列
    expect(csv.headers).toContain("客户阶段");
    expect(csv.headers).toContain("负责人");
  });

  it("XLSX 导出可回读：行数一致、恶意单元格为转义字符串", async () => {
    const sales = await newUser("sales");
    await createLead(sales, { name: "+1|正常客户", city: "杭州" });
    await createLead(sales, { name: "普通客户", city: "杭州" });

    const created = await createLeadsExport(sales, {
      format: "xlsx",
      filters: query({ city: "杭州" }),
    });
    const file = await getExportFile(sales, created.id);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(asXlsxLoadBuffer(file.bytes));
    const sheet = workbook.worksheets[0]!;
    expect(sheet.actualRowCount).toBe(3); // 表头 + 2 行
    const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    const nameIdx = headers.indexOf("客户名称") + 1;
    const names = [2, 3].map(
      (rowNo) => String(sheet.getRow(rowNo).getCell(nameIdx).value),
    );
    // 不依赖行序（updatedAt 排序在毫秒内不稳定）
    expect(names).toEqual(expect.arrayContaining(["'+1|正常客户", "普通客户"]));
  });

  it("管理员可导全量并按负责人筛选（C10），销售强制本人范围", async () => {
    const salesA = await newUser("sales");
    const salesB = await newUser("sales");
    const admin = await newUser("admin");
    await createLead(salesA, { name: "A 的客户", city: "南京" });
    await createLead(salesB, { name: "B 的客户", city: "南京" });

    // 管理员全量：与前序用例数据无关，与 SQL 手查对账
    const allExport = await createLeadsExport(admin, { format: "csv", filters: query({}) });
    const expectedAll = await prisma.lead.count({ where: { deletedAt: null } });
    expect(allExport.rowCount).toBe(expectedAll);
    expect(allExport.rowCount).toBeGreaterThanOrEqual(2);
    // 管理员按负责人
    const ownerExport = await createLeadsExport(admin, {
      format: "csv",
      filters: query({ ownerId: salesA.id }),
    });
    expect(ownerExport.rowCount).toBe(1);
    const csv = await parseCsvExport(admin, ownerExport.id);
    expect(csv.rows.some((row) => row[csv.headers.indexOf("客户名称")] === "A 的客户")).toBe(true);

    // 销售的 ownerId 筛选参数无效：恒为本人
    const salesExport = await createLeadsExport(salesA, {
      format: "csv",
      filters: query({ ownerId: salesB.id }),
    });
    expect(salesExport.rowCount).toBe(1); // 只有 A 自己的
    const myCsv = await parseCsvExport(salesA, salesExport.id);
    expect(myCsv.rows[0]![myCsv.headers.indexOf("客户名称")]).toBe("A 的客户");
  });

  it("自定义字段有值才成列，值随导出", async () => {
    const sales = await newUser("sales");
    const def = await createTestFieldDef({
      key: `channel_${Date.now() % 100000}`,
      label: "获客渠道",
      type: "text",
    });
    await createLead(sales, { name: "带渠道客户", customValues: { [def.key]: "展会" } });
    await createLead(sales, { name: "无渠道客户" });

    const created = await createLeadsExport(sales, { format: "csv", filters: query({}) });
    const csv = await parseCsvExport(sales, created.id);
    const channelIdx = csv.headers.indexOf("获客渠道");
    expect(channelIdx).toBeGreaterThan(-1);
    const nameIdx = csv.headers.indexOf("客户名称");
    const withChannel = csv.rows.find((row) => row[nameIdx] === "带渠道客户");
    expect(withChannel![channelIdx]).toBe("展会");
  });
});

describe("个人全量导出（ZIP）", () => {
  it("ZIP 含客户 XLSX+CSV，仅本人数据", async () => {
    const sales = await newUser("sales");
    const other = await newUser("sales");
    await createLead(other, { name: "别人的全量客户" });
    await createLead(sales, { name: "我的全量客户甲" });
    await createLead(sales, { name: "我的全量客户乙" });

    const created = await createMyDataExport(sales);
    expect(created.rowCount).toBe(2);
    const file = await getExportFile(sales, created.id);
    expect(file.contentType).toBe("application/zip");

    const zip = await JSZip.loadAsync(file.bytes);
    const csvFile = zip.file("客户全量.csv");
    expect(csvFile).not.toBeNull();
    const csvText = (await csvFile!.async("string")).replace(/^\uFEFF/, "");
    const parsed = Papa.parse<string[]>(csvText, { skipEmptyLines: "greedy" });
    const [headers = [], ...rows] = parsed.data as string[][];
    const nameIdx = headers.indexOf("客户名称");
    const names = rows.map((row) => row[nameIdx]);
    expect(names).toEqual(
      expect.arrayContaining(["我的全量客户甲", "我的全量客户乙"]),
    );
    expect(names).not.toContain("别人的全量客户");
    expect(names).toHaveLength(2);

    const xlsxFile = zip.file("客户全量.xlsx");
    expect(xlsxFile).not.toBeNull();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(asXlsxLoadBuffer(await xlsxFile!.async("nodebuffer")));
    expect(workbook.worksheets[0]!.actualRowCount).toBe(3);
  });
});

describe("导出限流与下载权限", () => {
  it("每小时 5 次上限，第 6 次 429 rate_limited", async () => {
    const sales = await newUser("sales");
    await createLead(sales, { name: "限流客户" });
    for (let i = 0; i < 5; i += 1) {
      const result = await createLeadsExport(sales, { format: "csv", filters: query({}) });
      expect(result.rowCount).toBe(1);
    }
    await expectApiError(
      () => createLeadsExport(sales, { format: "csv", filters: query({}) }),
      429,
      "rate_limited",
    );
  });

  it("他人下载 → 404；过期 → 404", async () => {
    const sales = await newUser("sales");
    const other = await newUser("sales");
    await createLead(sales, { name: "下载权限客户" });
    const created = await createLeadsExport(sales, { format: "csv", filters: query({}) });

    await expectApiError(() => getExportFile(other, created.id), 404, "not_found");

    await prisma.exportFile.update({
      where: { id: created.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectApiError(() => getExportFile(sales, created.id), 404, "not_found");
  });

  it("导出写审计（export.created）", async () => {
    const sales = await newUser("sales");
    await createLead(sales, { name: "审计客户", city: "审计市" });
    const created = await createLeadsExport(sales, {
      format: "xlsx",
      filters: query({ city: "审计市" }),
    });
    const audit = await prisma.auditLog.findFirst({
      where: { userId: sales.id, action: "export.created", objectId: created.id },
    });
    expect(audit?.detail).toMatchObject({
      kind: "leads",
      format: "xlsx",
      rows: 1,
      filters: query({ city: "审计市" }),
    });
  });
});
