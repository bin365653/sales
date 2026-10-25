import { createHash } from "node:crypto";
import { ImportBatch, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { writeAudit } from "@/server/auth/audit";
import { AuthUser } from "@/lib/auth";
import { leadCreateSchema, LeadCreateInput } from "@/lib/schemas/lead";
import {
  ImportConfirmInput,
  ImportMappingInput,
  ImportRowsQuery,
} from "@/lib/schemas/import";
import { validateCustomValues, FieldDefLike } from "@/lib/lead-field-validation";
import { BUILTIN_LEAD_FIELDS } from "@/lib/lead-fields";
import { leadReadScope } from "@/server/permissions";
import {
  assertUploadLimits,
  FileParseError,
  parseImportFile,
  type CellPrimitive,
} from "@/lib/import/parse";
import {
  coerceBooleanCell,
  coerceDateCell,
  isBlankCell,
  normalizeNameLike,
  normalizePhone,
} from "@/lib/import/normalize";
import {
  insertLeadWithEvent,
  resolveDefaultStage,
} from "@/server/services/leads";
import { buildImportTemplateFields, type ImportTemplateField } from "@/lib/import/template";

// 导入服务（T05，实施计划 §4.2 两阶段导入 / §6 导入端点 / M2 重复判定）。
//
// 关键不变量：
// - 上传/映射/预览只写 import_batches + import_rows（两阶段的第一阶段），
//   确认（confirm）才写 leads——「确认前不入库」是 T05 验收项；
// - 行级错误原因来自与表单同一套校验（leadCreateSchema + 自定义字段引擎），
//   文案与手工录入完全一致（「错误行原因准确」验收项）；
// - 重复判定（M2）：手机号标准化后精确匹配 = exact；名称+城市匹配 = fuzzy；
//   均含"与库中重复"（dupLeadId）与"文件内重复"（dupRowNo）；
//   检测范围 = 导入者在权限层数据范围（销售=本人，不泄露他人客户存在性；
//   管理员=全量，C10）；
// - 确认是整体事务：任一行写入失败全部回滚，不出现部分导入；
// - 决策只有 skip / create_new，绝不更新既有线索（M2：不静默覆盖）；
// - 批次归属导入者本人，他人访问一律 404（§8.2）。

// ---------- 字段目标 ----------

interface ImportTarget {
  key: string;
  label: string;
  kind: "builtin" | "custom";
  type?: "text" | "number" | "date" | "single_select";
}

interface ImportFieldDefs {
  targets: ImportTarget[];
  targetByKey: Map<string, ImportTarget>;
  activeCustomDefs: FieldDefLike[];
}

/** 内置列的布尔/日期语义（导入单元格矫正用） */
const BUILTIN_BOOLEAN_KEYS = new Set(["considering_switch", "has_clear_demand"]);
const BUILTIN_DATE_KEYS = new Set(["contract_expiry"]);

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

async function loadImportFieldDefs(): Promise<ImportFieldDefs> {
  const defs = await prisma.leadFieldDef.findMany();
  const builtinByKey = new Map(
    defs
      .filter((def) => def.isBuiltin && def.isActive)
      .map((def) => [def.key, { key: def.key, label: def.label }] as const),
  );
  const targets: ImportTarget[] = [];
  // 与模板一致：BUILTIN_LEAD_FIELDS 固定顺序（name 首位）
  for (const field of BUILTIN_LEAD_FIELDS) {
    const def = builtinByKey.get(field.key);
    if (def) {
      targets.push({ key: def.key, label: def.label, kind: "builtin" });
    }
  }
  const activeCustomDefs: FieldDefLike[] = [];
  for (const def of defs
    .filter((def) => !def.isBuiltin && def.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)) {
    targets.push({
      key: def.key,
      label: def.label,
      kind: "custom",
      type: def.type as ImportTarget["type"],
    });
    activeCustomDefs.push({
      key: def.key,
      type: def.type as FieldDefLike["type"],
      options: def.options,
      validation: def.validation,
    });
  }
  return {
    targets,
    targetByKey: new Map(targets.map((target) => [target.key, target])),
    activeCustomDefs,
  };
}

/** 表头自动映射猜测：先按启用字段 label 精确匹配（忽略大小写/空白），再按 key */
function guessMapping(headers: string[], fieldDefs: ImportFieldDefs): Record<string, string | null> {
  const byLabel = new Map(
    fieldDefs.targets.map((target) => [
      normalizeNameLike(target.label),
      target.key,
    ]),
  );
  const byKey = new Map(
    fieldDefs.targets.map((target) => [normalizeNameLike(target.key), target.key]),
  );
  const mapping: Record<string, string | null> = {};
  headers.forEach((header, index) => {
    const normalized = normalizeNameLike(header);
    mapping[String(index)] = byLabel.get(normalized) ?? byKey.get(normalized) ?? null;
  });
  return mapping;
}

// ---------- 行值构造与校验 ----------

export interface RowIssue {
  key: string;
  label: string;
  message: string;
}

export interface NormalizedRow {
  payload: LeadCreateInput;
  customValues: Record<string, string | number>;
}

/** 单个单元格 → 目标字段的原始值（类型矫正后、Schema 校验前） */
function cellToTargetValue(target: ImportTarget, cell: CellPrimitive): unknown {
  if (target.kind === "builtin") {
    if (isBlankCell(cell)) {
      // 空白单元格传 ""：name 走「请输入客户名称」准确文案；
      // 其余可选字段经 Schema 的 emptyToNull 归一化为 null
      return "";
    }
    if (BUILTIN_BOOLEAN_KEYS.has(target.key)) {
      return coerceBooleanCell(cell);
    }
    if (BUILTIN_DATE_KEYS.has(target.key)) {
      return coerceDateCell(cell);
    }
    if (target.key === "sales_team_size") {
      return cell;
    }
    return typeof cell === "string" ? cell : String(cell);
  }
  if (isBlankCell(cell)) {
    // 自定义字段引擎以 null 表达空值（必填报「为必填项，不能留空」）
    return null;
  }
  switch (target.type) {
    case "number":
      return cell;
    case "date":
      return typeof cell === "string" ? cell.trim() : String(cell);
    default:
      return typeof cell === "string" ? cell : String(cell);
  }
}

const BUILTIN_LABEL_BY_KEY = new Map(
  BUILTIN_LEAD_FIELDS.map((field) => [field.key, field.label]),
);

/**
 * 按映射把一行单元格转成入参并校验。
 * 错误文案全部来自 leadCreateSchema / 自定义字段引擎（与表单同源）。
 */
export function validateRowByMapping(
  fieldDefs: ImportFieldDefs,
  mapping: Record<string, string | null>,
  cells: CellPrimitive[],
): { normalized: NormalizedRow | null; errors: RowIssue[] } {
  const errors: RowIssue[] = [];
  const builtinInput: Record<string, unknown> = {};
  const customInput: Record<string, unknown> = {};
  const columnOfTarget = new Map<string, number>();
  for (const [indexKey, targetKey] of Object.entries(mapping)) {
    if (!targetKey) {
      continue;
    }
    const target = fieldDefs.targetByKey.get(targetKey);
    if (!target) {
      continue;
    }
    columnOfTarget.set(target.key, Number(indexKey));
    const cell = cells[Number(indexKey)] ?? null;
    const value = cellToTargetValue(target, cell);
    if (target.kind === "builtin") {
      builtinInput[snakeToCamel(target.key)] = value;
    } else {
      customInput[target.key] = value;
    }
  }

  const parsed = leadCreateSchema.safeParse(builtinInput);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const snakeKey = String(issue.path[0] ?? "").replace(
        /[A-Z]/g,
        (char) => `_${char.toLowerCase()}`,
      );
      errors.push({
        key: snakeKey,
        label: BUILTIN_LABEL_BY_KEY.get(snakeKey) ?? String(issue.path[0] ?? "字段"),
        message: issue.message,
      });
    }
  }
  const custom = validateCustomValues(fieldDefs.activeCustomDefs, customInput, {
    requireAll: true,
  });
  for (const issue of custom.issues) {
    const target = fieldDefs.targetByKey.get(issue.key);
    errors.push({
      key: issue.key,
      label: target?.label ?? issue.key,
      message: issue.message,
    });
  }

  if (errors.length > 0) {
    // 错误按文件列顺序呈现（与用户看到的表格一致）
    errors.sort(
      (a, b) => (columnOfTarget.get(a.key) ?? Number.MAX_SAFE_INTEGER)
        - (columnOfTarget.get(b.key) ?? Number.MAX_SAFE_INTEGER),
    );
    return { normalized: null, errors };
  }
  return {
    normalized: {
      // zod v4 safeParse 的 data 类型带可选 undefined，此处已确认 success
      payload: parsed.data as LeadCreateInput,
      customValues: custom.values,
    },
    errors: [],
  };
}

// ---------- 重复检测 ----------

interface DupIndex {
  /** 标准化手机号 → 库中线索 */
  phoneLead: Map<string, { id: string; name: string }>;
  /** 标准化 名称|城市 → 库中线索（可多条） */
  nameCityLeads: Map<string, { id: string; name: string }[]>;
}

async function buildDupIndex(actor: AuthUser): Promise<DupIndex> {
  const scope = leadReadScope(actor);
  const leads = await prisma.lead.findMany({
    where: { ...scope, deletedAt: null },
    select: { id: true, name: true, city: true, contactPhone: true },
  });
  const phoneLead = new Map<string, { id: string; name: string }>();
  const nameCityLeads = new Map<string, { id: string; name: string }[]>();
  for (const lead of leads) {
    if (lead.contactPhone) {
      const phone = normalizePhone(lead.contactPhone);
      if (phone && !phoneLead.has(phone)) {
        phoneLead.set(phone, { id: lead.id, name: lead.name });
      }
    }
    if (lead.city && lead.name) {
      const key = `${normalizeNameLike(lead.name)}|${normalizeNameLike(lead.city)}`;
      const bucket = nameCityLeads.get(key) ?? [];
      bucket.push({ id: lead.id, name: lead.name });
      nameCityLeads.set(key, bucket);
    }
  }
  return { phoneLead, nameCityLeads };
}

interface DupMatch {
  dupType: "none" | "exact" | "fuzzy";
  dupLeadId: string | null;
  dupRowNo: number | null;
}

function detectRowDup(
  index: DupIndex,
  phoneSeen: Map<string, number>,
  nameCitySeen: Map<string, number>,
  normalized: NormalizedRow,
): DupMatch {
  const phone = normalized.payload.contactPhone
    ? normalizePhone(normalized.payload.contactPhone)
    : "";
  const name = normalized.payload.name;
  const city = normalized.payload.city;
  if (phone) {
    const dbHit = index.phoneLead.get(phone);
    if (dbHit) {
      return { dupType: "exact", dupLeadId: dbHit.id, dupRowNo: phoneSeen.get(phone) ?? null };
    }
    if (phoneSeen.has(phone)) {
      return { dupType: "exact", dupLeadId: null, dupRowNo: phoneSeen.get(phone)! };
    }
  }
  const nameCityKey =
    name && city ? `${normalizeNameLike(name)}|${normalizeNameLike(city)}` : null;
  if (nameCityKey) {
    const dbHits = index.nameCityLeads.get(nameCityKey);
    const firstHit = dbHits?.[0];
    if (firstHit) {
      return {
        dupType: "fuzzy",
        dupLeadId: firstHit.id,
        dupRowNo: nameCitySeen.get(nameCityKey) ?? null,
      };
    }
    if (nameCitySeen.has(nameCityKey)) {
      return { dupType: "fuzzy", dupLeadId: null, dupRowNo: nameCitySeen.get(nameCityKey)! };
    }
  }
  return { dupType: "none", dupLeadId: null, dupRowNo: null };
}

// ---------- 上传（POST /api/imports） ----------

/** 模板列（GET /api/imports/template 用）：启用内置 + 启用自定义，与映射目标同源 */
export async function getImportTemplateFields(): Promise<ImportTemplateField[]> {
  const defs = await prisma.leadFieldDef.findMany();
  const activeBuiltinKeys = new Set(
    defs.filter((def) => def.isBuiltin && def.isActive).map((def) => def.key),
  );
  const activeBuiltin = BUILTIN_LEAD_FIELDS.filter((field) =>
    activeBuiltinKeys.has(field.key),
  ).map((field) => ({ key: field.key, label: field.label }));
  const activeCustom = defs
    .filter((def) => !def.isBuiltin && def.isActive)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((def) => ({
      key: def.key,
      label: def.label,
      type: def.type as "text" | "number" | "date" | "single_select",
      options: def.options,
      validation: def.validation,
    }));
  return buildImportTemplateFields(activeBuiltin, activeCustom);
}

export interface ImportUploadResult {
  batchId: string;
  filename: string;
  headers: string[];
  mapping: Record<string, string | null>;
  counts: ImportCounts;
}

export interface ImportCounts {
  total: number;
  valid: number;
  error: number;
  dup: number;
}

function toApiError(error: unknown): unknown {
  if (error instanceof FileParseError) {
    return new ApiError(400, error.code, error.message);
  }
  return error;
}

export async function uploadImport(
  actor: AuthUser,
  file: { filename: string; bytes: Uint8Array },
): Promise<ImportUploadResult> {
  try {
    assertUploadLimits(file.filename, file.bytes.byteLength);
  } catch (error) {
    throw toApiError(error);
  }
  let parsed;
  try {
    parsed = await parseImportFile(file.filename, file.bytes);
  } catch (error) {
    throw toApiError(error);
  }

  const fieldDefs = await loadImportFieldDefs();
  const mapping = guessMapping(parsed.headers, fieldDefs);

  const batch = await prisma.importBatch.create({
    data: {
      userId: actor.id,
      filename: file.filename.slice(0, 255),
      fileHash: createHash("sha256").update(file.bytes).digest("hex"),
      headers: parsed.headers as unknown as Prisma.InputJsonValue,
      mapping: mapping as unknown as Prisma.InputJsonValue,
      status: "pending",
    },
  });
  await prisma.importRow.createMany({
    data: parsed.rows.map((cells, index) => ({
      batchId: batch.id,
      rowNo: index + 1,
      raw: cells as unknown as Prisma.InputJsonValue,
    })),
  });

  const counts = await applyMapping(actor, batch.id, mapping);
  return {
    batchId: batch.id,
    filename: batch.filename,
    headers: parsed.headers,
    mapping,
    counts,
  };
}

// ---------- 保存映射（PATCH /api/imports/:id） ----------

async function loadOwnedBatchOrThrow(
  actor: AuthUser,
  batchId: string,
): Promise<ImportBatch> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.userId !== actor.id) {
    throw new ApiError(404, "not_found", "导入批次不存在");
  }
  return batch;
}

/**
 * 校验映射合法性（导出供单元测试复用）：
 * 键必须是列下标；目标必须存在且启用；目标不可重复；必须映射客户名称。
 */
export function assertMappingValid(
  headers: string[],
  mapping: Record<string, string | null>,
  fieldDefs: ImportFieldDefs,
): void {
  const headerCount = headers.length;
  const usedTargets = new Set<string>();
  for (const [indexKey, targetKey] of Object.entries(mapping)) {
    const index = Number(indexKey);
    if (!Number.isInteger(index) || index < 0 || index >= headerCount) {
      throw new ApiError(400, "mapping_invalid", `列下标 ${indexKey} 不存在`);
    }
    if (targetKey === null) {
      continue;
    }
    const target = fieldDefs.targetByKey.get(targetKey);
    if (!target) {
      throw new ApiError(
        400,
        "mapping_invalid",
        `映射目标「${targetKey}」不存在或已停用`,
      );
    }
    if (usedTargets.has(targetKey)) {
      throw new ApiError(
        400,
        "mapping_invalid",
        `多个文件列映射到了「${target.label}」，一列只能对应一个字段`,
      );
    }
    usedTargets.add(targetKey);
  }
  if (!usedTargets.has("name")) {
    throw new ApiError(
      400,
      "mapping_invalid",
      "请至少将一个文件列映射到「客户名称」",
    );
  }
  // 必填自定义字段必须映射到某列：否则所有行都会因缺值报错，
  // 在映射阶段拦截并给出指向性提示（行级校验仍兜底空单元格）
  const missingRequired = fieldDefs.activeCustomDefs.filter((def) => {
    const rules =
      typeof def.validation === "object" && def.validation !== null
        ? (def.validation as Record<string, unknown>)
        : {};
    return rules.required === true && !usedTargets.has(def.key);
  });
  if (missingRequired.length > 0) {
    const labels = missingRequired.map((def) => {
      const target = fieldDefs.targetByKey.get(def.key);
      return target?.label ?? def.key;
    });
    throw new ApiError(
      400,
      "mapping_invalid",
      `自定义字段「${labels.join("、")}」为必填，请在文件中提供对应列并完成映射`,
    );
  }
}

/** 执行映射：计算全部行的校验/重复结果并落库，返回批次计数（保存映射与上传共用） */
async function applyMapping(
  actor: AuthUser,
  batchId: string,
  mapping: Record<string, string | null>,
): Promise<ImportCounts> {
  const fieldDefs = await loadImportFieldDefs();
  const batch = await prisma.importBatch.findUniqueOrThrow({
    where: { id: batchId },
  });
  const headers = (batch.headers ?? []) as unknown as string[];
  assertMappingValid(headers, mapping, fieldDefs);

  const rows = await prisma.importRow.findMany({
    where: { batchId },
    orderBy: { rowNo: "asc" },
  });
  const dupIndex = await buildDupIndex(actor);
  const phoneSeen = new Map<string, number>();
  const nameCitySeen = new Map<string, number>();

  let valid = 0;
  let error = 0;
  let dup = 0;
  type RowUpdate = {
    id: string;
    normalized: Prisma.InputJsonValue | typeof Prisma.DbNull;
    errors: Prisma.InputJsonValue | typeof Prisma.DbNull;
    hasErrors: boolean;
    dupType: "none" | "exact" | "fuzzy";
    dupLeadId: string | null;
    dupRowNo: number | null;
    decision: "skip" | "create_new";
  };
  const updates: RowUpdate[] = [];

  for (const row of rows) {
    const cells = row.raw as unknown as CellPrimitive[];
    const result = validateRowByMapping(fieldDefs, mapping, cells);
    if (result.errors.length > 0) {
      error += 1;
      updates.push({
        id: row.id,
        normalized: Prisma.DbNull,
        errors: result.errors as unknown as Prisma.InputJsonValue,
        hasErrors: true,
        dupType: "none",
        dupLeadId: null,
        dupRowNo: null,
        decision: "skip",
      });
      continue;
    }
    const normalized = result.normalized!;
    const match = detectRowDup(dupIndex, phoneSeen, nameCitySeen, normalized);
    // 记录文件内出现（供后续行判定文件内重复；无论本行最终为何种结果）
    const phone = normalized.payload.contactPhone
      ? normalizePhone(normalized.payload.contactPhone)
      : "";
    if (phone && !phoneSeen.has(phone)) {
      phoneSeen.set(phone, row.rowNo);
    }
    const nameCityKey =
      normalized.payload.name && normalized.payload.city
        ? `${normalizeNameLike(normalized.payload.name)}|${normalizeNameLike(normalized.payload.city!)}`
        : null;
    if (nameCityKey && !nameCitySeen.has(nameCityKey)) {
      nameCitySeen.set(nameCityKey, row.rowNo);
    }

    if (match.dupType !== "none") {
      dup += 1;
      updates.push({
        id: row.id,
        normalized: {
          payload: normalized.payload as unknown as Prisma.InputJsonValue,
          customValues: normalized.customValues as unknown as Prisma.InputJsonValue,
        },
        errors: Prisma.DbNull,
        hasErrors: false,
        dupType: match.dupType,
        dupLeadId: match.dupLeadId,
        dupRowNo: match.dupRowNo,
        // 重复行默认跳过（M2：只允许"跳过/仍新建"，默认保守）
        decision: "skip",
      });
      continue;
    }
    valid += 1;
    updates.push({
      id: row.id,
      normalized: {
        payload: normalized.payload as unknown as Prisma.InputJsonValue,
        customValues: normalized.customValues as unknown as Prisma.InputJsonValue,
      },
      errors: Prisma.DbNull,
      hasErrors: false,
      dupType: "none",
      dupLeadId: null,
      dupRowNo: null,
      decision: "create_new",
    });
  }

  await prisma.$transaction([
    ...updates.map((update) =>
      prisma.importRow.update({
        where: { id: update.id },
        data: {
          normalized: update.normalized,
          errors: update.errors,
          hasErrors: update.hasErrors,
          dupType: update.dupType,
          dupLeadId: update.dupLeadId,
          dupRowNo: update.dupRowNo,
          decision: update.decision,
        },
      }),
    ),
    prisma.importBatch.update({
      where: { id: batchId },
      data: {
        mapping: mapping as unknown as Prisma.InputJsonValue,
        counts: { total: rows.length, valid, error, dup } as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { total: rows.length, valid, error, dup };
}

export async function saveImportMapping(
  actor: AuthUser,
  batchId: string,
  input: ImportMappingInput,
): Promise<ImportCounts> {
  const batch = await loadOwnedBatchOrThrow(actor, batchId);
  if (batch.status !== "pending") {
    throw new ApiError(409, "import_not_pending", "该导入批次已确认，不能修改映射");
  }
  return applyMapping(actor, batchId, input.mapping);
}

// ---------- 预览（GET /api/imports/:id/rows） ----------

export interface PreviewRow {
  id: string;
  rowNo: number;
  name: string;
  contactPhone: string;
  city: string;
  errors: RowIssue[];
  dupType: "none" | "exact" | "fuzzy";
  dupLeadName: string | null;
  dupLeadId: string | null;
  dupRowNo: number | null;
  decision: "skip" | "create_new";
}

export async function getImportPreview(
  actor: AuthUser,
  batchId: string,
  query: ImportRowsQuery,
): Promise<{
  counts: ImportCounts | null;
  rows: PreviewRow[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const batch = await loadOwnedBatchOrThrow(actor, batchId);
  // 分桶互斥：错误 > 重复 > 有效；hasErrors 布尔列保证分页过滤不依赖 JSON 空值语义
  const where: Prisma.ImportRowWhereInput = { batchId };
  if (query.tab === "error") {
    where.hasErrors = true;
  } else if (query.tab === "dup") {
    where.hasErrors = false;
    where.dupType = { in: ["exact", "fuzzy"] };
  } else if (query.tab === "valid") {
    where.hasErrors = false;
    where.dupType = "none";
  }

  const [total, rows] = await Promise.all([
    prisma.importRow.count({ where }),
    prisma.importRow.findMany({
      where,
      orderBy: { rowNo: "asc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  const dupLeadIds = [
    ...new Set(rows.map((row) => row.dupLeadId).filter((id): id is string => !!id)),
  ];
  const dupLeadNames = new Map(
    dupLeadIds.length
      ? (
          await prisma.lead.findMany({
            where: { id: { in: dupLeadIds } },
            select: { id: true, name: true },
          })
        ).map((lead) => [lead.id, lead.name])
      : [],
  );

  return {
    counts: (batch.counts as unknown as ImportCounts | null) ?? null,
    rows: rows.map((row) => {
      const normalized = row.normalized as unknown as
        | { payload?: { name?: string; contactPhone?: string; city?: string } }
        | null;
      const payload = normalized?.payload ?? {};
      return {
        id: row.id,
        rowNo: row.rowNo,
        name: payload.name ?? "",
        contactPhone: payload.contactPhone ?? "",
        city: payload.city ?? "",
        errors: (row.errors as unknown as RowIssue[] | null) ?? [],
        dupType: row.dupType,
        dupLeadId: row.dupLeadId,
        dupLeadName: row.dupLeadId ? (dupLeadNames.get(row.dupLeadId) ?? null) : null,
        dupRowNo: row.dupRowNo,
        decision: row.decision,
      };
    }),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

// ---------- 确认（POST /api/imports/:id/confirm） ----------

export interface ImportConfirmResult {
  total: number;
  created: number;
  skipped: number;
  /** 预览后字段定义发生变化（停用/校验变更）导致确认时复检失败的行数 */
  recheckFailed: number;
}

export async function confirmImport(
  actor: AuthUser,
  batchId: string,
  input: ImportConfirmInput,
): Promise<ImportConfirmResult> {
  const batch = await loadOwnedBatchOrThrow(actor, batchId);
  if (batch.status !== "pending") {
    throw new ApiError(409, "import_not_pending", "该导入批次已确认，不能重复导入");
  }

  const rows = await prisma.importRow.findMany({
    where: { batchId },
    orderBy: { rowNo: "asc" },
  });
  const decisionById = new Map(
    (input.decisions ?? []).map((decision) => [decision.rowId, decision.decision]),
  );

  const fieldDefs = await loadImportFieldDefs();
  const defaultStage = await resolveDefaultStage();

  let created = 0;
  let skipped = 0;
  let recheckFailed = 0;

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      const errors = row.errors as unknown as RowIssue[] | null;
      if (errors && errors.length > 0) {
        skipped += 1;
        continue;
      }
      const decision = decisionById.get(row.id) ?? row.decision;
      if (decision !== "create_new") {
        skipped += 1;
        continue;
      }
      const normalized = row.normalized as unknown as NormalizedRow | null;
      if (!normalized) {
        recheckFailed += 1;
        skipped += 1;
        continue;
      }
      // 复检：预览与确认之间字段定义可能被修改（停用/校验规则变更）
      const recheck = validateRowByMapping(
        fieldDefs,
        batch.mapping as unknown as Record<string, string | null>,
        row.raw as unknown as CellPrimitive[],
      );
      if (recheck.errors.length > 0 || !recheck.normalized) {
        recheckFailed += 1;
        skipped += 1;
        continue;
      }
      await insertLeadWithEvent(
        tx,
        actor,
        recheck.normalized.payload,
        Object.keys(recheck.normalized.customValues).length
          ? (recheck.normalized.customValues as Prisma.InputJsonValue)
          : undefined,
        {
          stageId: defaultStage.id,
          eventType: "imported",
          eventDetail: {
            import: { batchId, rowNo: row.rowNo, filename: batch.filename },
          } as Prisma.InputJsonValue,
        },
      );
      created += 1;
    }
    await tx.importBatch.update({
      where: { id: batchId },
      data: {
        status: "confirmed",
        confirmedAt: new Date(),
        counts: {
          total: rows.length,
          created,
          skipped,
          recheckFailed,
        } as Prisma.InputJsonValue,
      },
    });
  });

  await writeAudit({
    userId: actor.id,
    action: "import.confirmed",
    objectType: "import_batch",
    objectId: batchId,
    detail: {
      filename: batch.filename,
      total: rows.length,
      created,
      skipped,
      recheckFailed,
    },
  });

  return { total: rows.length, created, skipped, recheckFailed };
}
