import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  PROFILE_CORE_FIELDS,
  PROFILE_VERIFIABLE_FIELDS,
  VERIFIABLE_FIELD_KEYS,
} from "@/lib/lead-fields";
import {
  evaluateQuadrant,
  isConfirmedStatus,
  type LeadQuadrantCode,
} from "@/lib/quadrant";
import { FACT_STATUS_LABELS } from "@/lib/format";

// 画像完善度与四象限重算（V2.0-T04，实施计划 §4.1/§4.3）。
//
// 服务端唯一实现：分类与完善度由确定性规则计算，用户不可直填、AI 不参与。
// 触发点（全部在调用方事务内执行）：
// - 线索创建/导入确认（insertLeadWithEvent）；
// - 线索编辑保存（updateLead）；
// - 沟通「本次确认」写值（applyInteractionWrite）；
// - 字典建议确认写入（同编辑链路）。
//
// 规则（P5）：核心 7 项全部核实（confirmed/stated）=「基本完善」门槛；
// 辅助字段核实率 ≥60% =「深度完善」；核心未全核实 =「未完善」。
// 不是按填写数量计算（迭代文档红线）。
// 象限变化写 lead_events(quadrant_changed)，detail 含 from/to + basis 双维快照
// （§3.3）；历史不可变，事件只追加。

export type Db = Prisma.TransactionClient | typeof prisma;

/** 辅助字段 = 核实白名单 − 核心 7 */
export const PROFILE_AUXILIARY_FIELDS: readonly string[] =
  PROFILE_VERIFIABLE_FIELDS.filter((key) => !PROFILE_CORE_FIELDS.includes(key));

/** P5 阈值：辅助字段核实率 ≥60% → 深度完善 */
export const PROFILE_DEEP_THRESHOLD = 0.6;

export interface QuadrantBasisAxis {
  field: "next_gen_mobile_order" | "qince_interest";
  value: boolean | null;
  status: string;
  statusLabel: string;
}

export interface RecomputeResult {
  quadrant: LeadQuadrantCode | null;
  previousQuadrant: LeadQuadrantCode | null;
  profileStatus: "incomplete" | "basic" | "deep";
  quadrantChanged: boolean;
  coreVerifiedCount: number;
  missing: string[];
  basis: { x: QuadrantBasisAxis; y: QuadrantBasisAxis };
}

/**
 * 完善度计算（P5，基于核实状态而非填写数量）：
 * - 核心 <7 项核实 → incomplete；
 * - 核心 7/7 且辅助核实率 <60% → basic；
 * - 核心 7/7 且辅助核实率 ≥60% → deep。
 */
export function computeProfileStatus(
  rows: { fieldKey: string; status: string }[],
): {
  profileStatus: "incomplete" | "basic" | "deep";
  coreVerifiedCount: number;
  auxiliaryVerifiedCount: number;
} {
  const statusByKey = new Map(rows.map((row) => [row.fieldKey, row.status]));
  const coreVerifiedCount = PROFILE_CORE_FIELDS.filter((key) =>
    isConfirmedStatus(statusByKey.get(key)),
  ).length;
  const auxiliaryVerifiedCount = PROFILE_AUXILIARY_FIELDS.filter((key) =>
    isConfirmedStatus(statusByKey.get(key)),
  ).length;
  let profileStatus: "incomplete" | "basic" | "deep";
  if (coreVerifiedCount < PROFILE_CORE_FIELDS.length) {
    profileStatus = "incomplete";
  } else if (
    auxiliaryVerifiedCount / PROFILE_AUXILIARY_FIELDS.length >=
    PROFILE_DEEP_THRESHOLD
  ) {
    profileStatus = "deep";
  } else {
    profileStatus = "basic";
  }
  return { profileStatus, coreVerifiedCount, auxiliaryVerifiedCount };
}

/**
 * 重算指定客户的象限与完善度（必须在调用方事务内执行）：
 * 1. 读事务内最新线索行 + 核实行（随本轮写入生效）；
 * 2. evaluateQuadrant（双确认口径 P3）+ computeProfileStatus（P5）；
 * 3. 与现值不同才更新 leads 列（quadrant_code/quadrant_computed_at/profile_status/
 *    last_profile_verified_at=核实行最新 verified_at）；
 * 4. 象限变化（含首次分类）写 quadrant_changed 事件（from/to/basis）。
 * 历史不可变：只追加事件，不修改既有事件；已存在 quadrant 不因重算失败丢失。
 */
export async function recomputeLeadClassification(
  tx: Db,
  leadId: string,
  actorId: string | null,
): Promise<RecomputeResult> {
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: leadId } });
  const rows = await tx.leadFieldVerification.findMany({
    where: { leadId },
  });
  const statusByKey = new Map(rows.map((row) => [row.fieldKey, row.status]));

  const x = {
    field: "next_gen_mobile_order" as const,
    value: lead.nextGenMobileOrder,
    status: statusByKey.get("next_gen_mobile_order") ?? "unknown",
  };
  const y = {
    field: "qince_interest" as const,
    value: lead.qinceInterest,
    status: statusByKey.get("qince_interest") ?? "unknown",
  };
  const evaluation = evaluateQuadrant(x, y);
  const profile = computeProfileStatus(rows);

  const lastVerifiedAt = rows
    .filter((row) => isConfirmedStatus(row.status) && row.verifiedAt)
    .map((row) => row.verifiedAt as Date)
    .reduce<Date | null>(
      (latest, current) => (latest === null || current > latest ? current : latest),
      null,
    );

  const quadrantChanged = evaluation.quadrant !== lead.quadrantCode;
  const profileChanged = profile.profileStatus !== lead.profileStatus;

  if (quadrantChanged || profileChanged) {
    await tx.lead.update({
      where: { id: leadId },
      data: {
        quadrantCode: evaluation.quadrant,
        quadrantComputedAt: quadrantChanged ? new Date() : lead.quadrantComputedAt,
        profileStatus: profile.profileStatus,
        ...(lastVerifiedAt ? { lastProfileVerifiedAt: lastVerifiedAt } : {}),
      },
    });
  }

  if (quadrantChanged) {
    const basis = {
      x: {
        field: x.field,
        value: x.value,
        status: x.status,
        statusLabel:
          FACT_STATUS_LABELS[x.status as keyof typeof FACT_STATUS_LABELS] ?? x.status,
      },
      y: {
        field: y.field,
        value: y.value,
        status: y.status,
        statusLabel:
          FACT_STATUS_LABELS[y.status as keyof typeof FACT_STATUS_LABELS] ?? y.status,
      },
    };
    await tx.leadEvent.create({
      data: {
        leadId,
        actorId,
        eventType: "quadrant_changed",
        detail: {
          from: lead.quadrantCode,
          to: evaluation.quadrant,
          basis,
          profileStatus: profile.profileStatus,
          coreVerified: `${profile.coreVerifiedCount}/${PROFILE_CORE_FIELDS.length}`,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  return {
    quadrant: evaluation.quadrant,
    previousQuadrant: lead.quadrantCode,
    profileStatus: profile.profileStatus,
    quadrantChanged,
    coreVerifiedCount: profile.coreVerifiedCount,
    missing: evaluation.missing,
    basis: {
      x: { ...x, statusLabel: basisLabel(x.status) },
      y: { ...y, statusLabel: basisLabel(y.status) },
    },
  };
}

function basisLabel(status: string): string {
  return FACT_STATUS_LABELS[status as keyof typeof FACT_STATUS_LABELS] ?? status;
}

/** 非事务读取场景的分类依据（详情分类卡数据整形用；调用方自行拼接） */
export function axisInputOf(
  value: boolean | null | undefined,
  status: string | undefined,
): { value: boolean | null; status: string; confirmed: boolean } {
  return {
    value: value ?? null,
    status: status ?? "unknown",
    confirmed: isConfirmedStatus(status) && value !== null && value !== undefined,
  };
}

export { VERIFIABLE_FIELD_KEYS };
