import { DictEntry, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { writeAudit } from "@/server/auth/audit";
import { assertAdmin } from "@/server/permissions";
import {
  DICT_FIELD_KEY_SET,
  DictEntryView,
  isNextGenMeta,
} from "@/lib/dict";
import {
  DictEntryCreateInput,
  DictEntryUpdateInput,
} from "@/lib/schemas/settings";

// 数据字典服务（V2.0-T02，实施计划 §3.1 / 决策 D1）。
//
// 关键不变量：
// - fieldKey 白名单 = DICT_FIELD_KEYS（12 个画像字段），白名单外 404；
// - 写操作仅管理员（路由层 assertAdmin），全部改动写审计；
// - 删除仅提供停用（isActive=false，与阶段管理一致），无物理删除；
// - 值唯一：unique(field_key, value)，重复创建 → 409 dict_value_conflict；
// - 字典启用状态 = lead_field_defs.dict_enabled，存在 ≥1 启用值即启用，
//   每次写入后同步（syncDictEnabledFlag）——校验层只看该布尔，不做联表判断；
// - 字典值就是标准存储值（value 即 leads 列存储值，无独立 label）。

function toView(entry: DictEntry): DictEntryView {
  return {
    id: entry.id,
    value: entry.value,
    meta: (entry.meta as DictEntryView["meta"]) ?? null,
    sortOrder: entry.sortOrder,
    isActive: entry.isActive,
  };
}

function assertDictFieldKey(fieldKey: string): void {
  if (!DICT_FIELD_KEY_SET.has(fieldKey)) {
    throw new ApiError(404, "not_found", "该字段不支持数据字典");
  }
}

/** 字段写入后同步 dict_enabled 旗标（≥1 启用值即启用） */
async function syncDictEnabledFlag(fieldKey: string): Promise<void> {
  const activeCount = await prisma.dictEntry.count({
    where: { fieldKey, isActive: true },
  });
  await prisma.leadFieldDef.updateMany({
    where: { key: fieldKey },
    data: { dictEnabled: activeCount > 0 },
  });
}

// ---------- 查询 ----------

/** 单字段字典（登录即可读：表单 DictSelect 渲染需要） */
export async function listDictEntries(fieldKey: string): Promise<{
  fieldKey: string;
  dictEnabled: boolean;
  entries: DictEntryView[];
}> {
  assertDictFieldKey(fieldKey);
  const [entries, def] = await Promise.all([
    prisma.dictEntry.findMany({
      where: { fieldKey },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    }),
    prisma.leadFieldDef.findUnique({ where: { key: fieldKey } }),
  ]);
  return {
    fieldKey,
    dictEnabled: def?.dictEnabled ?? false,
    entries: entries.map(toView),
  };
}

/** 全部字典字段的一次性读取（表单/详情页渲染用；仅启用值） */
export async function getActiveDictOptionMap(): Promise<
  Map<string, { value: string; isNextGen: boolean }[]>
> {
  const rows = await prisma.dictEntry.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const map = new Map<string, { value: string; isNextGen: boolean }[]>();
  for (const row of rows) {
    const bucket = map.get(row.fieldKey) ?? [];
    bucket.push({ value: row.value, isNextGen: isNextGenMeta(row.meta) });
    map.set(row.fieldKey, bucket);
  }
  return map;
}

/** 字典启用字段的启用值集合（新建/编辑校验用；fieldKey → Set<value>） */
export async function getActiveDictValueMap(): Promise<Map<string, Set<string>>> {
  const rows = await prisma.dictEntry.findMany({
    where: { isActive: true },
    select: { fieldKey: true, value: true },
  });
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    const bucket = map.get(row.fieldKey) ?? new Set<string>();
    bucket.add(row.value);
    map.set(row.fieldKey, bucket);
  }
  return map;
}

/**
 * 字典启用字段的启用值集合（仅 dict_enabled=true 的字段）。
 * 校验口径：dict_enabled=false 或无字典 → 不校验（自由文本）；true → 值必须 ∈ 集合。
 */
export async function getEnabledDictValueMap(): Promise<Map<string, Set<string>>> {
  const [defs, entries] = await Promise.all([
    prisma.leadFieldDef.findMany({
      where: { dictEnabled: true },
      select: { key: true },
    }),
    prisma.dictEntry.findMany({
      where: { isActive: true },
      select: { fieldKey: true, value: true },
    }),
  ]);
  const enabledKeys = new Set(defs.map((def) => def.key));
  const map = new Map<string, Set<string>>();
  for (const row of entries) {
    if (!enabledKeys.has(row.fieldKey)) {
      continue;
    }
    const bucket = map.get(row.fieldKey) ?? new Set<string>();
    bucket.add(row.value);
    map.set(row.fieldKey, bucket);
  }
  return map;
}

// ---------- 写入（管理员） ----------

export async function createDictEntry(
  actor: AuthUser,
  fieldKey: string,
  input: DictEntryCreateInput,
): Promise<DictEntryView> {
  assertAdmin(actor);
  assertDictFieldKey(fieldKey);
  const existing = await prisma.dictEntry.findUnique({
    where: { fieldKey_value: { fieldKey, value: input.value } },
  });
  if (existing) {
    if (existing.isActive) {
      throw new ApiError(409, "dict_value_conflict", "该字典值已存在");
    }
    // 停用过的同值 → 重新启用并应用新排序（不重复占行）
    const revived = await prisma.dictEntry.update({
      where: { id: existing.id },
      data: {
        isActive: true,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.meta !== undefined ? { meta: input.meta as Prisma.InputJsonValue } : {}),
      },
    });
    await syncDictEnabledFlag(fieldKey);
    await writeAudit({
      userId: actor.id,
      action: "dict.entry_created",
      objectType: "dict_entry",
      objectId: revived.id,
      detail: { fieldKey, value: revived.value, reactivated: true },
    });
    return toView(revived);
  }

  const maxSort = await prisma.dictEntry.aggregate({
    where: { fieldKey },
    _max: { sortOrder: true },
  });
  const created = await prisma.dictEntry.create({
    data: {
      fieldKey,
      value: input.value,
      ...(input.meta !== undefined ? { meta: input.meta as Prisma.InputJsonValue } : {}),
      sortOrder: input.sortOrder ?? (maxSort._max.sortOrder ?? 0) + 1,
      createdBy: actor.id,
    },
  });
  await syncDictEnabledFlag(fieldKey);
  await writeAudit({
    userId: actor.id,
    action: "dict.entry_created",
    objectType: "dict_entry",
    objectId: created.id,
    detail: { fieldKey, value: created.value },
  });
  return toView(created);
}

export async function updateDictEntry(
  actor: AuthUser,
  fieldKey: string,
  entryId: string,
  input: DictEntryUpdateInput,
): Promise<DictEntryView> {
  assertAdmin(actor);
  assertDictFieldKey(fieldKey);
  const existing = await prisma.dictEntry.findUnique({ where: { id: entryId } });
  if (!existing || existing.fieldKey !== fieldKey) {
    throw new ApiError(404, "not_found", "字典值不存在");
  }
  if (input.value !== undefined && input.value !== existing.value) {
    // 改值 = 换一个标准存储值：目标值不得与其他条目冲突
    const clash = await prisma.dictEntry.findUnique({
      where: { fieldKey_value: { fieldKey, value: input.value } },
    });
    if (clash) {
      throw new ApiError(409, "dict_value_conflict", "该字典值已存在");
    }
  }
  const updated = await prisma.dictEntry.update({
    where: { id: entryId },
    data: {
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.meta !== undefined ? { meta: input.meta as Prisma.InputJsonValue } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  await syncDictEnabledFlag(fieldKey);
  await writeAudit({
    userId: actor.id,
    action: "dict.entry_updated",
    objectType: "dict_entry",
    objectId: updated.id,
    detail: {
      fieldKey,
      ...(input.value !== undefined && input.value !== existing.value
        ? { from: existing.value, to: input.value }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  return toView(updated);
}

/** 停用（UIUX §5.3：删除仅提供停用，历史数据不受影响） */
export async function deactivateDictEntry(
  actor: AuthUser,
  fieldKey: string,
  entryId: string,
): Promise<void> {
  assertAdmin(actor);
  assertDictFieldKey(fieldKey);
  const existing = await prisma.dictEntry.findUnique({ where: { id: entryId } });
  if (!existing || existing.fieldKey !== fieldKey) {
    throw new ApiError(404, "not_found", "字典值不存在");
  }
  if (!existing.isActive) {
    return;
  }
  await prisma.dictEntry.update({
    where: { id: entryId },
    data: { isActive: false },
  });
  await syncDictEnabledFlag(fieldKey);
  await writeAudit({
    userId: actor.id,
    action: "dict.entry_deactivated",
    objectType: "dict_entry",
    objectId: existing.id,
    detail: { fieldKey, value: existing.value },
  });
}
