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
import { applyVerificationWrites } from "@/server/services/lead-verifications";
import type { VerificationWrite } from "@/server/services/lead-verifications";
import { recomputeLeadClassification } from "@/server/services/profile";
import { LEGACY_STATUS_COLUMN_BY_FIELD } from "@/lib/lead-fields";
import { normalizeExpiryInput } from "@/lib/expiry";

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
 * AI 草稿来源校验（T10，§7.1 摘要审核流）：仅接受"本人 + 本线索 + 成功的
 * interaction_summary run"。AI 输出本身只存 ai_runs.output（K3）——写入沟通表
 * 的始终是用户确认后的内容；此处仅登记来源，使原始输出与最终记录可区分。
 * 不合法引用视为请求错误（400），拒绝静默降级。
 */
async function resolveAiDraftRunId(
  tx: Db,
  leadId: string,
  actorId: string,
  aiRunId: string | undefined,
): Promise<string | null> {
  if (!aiRunId) {
    return null;
  }
  const run = await tx.aiRun.findUnique({
    where: { id: aiRunId },
    select: { leadId: true, userId: true, runType: true, status: true },
  });
  if (
    !run ||
    run.leadId !== leadId ||
    run.userId !== actorId ||
    run.runType !== "interaction_summary" ||
    run.status !== "success"
  ) {
    throw new ApiError(
      400,
      "invalid_ai_run",
      "AI 草稿来源记录不合法，请移除来源后保存，或重新生成摘要",
    );
  }
  return aiRunId;
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
  const aiRunId = await resolveAiDraftRunId(tx, lead.id, actorId, input.aiRunId);

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
      aiRunId,
    },
  });

  const advance = await resolveStageAdvance(tx, lead, flags);

  // V2.0（T01/T03）：「本次确认」经核实元数据写入（source=interaction，置 confirmed），
  // 旧状态列同事务镜像（V1.0 读取点不漂移）；
  // T03 扩展：确认即写值（当前系统/新一代/意愿/到期年月），值写入同事务，
  // 并写 updated 事件留痕（from/to/statusFrom/statusTo）。
  const now = new Date();
  const existingVerifications = await tx.leadFieldVerification.findMany({
    where: { leadId: lead.id },
  });
  const statusFromOf = (fieldKey: string): string =>
    existingVerifications.find((row) => row.fieldKey === fieldKey)?.status ??
    (LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey]
      ? String(
          (lead as unknown as Record<string, unknown>)[
            LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey]!
          ] ?? "unknown",
        )
      : "unknown");

  const confirmWrites: VerificationWrite[] = [];
  /** 确认动作带来的线索值写入（驼峰列名） */
  const valueUpdates: Prisma.LeadUncheckedUpdateInput = {};
  /** updated 事件 changed 明细 */
  const changedDetail: Record<
    string,
    { from: unknown; to: unknown; statusFrom: string; statusTo: string }
  > = {};
  const text = (value: unknown) =>
    value === null || value === undefined || value === "" ? null : String(value);
  const bool = (value: unknown) =>
    typeof value === "boolean" ? value : null;
  const date = (value: unknown) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : null;
  /** 登记一次确认动作：核实行 + 旧列镜像 + 事件明细 */
  const buildConfirm = (
    fieldKey: string,
    valueBefore: unknown,
    valueAfter: unknown,
    serialize: (value: unknown) => unknown,
  ): void => {
    confirmWrites.push({
      fieldKey,
      status: "confirmed",
      source: "interaction",
      verifiedBy: actorId,
      verifiedAt: now,
    });
    const legacyColumn = LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey];
    if (legacyColumn) {
      (valueUpdates as Record<string, unknown>)[legacyColumn] = "confirmed";
    }
    changedDetail[fieldKey] = {
      from: serialize(valueBefore),
      to: serialize(valueAfter),
      statusFrom: statusFromOf(fieldKey),
      statusTo: "confirmed",
    };
  };

  if (input.confirmCurrentSystem) {
    // 确认即写值（V2.0 §5 沟通表单）；值为空 = 仅确认既有值（V1.0 兼容）
    const nextValue = input.currentSystemConfirmed ?? null;
    if (nextValue) {
      valueUpdates.currentSystem = nextValue;
    }
    buildConfirm(
      "current_system",
      lead.currentSystem,
      nextValue ?? lead.currentSystem,
      text,
    );
  }
  if (input.confirmPurchaseTime) {
    buildConfirm("purchase_time", lead.purchaseTime, lead.purchaseTime, text);
  }
  if (input.confirmNextGen) {
    const nextValue = input.nextGenConfirmed ?? null;
    valueUpdates.nextGenMobileOrder = nextValue;
    buildConfirm(
      "next_gen_mobile_order",
      lead.nextGenMobileOrder,
      nextValue,
      bool,
    );
  }
  if (input.confirmQinceInterest) {
    const nextValue = input.qinceInterestConfirmed ?? null;
    valueUpdates.qinceInterest = nextValue;
    buildConfirm(
      "qince_interest",
      lead.qinceInterest,
      nextValue,
      bool,
    );
  }
  if (input.confirmExpiry) {
    // 到期输入（Schema 已归一为 YYYY-MM-DD；兜底再走一次归一化兼容 YYYY-MM）
    // → 当月 1 日（@db.Date，P4 月粒度）；2099-12 = 买断
    const monthValue = input.expiryMonthConfirmed ?? null;
    const dayValue = monthValue ? normalizeExpiryInput(monthValue) : null;
    const nextValue = dayValue ? new Date(`${dayValue}T00:00:00.000Z`) : null;
    valueUpdates.contractExpiry = nextValue;
    buildConfirm("contract_expiry", lead.contractExpiry, nextValue, date);
  }

  await bumpLeadForInteraction(tx, lead.id, advance ? lead.stageId : null, {
    // 补录更早的沟通不回退最近联系时间
    lastContactAt:
      !lead.lastContactAt || lead.lastContactAt < occurredAt
        ? occurredAt
        : lead.lastContactAt,
    // 未填写下次联系时间时不改动线索既有计划
    ...(input.nextContactAt ? { nextContactAt } : {}),
    ...valueUpdates,
    ...(advance ? { stageId: advance.toStage.id } : {}),
  });

  if (confirmWrites.length > 0) {
    await applyVerificationWrites(tx, lead.id, confirmWrites);
    // 确认动作留痕：updated 事件（detail.changed 含值与核实状态变化）
    await tx.leadEvent.create({
      data: {
        leadId: lead.id,
        actorId,
        eventType: "updated",
        detail: {
          fields: Object.keys(changedDetail),
          changed: changedDetail,
          source: "interaction",
        } as unknown as Prisma.InputJsonValue,
      },
    });
    // V2.0-T04：确认动作触发象限/完善度重算（quadrant_changed 事件在重算内写）
    await recomputeLeadClassification(tx, lead.id, actorId);
  }

  if (advance) {
    await writeAdvanceEvent(tx, lead.id, actorId, advance, created.id);
  }
  return { interaction: created, advance };
}
