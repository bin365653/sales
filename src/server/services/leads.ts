import { Lead, LeadStage, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { writeAudit } from "@/server/auth/audit";
import { AuthUser } from "@/lib/auth";
import { NEW_LEAD_STAGE_ANCHOR } from "@/lib/stages";
import { findInactiveBuiltinKeys } from "@/lib/lead-field-validation";
import { providedBuiltinKeys, parseShanghaiDate } from "@/lib/schemas/lead";
import {
  LeadCreateInput,
  LeadListQuery,
  LeadStageTransitionInput,
  LeadUpdateInput,
} from "@/lib/schemas/lead";
import {
  assertStageSelectable,
  buildStageSnapshot,
  getStage,
  getStageBySemanticKey,
} from "@/server/services/stages";
import { assertLeadReadable, assertLeadWritable, leadReadScope } from "@/server/permissions";
import { validateCustomValues, FieldDefLike, FieldIssue } from "@/lib/lead-field-validation";

// 线索服务（T03）：新建/编辑/详情/软删除/阶段流转/列表。
// 关键不变量：
// - 所有读写经 permissions 层（越权一律 404，§8.2）；
// - 软删除（deleted_at），lead_events 只追加；
// - 编辑与阶段流转带 dataVersion 乐观并发控制（§4.1）；
// - 阶段变更必须写 lead_events（前后阶段 UUID + 当时编码/名称快照，PRD §5.8）；
// - 停用阶段不可作为新流转目标；线索当前处于停用阶段不受影响；
// - 自定义字段值先经字段定义校验引擎，再入 custom_values；
// - 已停用内置字段出现在提交中 → 拒绝（不静默丢弃）。

type Db = Prisma.TransactionClient | typeof prisma;

// ---------- 字段配置校验（内置停用 + 自定义值） ----------

interface FieldDefSet {
  builtin: { key: string; label: string; isActive: boolean }[];
  activeCustom: FieldDefLike[];
  archivedCustomKeys: Set<string>;
  activeCustomKeys: Set<string>;
}

async function loadFieldDefSet(): Promise<FieldDefSet> {
  const defs = await prisma.leadFieldDef.findMany();
  return {
    builtin: defs
      .filter((def) => def.isBuiltin)
      .map((def) => ({ key: def.key, label: def.label, isActive: def.isActive })),
    activeCustom: defs
      .filter((def) => !def.isBuiltin && def.isActive)
      .map((def) => ({
        key: def.key,
        type: def.type as FieldDefLike["type"],
        options: def.options,
        validation: def.validation,
      })),
    activeCustomKeys: new Set(defs.filter((def) => !def.isBuiltin && def.isActive).map((def) => def.key)),
    archivedCustomKeys: new Set(defs.filter((def) => !def.isBuiltin && !def.isActive).map((def) => def.key)),
  };
}

function assertBuiltinFieldsProvidable(
  defSet: FieldDefSet,
  providedKeys: string[],
): void {
  const violated = findInactiveBuiltinKeys(defSet.builtin, providedKeys);
  if (violated.length > 0) {
    const labels = violated.map(
      (key) => defSet.builtin.find((def) => def.key === key)?.label ?? key,
    );
    throw new ApiError(
      400,
      "field_disabled",
      `字段「${labels.join("、")}」已停用，不能提交`,
    );
  }
}

/** 引擎校验 + 停用/未知自定义字段检查，返回可直接入库的合法值 */
function checkCustomValues(
  defSet: FieldDefSet,
  rawValues: Record<string, unknown>,
  requireAll: boolean,
): { values: Record<string, string | number>; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const engineInput: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (defSet.activeCustomKeys.has(key)) {
      engineInput[key] = value;
      continue;
    }
    const nonEmpty = value !== null && value !== undefined && value !== "";
    if (nonEmpty && defSet.archivedCustomKeys.has(key)) {
      issues.push({ key, message: "字段已停用，不能提交" });
    } else if (nonEmpty && !defSet.activeCustomKeys.has(key)) {
      issues.push({ key, message: "未知自定义字段" });
    }
    // 清空值（null）对停用/未知字段直接忽略，不产生错误
  }
  const result = validateCustomValues(defSet.activeCustom, engineInput, { requireAll });
  return { values: result.values, issues: [...issues, ...result.issues] };
}

function throwCustomIssues(issues: FieldIssue[]): void {
  if (issues.length === 0) {
    return;
  }
  const rendered = issues
    .slice(0, 5)
    .map((issue) => `${issue.key}：${issue.message}`)
    .join("；");
  throw new ApiError(
    400,
    "custom_field_invalid",
    `自定义字段校验未通过（${rendered}${issues.length > 5 ? " 等" : ""}）`,
  );
}

// ---------- 数据映射（camelCase 入参 → Prisma 列） ----------

/**
 * 本地日期时间（无时区后缀）统一按 Asia/Shanghai（+08:00）解释（决策 C13）。
 * 仅用于 timestamptz 列（next_contact_at）。
 */
function datetimeOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : parseShanghaiDate(value);
}

/**
 * 纯日期列（contract_expiry @db.Date）：按 UTC 日期解析（"2027-03-31" → 当日）。
 * 不能用 +08:00 解释——PG 驱动按 UTC 摘取日期部分，+08:00 会回退一天。
 */
function dateOnlyOrNull(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new Date(`${value}T00:00:00Z`);
}

function createScalarData(
  input: LeadCreateInput,
): Omit<Prisma.LeadUncheckedCreateInput, "stageId" | "ownerId" | "customValues" | "dataVersion"> {
  return {
    name: input.name,
    city: input.city ?? null,
    industry: input.industry ?? null,
    mainCategory: input.mainCategory ?? null,
    contactName: input.contactName ?? null,
    contactTitle: input.contactTitle ?? null,
    contactPhone: input.contactPhone ?? null,
    source: input.source ?? null,
    salesTeamSize: input.salesTeamSize ?? null,
    revenueRange: input.revenueRange ?? null,
    salesMode: input.salesMode ?? null,
    currentSystem: input.currentSystem ?? null,
    systemModules: input.systemModules ?? null,
    contractExpiry: dateOnlyOrNull(input.contractExpiry) ?? null,
    knownPains: input.knownPains ?? null,
    consideringSwitch: input.consideringSwitch ?? null,
    hasClearDemand: input.hasClearDemand ?? null,
    purchaseTime: input.purchaseTime ?? null,
    budget: input.budget ?? null,
    decisionMaker: input.decisionMaker ?? null,
    decisionProcess: input.decisionProcess ?? null,
    mainConcerns: input.mainConcerns ?? null,
    currentSystemStatus: input.currentSystemStatus ?? "unknown",
    contractExpiryStatus: input.contractExpiryStatus ?? "unknown",
    purchaseTimeStatus: input.purchaseTimeStatus ?? "unknown",
    decisionMakerStatus: input.decisionMakerStatus ?? "unknown",
    priority: input.priority ?? "mid",
    nextContactAt: datetimeOrNull(input.nextContactAt) ?? null,
    remark: input.remark ?? null,
  };
}

/** undefined = 不修改；null = 显式清空；Prisma 对 undefined 字段自动跳过 */
function updateScalarData(
  input: LeadUpdateInput,
): Prisma.LeadUncheckedUpdateInput {
  const data: Prisma.LeadUpdateInput = {};
  if (input.name !== undefined) {
    data.name = input.name;
  }
  if (input.city !== undefined) {
    data.city = input.city;
  }
  if (input.industry !== undefined) {
    data.industry = input.industry;
  }
  if (input.mainCategory !== undefined) {
    data.mainCategory = input.mainCategory;
  }
  if (input.contactName !== undefined) {
    data.contactName = input.contactName;
  }
  if (input.contactTitle !== undefined) {
    data.contactTitle = input.contactTitle;
  }
  if (input.contactPhone !== undefined) {
    data.contactPhone = input.contactPhone;
  }
  if (input.source !== undefined) {
    data.source = input.source;
  }
  if (input.salesTeamSize !== undefined) {
    data.salesTeamSize = input.salesTeamSize;
  }
  if (input.revenueRange !== undefined) {
    data.revenueRange = input.revenueRange;
  }
  if (input.salesMode !== undefined) {
    data.salesMode = input.salesMode;
  }
  if (input.currentSystem !== undefined) {
    data.currentSystem = input.currentSystem;
  }
  if (input.systemModules !== undefined) {
    data.systemModules = input.systemModules;
  }
  if (input.contractExpiry !== undefined) {
    data.contractExpiry = dateOnlyOrNull(input.contractExpiry);
  }
  if (input.knownPains !== undefined) {
    data.knownPains = input.knownPains;
  }
  if (input.consideringSwitch !== undefined) {
    data.consideringSwitch = input.consideringSwitch;
  }
  if (input.hasClearDemand !== undefined) {
    data.hasClearDemand = input.hasClearDemand;
  }
  if (input.purchaseTime !== undefined) {
    data.purchaseTime = input.purchaseTime;
  }
  if (input.budget !== undefined) {
    data.budget = input.budget;
  }
  if (input.decisionMaker !== undefined) {
    data.decisionMaker = input.decisionMaker;
  }
  if (input.decisionProcess !== undefined) {
    data.decisionProcess = input.decisionProcess;
  }
  if (input.mainConcerns !== undefined) {
    data.mainConcerns = input.mainConcerns;
  }
  if (input.currentSystemStatus !== undefined) {
    data.currentSystemStatus = input.currentSystemStatus;
  }
  if (input.contractExpiryStatus !== undefined) {
    data.contractExpiryStatus = input.contractExpiryStatus;
  }
  if (input.purchaseTimeStatus !== undefined) {
    data.purchaseTimeStatus = input.purchaseTimeStatus;
  }
  if (input.decisionMakerStatus !== undefined) {
    data.decisionMakerStatus = input.decisionMakerStatus;
  }
  if (input.priority !== undefined) {
    data.priority = input.priority;
  }
  if (input.nextContactAt !== undefined) {
    data.nextContactAt = datetimeOrNull(input.nextContactAt);
  }
  if (input.remark !== undefined) {
    data.remark = input.remark;
  }
  return data;
}

// ---------- 读取 ----------

async function loadActiveLeadOrThrow(id: string): Promise<Lead> {
  const lead = await prisma.lead.findFirst({
    where: { id, deletedAt: null },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  return lead;
}

export interface LeadDetail {
  lead: Lead & { stage: LeadStage };
  events: {
    id: string;
    eventType: string;
    fromStageId: string | null;
    toStageId: string | null;
    stageSnapshot: unknown;
    detail: unknown;
    actorId: string | null;
    occurredAt: Date;
  }[];
}

export async function getLeadDetail(
  actor: AuthUser,
  id: string,
): Promise<LeadDetail> {
  const lead = await loadActiveLeadOrThrow(id);
  assertLeadReadable(actor, lead.ownerId);
  const [withStage, events] = await Promise.all([
    prisma.lead.findUniqueOrThrow({
      where: { id },
      include: { stage: true },
    }),
    prisma.leadEvent.findMany({
      where: { leadId: id },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return { lead: withStage, events };
}

// ---------- 新建 ----------

export async function createLead(
  actor: AuthUser,
  input: LeadCreateInput,
): Promise<Lead & { stage: LeadStage }> {
  const defSet = await loadFieldDefSet();
  assertBuiltinFieldsProvidable(defSet, providedBuiltinKeys(input));

  const stage = input.stageId
    ? await assertStageSelectable(input.stageId)
    : await resolveDefaultStage();

  const custom = checkCustomValues(defSet, input.customValues ?? {}, true);
  throwCustomIssues(custom.issues);

  const customValues = Object.keys(custom.values).length
    ? (custom.values as Prisma.InputJsonValue)
    : undefined;

  const created = await prisma.$transaction(async (tx) => {
    const lead = await tx.lead.create({
      data: {
        ...createScalarData(input),
        stageId: stage.id,
        ownerId: actor.id,
        customValues,
        dataVersion: 1,
      },
    });
    await tx.leadEvent.create({
      data: {
        leadId: lead.id,
        actorId: actor.id,
        eventType: "created",
        toStageId: stage.id,
        stageSnapshot: {
          to: buildStageSnapshot(stage),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return lead;
  });

  return prisma.lead.findUniqueOrThrow({
    where: { id: created.id },
    include: { stage: true },
  });
}

async function resolveDefaultStage(): Promise<LeadStage> {
  const stage = await getStageBySemanticKey(NEW_LEAD_STAGE_ANCHOR);
  if (!stage || !stage.isActive) {
    throw new ApiError(
      400,
      "default_stage_unavailable",
      "默认阶段「新线索」不可用，请显式指定客户阶段",
    );
  }
  return stage;
}

// ---------- 编辑（局部更新 + 乐观并发） ----------

export async function updateLead(
  actor: AuthUser,
  id: string,
  input: LeadUpdateInput,
): Promise<Lead & { stage: LeadStage }> {
  const existing = await loadActiveLeadOrThrow(id);
  assertLeadWritable(actor, existing.ownerId);

  const defSet = await loadFieldDefSet();
  assertBuiltinFieldsProvidable(defSet, providedBuiltinKeys(input));

  const providedCustom = input.customValues ?? {};
  const custom = checkCustomValues(defSet, providedCustom, false);
  throwCustomIssues(custom.issues);

  // 合并语义：提交键先移除（null = 清空），再回填本次合法值；未触及键保持原值
  const stored = (existing.customValues ?? {}) as Record<string, unknown>;
  const merged: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === "string" || typeof value === "number") {
      merged[key] = value;
    }
  }
  for (const key of Object.keys(providedCustom)) {
    delete merged[key];
  }
  Object.assign(merged, custom.values);

  const scalar = updateScalarData(input);
  const toSnakeCase = (key: string) =>
    key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  const changedKeys = [
    ...Object.keys(scalar).map(toSnakeCase),
    ...Object.keys(providedCustom).map((key) => `custom:${key}`),
  ];

  await prisma.$transaction(async (tx) => {
    // 期望版本取客户端提交值（乐观并发）；existing 仅用于存在性与权限校验
    const updated = await conditionalBump(tx, id, input.dataVersion, {
      ...scalar,
      customValues: Object.keys(merged).length
        ? (merged as Prisma.InputJsonValue)
        : Prisma.DbNull,
    });
    if (!updated) {
      await raiseVersionConflictOr404(tx, id);
    }
    if (changedKeys.length > 0) {
      // detail 只记字段名，不记值（客户数据最小化落日志，§8.3）
      await tx.leadEvent.create({
        data: {
          leadId: id,
          actorId: actor.id,
          eventType: "updated",
          detail: { fields: changedKeys } as Prisma.InputJsonValue,
        },
      });
    }
  });

  return prisma.lead.findUniqueOrThrow({
    where: { id },
    include: { stage: true },
  });
}

// ---------- 阶段流转（PATCH /api/leads/:id/stage） ----------

export async function transitionStage(
  actor: AuthUser,
  id: string,
  input: LeadStageTransitionInput,
): Promise<{ changed: boolean; lead: Lead & { stage: LeadStage } }> {
  const existing = await loadActiveLeadOrThrow(id);
  assertLeadWritable(actor, existing.ownerId);

  const target = await assertStageSelectable(input.stageId);

  if (target.id === existing.stageId) {
    return {
      changed: false,
      lead: await prisma.lead.findUniqueOrThrow({
        where: { id },
        include: { stage: true },
      }),
    };
  }

  const fromStage = await getStage(existing.stageId);
  if (!fromStage) {
    // 当前阶段行被异常删除：外键仍在（lead_events 不可删），保守拒绝流转
    throw new ApiError(409, "stage_missing", "线索当前阶段数据异常，请联系管理员");
  }

  await prisma.$transaction(async (tx) => {
    const updated = await conditionalBump(tx, id, input.dataVersion, {
      stageId: target.id,
    });
    if (!updated) {
      await raiseVersionConflictOr404(tx, id);
    }
    await tx.leadEvent.create({
      data: {
        leadId: id,
        actorId: actor.id,
        eventType: "stage_changed",
        fromStageId: fromStage.id,
        toStageId: target.id,
        stageSnapshot: {
          from: buildStageSnapshot(fromStage),
          to: buildStageSnapshot(target),
        } as unknown as Prisma.InputJsonValue,
      },
    });
  });

  return {
    changed: true,
    lead: await prisma.lead.findUniqueOrThrow({
      where: { id },
      include: { stage: true },
    }),
  };
}

// ---------- 软删除 ----------

export async function softDeleteLead(actor: AuthUser, id: string): Promise<void> {
  const existing = await loadActiveLeadOrThrow(id);
  assertLeadWritable(actor, existing.ownerId);

  await prisma.$transaction(async (tx) => {
    await tx.lead.updateMany({
      where: { id, deletedAt: null },
      data: {
        deletedAt: new Date(),
        dataVersion: { increment: 1 },
      },
    });
    await tx.leadEvent.create({
      data: {
        leadId: id,
        actorId: actor.id,
        eventType: "deleted",
      },
    });
  });
  await writeAudit({
    userId: actor.id,
    action: "lead.deleted",
    objectType: "lead",
    objectId: id,
    detail: { name: existing.name },
  });
}

// ---------- 列表（组合筛选 / 关键词 / 分页） ----------

export async function listLeads(
  actor: AuthUser,
  query: LeadListQuery,
): Promise<{
  items: (Lead & { stage: LeadStage })[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const scope = leadReadScope(actor);
  // 销售的 ownerId 筛选参数无效（其范围已强制本人）；管理员按负责人筛选生效
  const ownerIdFilter =
    actor.role === "admin" && query.ownerId ? query.ownerId : scope.ownerId;

  const where: Prisma.LeadWhereInput = {
    deletedAt: null,
    ...(ownerIdFilter ? { ownerId: ownerIdFilter } : {}),
    ...(query.keyword
      ? {
          OR: [
            { name: { contains: query.keyword, mode: "insensitive" } },
            { contactName: { contains: query.keyword, mode: "insensitive" } },
            { contactPhone: { contains: query.keyword } },
          ],
        }
      : {}),
    ...(query.city ? { city: query.city } : {}),
    ...(query.industry ? { industry: query.industry } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.salesMode ? { salesMode: query.salesMode } : {}),
    ...(query.currentSystem ? { currentSystem: query.currentSystem } : {}),
    ...(query.stageId ? { stageId: query.stageId } : {}),
    ...(query.priority ? { priority: query.priority } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      include: { stage: true },
      orderBy: [{ updatedAt: "desc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.lead.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

// ---------- 乐观并发辅助 ----------

/** 条件更新：dataVersion 匹配且未删除才写入并 +1；返回是否命中 */
async function conditionalBump(
  tx: Db,
  id: string,
  expectedVersion: number,
  data: Prisma.LeadUncheckedUpdateInput,
): Promise<boolean> {
  const result = await tx.lead.updateMany({
    where: { id, dataVersion: expectedVersion, deletedAt: null },
    data: { ...data, dataVersion: { increment: 1 } },
  });
  return result.count === 1;
}

async function raiseVersionConflictOr404(tx: Db, id: string): Promise<never> {
  const current = await tx.lead.findFirst({ where: { id } });
  if (!current || current.deletedAt !== null) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  throw new ApiError(
    409,
    "version_conflict",
    "数据已被其他操作修改，请刷新后重试",
  );
}
