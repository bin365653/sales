import { Prisma } from "@prisma/client";
import JSZip from "jszip";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { writeAudit } from "@/server/auth/audit";
import { AuthUser } from "@/lib/auth";
import { toShanghaiDateTimeString } from "@/lib/format";
import { TASK_STATUS_LABELS, TASK_TYPE_LABELS } from "@/lib/tasks";
import { LeadListQuery } from "@/lib/schemas/lead";
import { LeadsExportCreateInput } from "@/lib/schemas/import";
import { CHANNEL_LABELS, DIRECTION_LABELS } from "@/lib/schemas/interaction";
import { RUN_STATUS_LABELS, RUN_TYPE_LABELS } from "@/lib/schemas/ai";
import {
  buildCsvContent,
  buildLeadExportTable,
  buildXlsxContent,
  escapeFormulaCell,
} from "@/lib/import/export-format";
import { buildLeadListWhere } from "@/server/services/leads";

// 导出服务（T05，实施计划 §6 导出端点 / §8.1 导出限流 5 次/小时）。
//
// 关键不变量：
// - 列表导出的行集合 = buildLeadListWhere（与线索池列表同一构造器）→
//   "导出范围正确"由同一段代码保证，销售只含本人数据、管理员含全量（§8.2）；
// - 个人全量导出（/api/exports/me）恒为"本人创建的客户"（与管理员身份无关），
//   V1.0 含客户 XLSX+CSV；沟通记录自 T06、任务自 T07、AI 记录自 T08 落表并入
//   （含软删除客户的记录，M1 历史不丢）；
// - 所有导出走 export_files 落库 + 24 小时过期 + 每用户 5 次/小时限流 + 审计；
// - 公式注入转义在 buildLeadExportTable 内完成（XLSX 与 CSV 同一规则），
//   沟通记录 CSV 的文本单元格在拼行时同样转义。

const EXPORT_RATE_MAX = 5;
const EXPORT_RATE_WINDOW_MS = 60 * 60 * 1000;
const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------- 限流（§8.1：5 次/小时/用户；内存滑动窗口，同登录限流实现模式） ----------

export interface ExportRateLimiter {
  record(userId: string): boolean;
}

export function createExportRateLimiter(
  options: { max?: number; windowMs?: number; now?: () => number } = {},
): ExportRateLimiter {
  const max = options.max ?? EXPORT_RATE_MAX;
  const windowMs = options.windowMs ?? EXPORT_RATE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const history = new Map<string, number[]>();

  return {
    record(userId: string): boolean {
      const current = now();
      const timestamps = (history.get(userId) ?? []).filter(
        (time) => current - time < windowMs,
      );
      if (timestamps.length >= max) {
        history.set(userId, timestamps);
        return false;
      }
      timestamps.push(current);
      history.set(userId, timestamps);
      if (history.size > 10_000) {
        for (const [key, times] of history) {
          if (times.every((time) => current - time >= windowMs)) {
            history.delete(key);
          }
        }
      }
      return true;
    },
  };
}

const globalForRateLimit = globalThis as unknown as {
  exportRateLimiter?: ExportRateLimiter;
};

export const exportRateLimiter =
  globalForRateLimit.exportRateLimiter ?? createExportRateLimiter();

if (process.env.NODE_ENV !== "production") {
  globalForRateLimit.exportRateLimiter = exportRateLimiter;
}

// ---------- 组装导出表 ----------

interface ExportSourceRow {
  lead: Prisma.LeadGetPayload<Record<string, never>>;
  ctx: {
    stageName: string;
    ownerName: string;
    customValues: Record<string, unknown> | null;
  };
}

async function loadExportSourceRows(
  where: Prisma.LeadWhereInput,
): Promise<ExportSourceRow[]> {
  const leads = await prisma.lead.findMany({
    where,
    include: { stage: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  const ownerIds = [...new Set(leads.map((lead) => lead.ownerId))];
  const owners = ownerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, name: true },
      })
    : [];
  const ownerNameById = new Map(owners.map((owner) => [owner.id, owner.name]));
  return leads.map((lead) => ({
    lead,
    ctx: {
      stageName: lead.stage.name,
      ownerName: ownerNameById.get(lead.ownerId) ?? "未知",
      customValues: (lead.customValues as Record<string, unknown> | null) ?? null,
    },
  }));
}

async function buildLeadFileBytes(
  rows: ExportSourceRow[],
  format: "xlsx" | "csv",
): Promise<{ bytes: Buffer; contentType: string }> {
  const customDefs = await prisma.leadFieldDef.findMany({
    where: { isBuiltin: false },
    orderBy: { sortOrder: "asc" },
    select: { key: true, label: true },
  });
  const table = buildLeadExportTable(rows, customDefs);
  if (format === "csv") {
    return {
      bytes: Buffer.from(buildCsvContent(table.headers, table.cells), "utf8"),
      contentType: "text/csv; charset=utf-8",
    };
  }
  return {
    bytes: await buildXlsxContent(table.headers, table.cells, "客户列表"),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function shanghaiStamp(): string {
  return toShanghaiDateTimeString(new Date()).replace(/\D/g, "");
}

async function persistExportFile(
  actor: AuthUser,
  input: {
    kind: "leads" | "me";
    format: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
    filters?: Prisma.InputJsonValue;
    rowCount: number;
  },
): Promise<{ id: string; filename: string }> {
  // 惰性清理已过期导出（无需常驻任务）
  await prisma.exportFile.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const created = await prisma.exportFile.create({
    data: {
      userId: actor.id,
      kind: input.kind,
      format: input.format,
      filename: input.filename,
      contentType: input.contentType,
      content: input.bytes as unknown as Uint8Array<ArrayBuffer>,
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
    },
  });
  await writeAudit({
    userId: actor.id,
    action: "export.created",
    objectType: "export_file",
    objectId: created.id,
    detail: {
      kind: input.kind,
      format: input.format,
      filename: input.filename,
      rows: input.rowCount,
      ...(input.filters !== undefined ? { filters: input.filters } : {}),
    },
  });
  return { id: created.id, filename: created.filename };
}

function assertRateAllowed(actor: AuthUser): void {
  if (!exportRateLimiter.record(actor.id)) {
    throw new ApiError(
      429,
      "rate_limited",
      "导出过于频繁（每小时最多 5 次），请稍后再试",
    );
  }
}

// ---------- 列表导出（POST /api/exports/leads） ----------

export interface ExportCreateResult {
  id: string;
  filename: string;
  rowCount: number;
  downloadPath: string;
}

export async function createLeadsExport(
  actor: AuthUser,
  input: LeadsExportCreateInput,
): Promise<ExportCreateResult> {
  assertRateAllowed(actor);
  const filters = input.filters ?? ({} as LeadListQuery);
  const rows = await loadExportSourceRows(buildLeadListWhere(actor, filters));
  const { bytes, contentType } = await buildLeadFileBytes(rows, input.format);
  const filename = `客户导出_${shanghaiStamp()}.${input.format}`;
  const { id } = await persistExportFile(actor, {
    kind: "leads",
    format: input.format,
    filename,
    contentType,
    bytes,
    filters: filters as Prisma.InputJsonValue,
    rowCount: rows.length,
  });
  return { id, filename, rowCount: rows.length, downloadPath: `/api/exports/${id}/download` };
}

// ---------- 个人全量导出（POST /api/exports/me） ----------

/** 沟通记录 CSV（M9 个人全量，T06 并入）：含软删除客户的沟通，按沟通时间正序 */
async function buildMyInteractionsCsv(userId: string): Promise<string> {
  const rows = await prisma.interaction.findMany({
    where: { lead: { ownerId: userId } },
    include: { lead: { select: { name: true } } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const recorderIds = [...new Set(rows.map((row) => row.userId))];
  const recorders = recorderIds.length
    ? await prisma.user.findMany({
        where: { id: { in: recorderIds } },
        select: { id: true, name: true },
      })
    : [];
  const recorderNameById = new Map(recorders.map((user) => [user.id, user.name]));

  const headers = [
    "沟通时间",
    "客户名称",
    "沟通渠道",
    "方向",
    "是否接通",
    "是否有效沟通",
    "客户实际反馈",
    "已确认业务痛点",
    "客户当前系统",
    "采购时间",
    "决策人情况",
    "主要异议",
    "下一步动作",
    "下次联系时间",
    "形成合格线索",
    "预约演示/拜访",
    "记录人",
    "修正次数",
  ];
  const cells = rows.map((row) =>
    [
      toShanghaiDateTimeString(row.occurredAt),
      row.lead.name,
      CHANNEL_LABELS[row.channel],
      DIRECTION_LABELS[row.direction],
      row.connected ? "是" : "否",
      row.effective ? "是" : "否",
      row.feedback ?? "",
      row.confirmedPains ?? "",
      row.currentSystemConfirmed ?? "",
      row.purchaseTimeConfirmed ?? "",
      row.decisionMakerNote ?? "",
      row.objections ?? "",
      row.nextAction ?? "",
      row.nextContactAt ? toShanghaiDateTimeString(row.nextContactAt) : "",
      row.isQualified ? "是" : "否",
      row.demoBooked ? "是" : "否",
      recorderNameById.get(row.userId) ?? "未知",
      String(Array.isArray(row.editAudit) ? row.editAudit.length : 0),
    ].map((cell) => escapeFormulaCell(cell)),
  );
  return buildCsvContent(headers, cells);
}

/** 任务 CSV（M9 个人全量，T07 并入）：含软删除客户的任务，按截止时间正序 */
async function buildMyTasksCsv(userId: string): Promise<string> {
  const rows = await prisma.task.findMany({
    where: { lead: { ownerId: userId } },
    include: {
      lead: { select: { name: true } },
      interaction: { select: { occurredAt: true } },
    },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });

  const headers = [
    "任务标题",
    "客户名称",
    "任务类型",
    "截止时间",
    "状态",
    "完成时间",
    "完成时沟通时间",
    "备注",
  ];
  const cells = rows.map((row) =>
    [
      row.title,
      row.lead.name,
      TASK_TYPE_LABELS[row.type],
      toShanghaiDateTimeString(row.dueAt),
      TASK_STATUS_LABELS[row.status],
      row.completedAt ? toShanghaiDateTimeString(row.completedAt) : "",
      row.interaction ? toShanghaiDateTimeString(row.interaction.occurredAt) : "",
      row.remark ?? "",
    ].map((cell) => escapeFormulaCell(cell)),
  );
  return buildCsvContent(headers, cells);
}

/** AI 记录 CSV（M9 个人全量，T08 并入）：含软删除客户的 AI 调用留痕，按时间倒序。
 *  只含状态元数据与错误摘要——不导出输入快照/输出 JSON（PRD §6.9 最小化；详情页可查看）。 */
async function buildMyAiRunsCsv(userId: string): Promise<string> {
  const runs = await prisma.aiRun.findMany({
    where: { lead: { ownerId: userId } },
    include: {
      lead: { select: { name: true } },
      modelConfig: { select: { provider: true, modelName: true } },
      promptVersion: { select: { version: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });

  const headers = [
    "发起时间",
    "客户名称",
    "AI 任务类型",
    "服务商",
    "模型",
    "提示词版本",
    "状态",
    "错误类型",
    "错误信息",
    "耗时(ms)",
    "输入数据版本",
    "重试自",
  ];
  const cells = runs.map((run) =>
    [
      toShanghaiDateTimeString(run.createdAt),
      run.lead.name,
      RUN_TYPE_LABELS[run.runType],
      run.modelConfig.provider,
      run.modelConfig.modelName,
      `v${run.promptVersion.version}`,
      RUN_STATUS_LABELS[run.status],
      run.errorType ?? "",
      run.errorMessage ?? "",
      run.durationMs === null ? "" : String(run.durationMs),
      String(run.inputDataVersion),
      run.retryOfId ?? "",
    ].map((cell) => escapeFormulaCell(cell)),
  );
  return buildCsvContent(headers, cells);
}

export async function createMyDataExport(
  actor: AuthUser,
): Promise<ExportCreateResult> {
  assertRateAllowed(actor);
  // 个人全量 = 本人名下全部客户（含已筛选外），与角色无关（§5.11 个人数据管理）
  const rows = await loadExportSourceRows({
    ownerId: actor.id,
    deletedAt: null,
  });
  const [xlsx, csv, interactionsCsv, tasksCsv, aiRunsCsv] = await Promise.all([
    buildLeadFileBytes(rows, "xlsx"),
    buildLeadFileBytes(rows, "csv"),
    buildMyInteractionsCsv(actor.id),
    buildMyTasksCsv(actor.id),
    buildMyAiRunsCsv(actor.id),
  ]);
  const zip = new JSZip();
  zip.file("客户全量.xlsx", xlsx.bytes);
  zip.file("客户全量.csv", csv.bytes);
  zip.file("沟通记录.csv", interactionsCsv);
  zip.file("任务.csv", tasksCsv);
  zip.file("AI记录.csv", aiRunsCsv);
  const zipped = await zip.generateAsync({ type: "nodebuffer" });
  const filename = `我的全量数据_${shanghaiStamp()}.zip`;
  const { id } = await persistExportFile(actor, {
    kind: "me",
    format: "zip",
    filename,
    contentType: "application/zip",
    bytes: zipped,
    rowCount: rows.length,
  });
  return { id, filename, rowCount: rows.length, downloadPath: `/api/exports/${id}/download` };
}

// ---------- 下载（GET /api/exports/:id/download） ----------

export interface ExportFileContent {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

export async function getExportFile(
  actor: AuthUser,
  id: string,
): Promise<ExportFileContent> {
  const file = await prisma.exportFile.findUnique({ where: { id } });
  // 他人导出 / 不存在 / 已过期统一 404，不区分暴露存在性
  if (
    !file ||
    file.userId !== actor.id ||
    file.expiresAt.getTime() < Date.now()
  ) {
    throw new ApiError(404, "not_found", "导出文件不存在或已过期");
  }
  return {
    filename: file.filename,
    contentType: file.contentType,
    bytes: Buffer.from(file.content),
  };
}
