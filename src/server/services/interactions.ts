import { Interaction, Lead, LeadStage, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { parseShanghaiDate } from "@/lib/schemas/lead";
import {
  InteractionCreateInput,
  InteractionUpdateInput,
} from "@/lib/schemas/interaction";
import {
  BOOKED_DEMO_STAGE_ANCHOR,
  QUALIFIED_STAGE_ANCHOR,
} from "@/lib/stages";
import { assertLeadReadable, assertLeadWritable } from "@/server/permissions";
import { buildStageSnapshot } from "@/server/services/stages";

// 沟通记录服务（T06，PRD §5.6 / K4 / M11）。
// 关键不变量：
// - 保存为单事务：沟通记录 + last_contact_at + （可选）next_contact_at +
//   "本次确认"核实状态 + 条件推进阶段（K4）——任一步失败全部回滚（§7 原则 5）；
// - K4 推进只进不退：当前阶段排序不早于目标（或目标停用/缺失）时不动作；
//   同时勾选合格与预约时推进到排序更远的目标，一次流转一条 stage_changed 事件；
// - 可见性经线索归属判定（§4.4）：本表不存归属冗余列，读写都过 permissions 层；
// - 沟通记录只追加、不可删除（M1）；修正不改写历史值，edit_audit 追加
//   {at, by, changed:{field:{from,to}}}（M11：谁、何时、改了什么）；
// - last_contact_at = max(现有, 本次沟通时间)：补录更早的沟通不回退最近联系时间；
// - 修正时 lead.next_contact_at 仅在该记录仍是最新一条沟通时同步，
//   防止修正旧记录的下次联系时间覆盖更新计划。

type Db = Prisma.TransactionClient | typeof prisma;

export interface StageAdvance {
  fromStage: LeadStage;
  toStage: LeadStage;
  triggers: string[];
}

export interface SaveInteractionResult {
  interaction: Interaction;
  /** 本次保存触发的阶段推进（K4）；null = 未推进 */
  stageAdvanced: { fromStageId: string; toStageId: string } | null;
  /** "本次确认"勾选后更新的画像核实状态字段（仅新建，修正不含此项） */
  factStatusConfirmed: string[];
}

function occurredDateOf(value: string): Date {
  return parseShanghaiDate(value);
}

function nextContactDateOf(
  value: string | null | undefined,
): Date | null {
  return value ? parseShanghaiDate(value) : null;
}

async function loadActiveLeadWithStageOrThrow(
  id: string,
): Promise<Lead & { stage: LeadStage }> {
  const lead = await prisma.lead.findFirst({
    where: { id, deletedAt: null },
    include: { stage: true },
  });
  if (!lead) {
    throw new ApiError(404, "not_found", "客户不存在");
  }
  return lead;
}

async function loadInteractionWithLeadOrThrow(
  id: string,
): Promise<Interaction & { lead: Lead & { stage: LeadStage } }> {
  const row = await prisma.interaction.findUnique({
    where: { id },
    include: { lead: { include: { stage: true } } },
  });
  if (!row || row.lead.deletedAt !== null) {
    throw new ApiError(404, "not_found", "沟通记录不存在");
  }
  return row;
}

/**
 * K4 阶段联动目标解析（只读，不写库）：
 * 候选目标 = 勾选项对应的语义锚点阶段；仅当目标存在、启用且排序晚于当前阶段时参与，
 * 取排序最远者（同时勾选合格与预约 → 推进到「已预约演示」）。
 * 目标停用/缺失/不晚于当前 → 返回 null（不自动推进，用户可手动流转）。
 */
async function resolveStageAdvance(
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

async function writeAdvanceEvent(
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

async function bumpLeadForInteraction(
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

// ---------- 保存（POST /api/leads/:id/interactions） ----------

export async function createInteraction(
  actor: AuthUser,
  leadId: string,
  input: InteractionCreateInput,
): Promise<SaveInteractionResult> {
  const lead = await loadActiveLeadWithStageOrThrow(leadId);
  assertLeadWritable(actor, lead.ownerId);

  const occurredAt = occurredDateOf(input.occurredAt);
  const nextContactAt = nextContactDateOf(input.nextContactAt);
  const flags = {
    isQualified: input.isQualified ?? false,
    demoBooked: input.demoBooked ?? false,
  };
  const factStatusConfirmed: string[] = [];
  if (input.confirmCurrentSystem) {
    factStatusConfirmed.push("current_system");
  }
  if (input.confirmPurchaseTime) {
    factStatusConfirmed.push("purchase_time");
  }

  const { interaction, advance } = await prisma.$transaction(async (tx) => {
    const created = await tx.interaction.create({
      data: {
        leadId: lead.id,
        userId: actor.id,
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
      await writeAdvanceEvent(tx, lead.id, actor.id, advance, created.id);
    }
    return { interaction: created, advance };
  });

  return {
    interaction,
    stageAdvanced: advance
      ? { fromStageId: advance.fromStage.id, toStageId: advance.toStage.id }
      : null,
    factStatusConfirmed,
  };
}

// ---------- 修正（PATCH /api/interactions/:id，M11） ----------

type ChangedValue = { from: unknown; to: unknown };

function diffText(
  changed: Record<string, ChangedValue>,
  field: string,
  from: string | null,
  to: string | null,
): void {
  if (from !== to) {
    changed[field] = { from, to };
  }
}

export async function updateInteraction(
  actor: AuthUser,
  interactionId: string,
  input: InteractionUpdateInput,
): Promise<SaveInteractionResult> {
  const existing = await loadInteractionWithLeadOrThrow(interactionId);
  assertLeadWritable(actor, existing.lead.ownerId);

  const occurredAt = occurredDateOf(input.occurredAt);
  const nextContactAt = nextContactDateOf(input.nextContactAt);
  const flags = {
    isQualified: input.isQualified ?? false,
    demoBooked: input.demoBooked ?? false,
  };

  // 修改审计（M11）：只记发生变化的字段（from/to 原值）
  const changed: Record<string, ChangedValue> = {};
  if (existing.occurredAt.getTime() !== occurredAt.getTime()) {
    changed.occurred_at = {
      from: existing.occurredAt.toISOString(),
      to: occurredAt.toISOString(),
    };
  }
  if (existing.channel !== input.channel) {
    changed.channel = { from: existing.channel, to: input.channel };
  }
  if (existing.direction !== input.direction) {
    changed.direction = { from: existing.direction, to: input.direction };
  }
  if (existing.connected !== input.connected) {
    changed.connected = { from: existing.connected, to: input.connected };
  }
  if (existing.effective !== input.effective) {
    changed.effective = { from: existing.effective, to: input.effective };
  }
  diffText(changed, "feedback", existing.feedback, input.feedback ?? null);
  diffText(
    changed,
    "confirmed_pains",
    existing.confirmedPains,
    input.confirmedPains ?? null,
  );
  diffText(
    changed,
    "current_system_confirmed",
    existing.currentSystemConfirmed,
    input.currentSystemConfirmed ?? null,
  );
  diffText(
    changed,
    "purchase_time_confirmed",
    existing.purchaseTimeConfirmed,
    input.purchaseTimeConfirmed ?? null,
  );
  diffText(
    changed,
    "decision_maker_note",
    existing.decisionMakerNote,
    input.decisionMakerNote ?? null,
  );
  diffText(changed, "objections", existing.objections, input.objections ?? null);
  diffText(changed, "next_action", existing.nextAction, input.nextAction ?? null);
  {
    const fromNext = existing.nextContactAt?.toISOString() ?? null;
    const toNext = nextContactAt?.toISOString() ?? null;
    if (fromNext !== toNext) {
      changed.next_contact_at = { from: fromNext, to: toNext };
    }
  }
  if (existing.isQualified !== flags.isQualified) {
    changed.is_qualified = { from: existing.isQualified, to: flags.isQualified };
  }
  if (existing.demoBooked !== flags.demoBooked) {
    changed.demo_booked = { from: existing.demoBooked, to: flags.demoBooked };
  }

  if (Object.keys(changed).length === 0) {
    // 提交内容与现值一致：幂等返回，不升版本、不追加审计
    return {
      interaction: existing,
      stageAdvanced: null,
      factStatusConfirmed: [],
    };
  }

  const priorAudit = Array.isArray(existing.editAudit)
    ? (existing.editAudit as unknown[])
    : [];
  const auditEntry = {
    at: new Date().toISOString(),
    by: actor.id,
    changed,
  };
  const nextAudit: unknown[] = [...priorAudit, auditEntry];

  const { interaction, advance } = await prisma.$transaction(async (tx) => {
    const updated = await tx.interaction.update({
      where: { id: existing.id },
      data: {
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
        editAudit: nextAudit as Prisma.InputJsonValue,
      },
    });

    const advance = await resolveStageAdvance(tx, existing.lead, flags);

    // 重算最近联系时间（覆盖 occurred_at 被修正的场景）
    const maxOccur = await tx.interaction.aggregate({
      _max: { occurredAt: true },
      where: { leadId: existing.leadId },
    });
    const lastContactAt = maxOccur._max.occurredAt ?? occurredAt;
    // 仅当本记录修正后仍是最新一条沟通时才同步下次联系时间
    const isLatestOccurrence = lastContactAt.getTime() === occurredAt.getTime();

    await bumpLeadForInteraction(
      tx,
      existing.leadId,
      advance ? existing.lead.stageId : null,
      {
        lastContactAt,
        ...(isLatestOccurrence ? { nextContactAt } : {}),
        ...(advance ? { stageId: advance.toStage.id } : {}),
      },
    );

    if (advance) {
      await writeAdvanceEvent(tx, existing.leadId, actor.id, advance, existing.id);
    }
    return { interaction: updated, advance };
  });

  return {
    interaction,
    stageAdvanced: advance
      ? { fromStageId: advance.fromStage.id, toStageId: advance.toStage.id }
      : null,
    factStatusConfirmed: [],
  };
}

// ---------- 列表（GET /api/leads/:id/interactions 与详情页共用同一实现） ----------

export async function listInteractions(
  actor: AuthUser,
  leadId: string,
): Promise<Interaction[]> {
  const lead = await loadActiveLeadWithStageOrThrow(leadId);
  assertLeadReadable(actor, lead.ownerId);
  return prisma.interaction.findMany({
    where: { leadId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  });
}
