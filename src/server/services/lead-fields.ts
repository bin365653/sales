import { LeadFieldDef, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { writeAudit } from "@/server/auth/audit";
import { AuthUser } from "@/lib/auth";
import { BUILTIN_LEAD_FIELD_KEYS } from "@/lib/lead-fields";
import {
  FieldDefCreateInput,
  FieldDefUpdateInput,
} from "@/lib/schemas/settings";

// 线索字段定义服务（T03，实施计划 §4.4 / M4 / C12）：
// - 内置字段定义由 seed 生成（key = leads 物理列名），此处仅允许改 label/排序/启停；
// - 自定义字段允许新建与修改（key、type 不可变），值校验引擎在 lib/lead-field-validation；
// - 已被业务数据使用的字段只能停用（归档），不提供物理删除。

export async function listFieldDefs(options: {
  activeOnly: boolean;
}): Promise<LeadFieldDef[]> {
  return prisma.leadFieldDef.findMany({
    where: options.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function createFieldDef(
  actor: AuthUser,
  input: FieldDefCreateInput,
): Promise<LeadFieldDef> {
  if (BUILTIN_LEAD_FIELD_KEYS.has(input.key)) {
    throw new ApiError(
      409,
      "field_key_conflict",
      `字段标识「${input.key}」与内置字段冲突`,
    );
  }
  const maxOrder = await prisma.leadFieldDef.aggregate({
    _max: { sortOrder: true },
  });
  try {
    const def = await prisma.leadFieldDef.create({
      data: {
        key: input.key,
        label: input.label,
        type: input.type,
        ...(input.options !== undefined
          ? { options: input.options as unknown as Prisma.InputJsonValue }
          : {}),
        ...(input.validation !== undefined
          ? { validation: input.validation as unknown as Prisma.InputJsonValue }
          : {}),
        isBuiltin: false,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
      },
    });
    await writeAudit({
      userId: actor.id,
      action: "settings.field_created",
      objectType: "lead_field_def",
      objectId: def.id,
      detail: { key: def.key, label: def.label, type: def.type },
    });
    return def;
  } catch (error) {
    throw translateFieldWriteError(error, input.key);
  }
}

export async function updateFieldDef(
  actor: AuthUser,
  id: string,
  input: FieldDefUpdateInput,
): Promise<LeadFieldDef> {
  const existing = await prisma.leadFieldDef.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError(404, "not_found", "字段定义不存在");
  }

  // 内置字段：仅展示名/排序/启停可调；其取值校验以 Zod Schema 为唯一事实源
  if (existing.isBuiltin && (input.options !== undefined || input.validation !== undefined)) {
    throw new ApiError(
      400,
      "builtin_field_immutable",
      "内置字段不支持修改选项或校验规则",
    );
  }
  // 客户名称是线索必填主键性字段，停用后新建/编辑无法满足必填约束
  if (existing.key === "name" && input.isActive === false) {
    throw new ApiError(
      400,
      "field_required_core",
      "客户名称为必填核心字段，不能停用",
    );
  }

  const def = await prisma.leadFieldDef.update({
    where: { id },
    // key / type 有意不在更新面：key 是 custom_values 存储键，type 变更会使存量值失效
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.options !== undefined
        ? { options: input.options as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.validation !== undefined
        ? { validation: input.validation as unknown as Prisma.InputJsonValue }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  await writeAudit({
    userId: actor.id,
    action: "settings.field_updated",
    objectType: "lead_field_def",
    objectId: id,
    detail: {
      key: def.key,
      from: { label: existing.label, isActive: existing.isActive, sortOrder: existing.sortOrder },
      to: { label: def.label, isActive: def.isActive, sortOrder: def.sortOrder },
    },
  });
  return def;
}

function translateFieldWriteError(error: unknown, key: string): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return new ApiError(
      409,
      "field_key_conflict",
      `字段标识「${key}」已被使用`,
    );
  }
  return error;
}
