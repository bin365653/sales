import {
  Interaction,
  Lead,
  LeadStage,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { ApiError } from "@/server/http/api";
import { parseShanghaiDate } from "@/lib/schemas/lead";
import { InteractionCreateInput } from "@/lib/schemas/interaction";
import {
  BOOKED_DEMO_STAGE_ANCHOR,
  QUALIFIED_STAGE_ANCHOR,
} from "@/lib/stages";
import { buildStageSnapshot } from "@/server/services/stages";

// 沟通写入事务核心（T06 抽出）：保存沟通记录（POST /api/leads/:id/interactions）
// 与完成任务弹窗（T07 POST /api/tasks/:id/complete-with-interaction）共用同一套
// 副作用实现，保证"沟通 + 线索更新 + K4 阶段联动"口径只有一份。
//
// 关键不变量（与 T06 交付一致）：
// - 必须在调用方的事务内执行（tx），任一步失败整体回滚（§7 原则 5）；
// - K4 推进只进不退：目标阶段启用且排序晚于当前才动作；同时勾选合格与预约
//   推进到排序更远的目标，一次流转一条 stage_changed 事件；
// - last_contact_at = max(现有, 本次)：补录更早的沟通不回退最近联系时间；
// - 线索行按 updateMany 条件更新（未删除 + 未被并发推进阶段），失败 409。

export type Db = Prisma.TransactionClient | PrismaClient;

export interface StageAdvance {
  fromStage: LeadStage;
  toStage: LeadStage;
  triggers: string[];
}

function occurredDateOf(value: string): Date {
  return parseShanghaiDate(value);
}

/**
 * K4 阶段联动目标解析（只读，不写库）：
 * 候选目标 = 勾选项对应的语义锚点阶段；仅当目标存在、启用且排序晚于当前阶段时参与，
 * 取排序最远者（同时勾选合格与预约 → 推进到「已预约演示」）。
 * 目标停用/缺失/不晚于当前 → 返回 null（不自动推进，用户可手动流转）。
 */
export async function resolveStageAdvance(
  tx: Db,
  lead: Lead & { stage: LeadStage },
  flags: { isQualified: boolean; demoBooked: boolean },
): Promise<StageAdvance | null> {
  const candidates: { anchor: string; trigger: string }[] = [];
  if (flags.isQualified) {
    candidates.push({ anchor: QUALIFIED_STAGE_ANCHOR, trigger: "is_qualified" });
  }
  if (flags.demoBooked) {
    candidates.push({ anchor: BOOKED_DEMO_STAGE_ANCHOR, trigger: "demo_booked" });
  }
  let bestStage: LeadStage | null = null;
  let bestTriggers: string[] = [];
  for (const candidate of candidates) {
    const stage = await tx.leadStage.findUnique({
      where: { semanticKey: candidate.anchor },
    });
    if (!stage || !stage.isActive) {
      continue;
    }
    if (stage.sortOrder <= lead.stage.sortOrder) {
      continue;
    }
    if (bestStage && stage.sortOrder <= bestStage.sortOrder) {
      continue;
    }
    bestStage = stage;
    // 同时勾选合格与预约：两个触发都记入同一次流转
    bestTriggers = [...bestTriggers, candidate.trigger];
  }
  if (!bestStage) {
    return null;
  }
  return {
    fromStage: lead.stage,
    toStage: bestStage,
    triggers: bestTriggers,
  };
}

export async function writeAdvanceEvent(
  tx: Db,
  leadId: string,
  actorId: string,
  advance: StageAdvance,
  interactionId: string,
): Promise<void> {
  await tx.leadEvent.create({
    data: {
      leadId,
      actorId,
      eventType: "stage_changed",
      fromStageId: advance.fromStage.id,
      toStageId: advance.toStage.id,
      stageSnapshot: {
        from: buildStageSnapshot(advance.fromStage),
        to: buildStageSnapshot(advance.toStage),
      } as unknown as Prisma.InputJsonValue,
      detail: {
        reason: "interaction_advance",
        interactionId,
        triggers: advance.triggers,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function bumpLeadForInteraction(
  tx: Db,
  leadId: string,
  expectedStageId: string | null,
  data: Prisma.LeadUncheckedUpdateInput,
): Promise<void> {
  const updated = await tx.lead.updateMany({
    where: {
      id: leadId,
      deletedAt: null,
      ...(expectedStageId ? { stageId: expectedStageId } : {}),
    },
    data: { ...data, dataVersion: { increment: 1 } },
  });
  if (updated.count !== 1) {
    throw new ApiError(
      409,
      "version_conflict",
      "数据已被其他操作修改，请刷新后重试",
    );
  }
}

/**
 * 在事务内写入沟通记录及其线索副作用：
 * 记录 + last_contact_at + （可选）next_contact_at + "本次确认"核实状态 +
 * 条件推进阶段（K4）。
 */
export async function applyInteractionWrite(
  tx: Db,
  lead: Lead & { stage: LeadStage },
  actorId: string,
  input: InteractionCreateInput,
): Promise<{ interaction: Interaction; advance: StageAdvance | null }> {
  const occurredAt = occurredDateOf(input.occurredAt);
  const nextContactAt = input.nextContactAt
    ? parseShanghaiDate(input.nextContactAt)
    : null;
  const flags = {
    isQualified: input.isQualified ?? false,
    demoBooked: input.demoBooked ?? false,
  };

  const created = await tx.interaction.create({
    data: {
      leadId: lead.id,
      userId: actorId,
      occurredAt,
      channel: input.channel,
      direction: input.direction,
      connected: input.connected,
      effective: input.effective,
      feedback: input.feedback ?? null,
      confirmedPains: input.confirmedPains ?? null,
      currentSystemConfirmed: input.currentSystemConfirmed ?? null,
      purchaseTimeConfirmed: input.purchaseTimeConfirmed ?? null,
      decisionMakerNote: input.decisionMakerNote ?? null,
      objections: input.objections ?? null,
      nextAction: input.nextAction ?? null,
      nextContactAt,
      isQualified: flags.isQualified,
      demoBooked: flags.demoBooked,
    },
  });

  const advance = await resolveStageAdvance(tx, lead, flags);

  await bumpLeadForInteraction(tx, lead.id, advance ? lead.stageId : null, {
    // 补录更早的沟通不回退最近联系时间
    lastContactAt:
      !lead.lastContactAt || lead.lastContactAt < occurredAt
        ? occurredAt
        : lead.lastContactAt,
    // 未填写下次联系时间时不改动线索既有计划
    ...(input.nextContactAt ? { nextContactAt } : {}),
    // "本次确认"（UIUX P5）：人工确认动作 → 画像核实状态置为已确认（不覆盖字段值）
    ...(input.confirmCurrentSystem
      ? { currentSystemStatus: "confirmed" as const }
      : {}),
    ...(input.confirmPurchaseTime
      ? { purchaseTimeStatus: "confirmed" as const }
      : {}),
    ...(advance ? { stageId: advance.toStage.id } : {}),
  });

  if (advance) {
    await writeAdvanceEvent(tx, lead.id, actorId, advance, created.id);
  }
  return { interaction: created, advance };
}
