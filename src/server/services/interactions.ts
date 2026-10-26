import { Interaction, Lead, LeadStage, Prisma, Task } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { parseShanghaiDate } from "@/lib/schemas/lead";
import { InteractionUpdateInput } from "@/lib/schemas/interaction";
import { InteractionCreateWithTaskInput } from "@/lib/schemas/task";
import {
  applyInteractionWrite,
  bumpLeadForInteraction,
  resolveStageAdvance,
  writeAdvanceEvent,
  type StageAdvance,
} from "@/server/services/interaction-write";
import { insertTaskInTx } from "@/server/services/tasks";
import {
  assertLeadReadable,
  assertLeadWritable,
  leadReadScope,
} from "@/server/permissions";

// 沟通记录服务（T06，PRD §5.6 / K4 / M11）。
// 关键不变量：
// - 保存为单事务：沟通记录 + last_contact_at + （可选）next_contact_at +
//   "本次确认"核实状态 + 条件推进阶段（K4）+（可选）同时创建任务（T07）——
//   任一步失败全部回滚（§7 原则 5）；写入核心见 interaction-write.ts（与
//   完成任务弹窗共用同一实现）；
// - 可见性经线索归属判定（§4.4）：本表不存归属冗余列，读写都过 permissions 层；
// - 沟通记录只追加、不可删除（M1）；修正不改写历史值，edit_audit 追加
//   {at, by, changed:{field:{from,to}}}（M11：谁、何时、改了什么）；
// - last_contact_at = max(现有, 本次沟通时间)：补录更早的沟通不回退最近联系时间；
// - 修正时 lead.next_contact_at 仅在该记录仍是最新一条沟通时同步，
//   防止修正旧记录的下次联系时间覆盖更新计划。

export type { StageAdvance };

export interface SaveInteractionResult {
  interaction: Interaction;
  /** 本次保存触发的阶段推进（K4）；null = 未推进 */
  stageAdvanced: { fromStageId: string; toStageId: string } | null;
  /** "本次确认"勾选后更新的画像核实状态字段（仅新建，修正不含此项） */
  factStatusConfirmed: string[];
  /** "同时创建任务"勾选后创建的任务（T07，UIUX P5）；null = 未勾选 */
  createdTask: Task | null;
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

// ---------- 保存（POST /api/leads/:id/interactions） ----------

export async function createInteraction(
  actor: AuthUser,
  leadId: string,
  input: InteractionCreateWithTaskInput,
): Promise<SaveInteractionResult> {
  const lead = await loadActiveLeadWithStageOrThrow(leadId);
  assertLeadWritable(actor, lead.ownerId);

  const factStatusConfirmed: string[] = [];
  if (input.confirmCurrentSystem) {
    factStatusConfirmed.push("current_system");
  }
  if (input.confirmPurchaseTime) {
    factStatusConfirmed.push("purchase_time");
  }

  const { interaction, advance, createdTask } = await prisma.$transaction(
    async (tx) => {
      const result = await applyInteractionWrite(tx, lead, actor.id, input);
      // "同时创建任务"（UIUX P5 / PRD"设置下次联系时间并生成任务"）：
      // 与沟通保存同事务，任务归属线索负责人快照
      const createdTask = input.createTask
        ? await insertTaskInTx(tx, {
            leadId: lead.id,
            assigneeId: lead.ownerId,
            createdBy: actor.id,
            type: input.createTask.type,
            title: input.createTask.title,
            dueAt: parseShanghaiDate(input.createTask.dueAt),
            remark: input.createTask.remark ?? null,
          })
        : null;
      return { ...result, createdTask };
    },
  );

  return {
    interaction,
    stageAdvanced: advance
      ? { fromStageId: advance.fromStage.id, toStageId: advance.toStage.id }
      : null,
    factStatusConfirmed,
    createdTask,
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

  const occurredAt = parseShanghaiDate(input.occurredAt);
  const nextContactAt = input.nextContactAt
    ? parseShanghaiDate(input.nextContactAt)
    : null;
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
      createdTask: null,
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
    createdTask: null,
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

// ---------- 最近沟通（工作台 P2「最近沟通记录」，T12） ----------

export interface RecentInteractionRow {
  id: string;
  leadId: string;
  leadName: string;
  occurredAt: Date;
  channel: Interaction["channel"];
  direction: Interaction["direction"];
  connected: boolean;
  effective: boolean;
  feedback: string | null;
}

/**
 * 数据范围内最新 N 条沟通（时间倒序）：销售=本人客户的沟通，
 * 管理员=全量。可见性经线索归属判定（§4.4，同上）。
 * 含软删除客户的沟通——沟通发生过就是发生过，与个人全量导出口径一致（M9）。
 */
export async function listRecentInteractions(
  actor: AuthUser,
  limit: number,
): Promise<RecentInteractionRow[]> {
  const scope = leadReadScope(actor);
  const rows = await prisma.interaction.findMany({
    where: scope.ownerId ? { lead: { ownerId: scope.ownerId } } : {},
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit,
    include: { lead: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    leadId: row.leadId,
    leadName: row.lead.name,
    occurredAt: row.occurredAt,
    channel: row.channel,
    direction: row.direction,
    connected: row.connected,
    effective: row.effective,
    feedback: row.feedback,
  }));
}
