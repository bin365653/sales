import { LeadStage, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { writeAudit } from "@/server/auth/audit";
import { AuthUser } from "@/lib/auth";
import {
  StageCreateInput,
  StageUpdateInput,
} from "@/lib/schemas/settings";

// 阶段配置服务（T03，实施计划 K2/C02）：
// - 新增（自定义阶段，semanticKey 恒为 null）/ 改名 / 改码 / 排序 / 启停；
// - semanticKey 只随 seed 预置阶段生成，本模块任何路径都不写该列；
// - 停用的阶段不可作为新流转目标（assertStageSelectable），但历史事件与既有线索不受影响；
// - 不可物理删除（产品行为）；已引用阶段的清理只能归档。

export interface StageSnapshotEntry {
  id: string;
  code: string;
  name: string;
  semanticKey: string | null;
}

/** 事件快照：按"事件发生当时"的阶段编码/名称固化，改名改码后历史仍可读（§4.2） */
export function buildStageSnapshot(stage: {
  id: string;
  code: string;
  name: string;
  semanticKey: string | null;
}): StageSnapshotEntry {
  return {
    id: stage.id,
    code: stage.code,
    name: stage.name,
    semanticKey: stage.semanticKey,
  };
}

export async function listStages(options: {
  activeOnly: boolean;
}): Promise<LeadStage[]> {
  return prisma.leadStage.findMany({
    where: options.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
}

export async function getStage(id: string): Promise<LeadStage | null> {
  return prisma.leadStage.findUnique({ where: { id } });
}

export async function getStageBySemanticKey(
  semanticKey: string,
): Promise<LeadStage | null> {
  return prisma.leadStage.findUnique({ where: { semanticKey } });
}

// 编码唯一性由 DB 唯一约束兜底（P2002 → 409），不做存在竞态的前置查询

export async function createStage(
  actor: AuthUser,
  input: StageCreateInput,
): Promise<LeadStage> {
  const maxOrder = await prisma.leadStage.aggregate({
    _max: { sortOrder: true },
  });
  try {
    const stage = await prisma.leadStage.create({
      data: {
        code: input.code,
        name: input.name,
        // 自定义阶段无语义锚点：仅参与漏斗展示与阶段分布，不进指标口径
        semanticKey: null,
        sortOrder: input.sortOrder ?? (maxOrder._max.sortOrder ?? 0) + 1,
        isActive: input.isActive ?? true,
      },
    });
    await writeAudit({
      userId: actor.id,
      action: "settings.stage_created",
      objectType: "lead_stage",
      objectId: stage.id,
      detail: { code: stage.code, name: stage.name },
    });
    return stage;
  } catch (error) {
    throw translateStageWriteError(error, input.code);
  }
}

export async function updateStage(
  actor: AuthUser,
  id: string,
  input: StageUpdateInput,
): Promise<LeadStage> {
  const existing = await getStage(id);
  if (!existing) {
    throw new ApiError(404, "not_found", "阶段不存在");
  }
  try {
    const stage = await prisma.leadStage.update({
      where: { id },
      // 有意不含 semanticKey：不可变
      data: {
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    await writeAudit({
      userId: actor.id,
      action: "settings.stage_updated",
      objectType: "lead_stage",
      objectId: id,
      detail: {
        from: { code: existing.code, name: existing.name, sortOrder: existing.sortOrder, isActive: existing.isActive },
        to: { code: stage.code, name: stage.name, sortOrder: stage.sortOrder, isActive: stage.isActive },
      },
    });
    return stage;
  } catch (error) {
    throw translateStageWriteError(error, input.code ?? existing.code);
  }
}

function translateStageWriteError(error: unknown, code: string): unknown {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return new ApiError(
      409,
      "stage_code_conflict",
      `阶段编码「${code}」已被使用`,
    );
  }
  return error;
}

/**
 * 流转目标校验（T03 验收：停用阶段不可选为新流转目标）：
 * 不存在 → 404；已停用 → 400 stage_inactive。
 */
export async function assertStageSelectable(id: string): Promise<LeadStage> {
  const stage = await getStage(id);
  if (!stage) {
    throw new ApiError(404, "not_found", "目标阶段不存在");
  }
  if (!stage.isActive) {
    throw new ApiError(
      400,
      "stage_inactive",
      `阶段「${stage.name}」已停用，不能作为新的流转目标`,
    );
  }
  return stage;
}
