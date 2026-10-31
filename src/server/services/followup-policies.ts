import { FollowUpPolicy } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { writeAudit } from "@/server/auth/audit";
import { assertAdmin } from "@/server/permissions";
import {
  FollowupPoliciesUpdateInput,
  FollowupPolicyUpdateItem,
} from "@/lib/schemas/settings";
import { recalcFollowUpPlan } from "@/server/services/task-generation";

// 跟进策略服务（V2.0-T05，实施计划 §3.2 / 决策 D2 / 口径 P6）。
//
// 关键不变量：
// - 5 行固定配置（4 象限 + 1 系统月度）：仅周期/任务类型/提前量/启停可改；
//   名称/象限归属/系统行身份为配置身份，不开放修改（无新建/删除端点）；
// - 系统月度策略行 isSystem=true 整行只读（P6：半年内到期月度规则不可被
//   普通象限策略覆盖；UIUX §5.5 🔒「系统规则,不可由策略覆盖」）；
// - 读写均仅管理员（实施计划 §6：GET/PUT 管理员专用）；
// - intervalDays 1–365（UIUX §7.3 错误文案）；advanceDays 0–90；
// - 策略修改只影响之后生成的任务，不修改历史任务（UIUX §5.5 常驻文案）——
//   保存后取消命中象限客户的 pending 象限周期任务（original_due_at 留痕）+
//   写 plan_changed 事件，新计划由任务生成引擎按新周期补齐（T06）；
// - 全部改动逐条写审计（UIUX §5.5：每条策略改动写审计）。

/** 生成器视角的终态锚点（§4.5 防重 #4：won/closed 停止普通线索任务） */
export const TASK_GENERATION_TERMINAL_STAGES = ["won", "closed"] as const;

/** 象限策略行展示顺序（a/b/c/d），系统行恒殿后 */
function policySortKey(policy: FollowUpPolicy): number {
  switch (policy.quadrantCode) {
    case "a":
      return 1;
    case "b":
      return 2;
    case "c":
      return 3;
    case "d":
      return 4;
    default:
      return 9;
  }
}

export type FollowUpPolicyView = FollowUpPolicy;

/** 策略列表（管理员）：象限行按 a/b/c/d，系统行殿后 */
export async function listFollowUpPolicies(): Promise<FollowUpPolicyView[]> {
  const rows = await prisma.followUpPolicy.findMany();
  return rows.sort((x, y) => policySortKey(x) - policySortKey(y));
}

function describePolicy(
  policy: FollowUpPolicy,
): Record<string, string | number | boolean> {
  return {
    intervalDays: policy.intervalDays,
    taskType: policy.taskType,
    advanceDays: policy.advanceDays,
    isActive: policy.isActive,
  };
}

/**
 * 批量保存象限策略（UIUX §5.5 [保存全部]）：
 * 1. 载荷只能包含象限策略行（系统行只读，尝试修改 400 policy_system_readonly）；
 * 2. 未知策略 id → 404；同一策略重复提交 → 400 policy_duplicate；
 * 3. 每条有变化的行写一条审计（settings.followup_policy_updated，from/to 快照）；
 * 4. 命中象限的未终态客户：取消 pending 象限周期任务 + plan_changed 事件
 *    （reason=policy_updated），后续由生成引擎按新周期补齐。
 */
export async function updateFollowUpPolicies(
  actor: AuthUser,
  input: FollowupPoliciesUpdateInput,
): Promise<{
  policies: FollowUpPolicyView[];
  affectedLeads: number;
}> {
  assertAdmin(actor);

  const ids = input.policies.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, "policy_duplicate", "同一策略在请求中重复出现");
  }

  const allPolicies = await prisma.followUpPolicy.findMany();
  const byId = new Map(allPolicies.map((policy) => [policy.id, policy]));
  for (const item of input.policies) {
    const policy = byId.get(item.id);
    if (!policy) {
      throw new ApiError(404, "not_found", "跟进策略不存在");
    }
    if (policy.isSystem) {
      // 系统月度策略行只读（P6）；其周期由系统规则决定，不可编辑/停用
      throw new ApiError(
        400,
        "policy_system_readonly",
        "系统强制规则不可修改（软件半年内到期每月跟进一次，优先于象限策略）",
      );
    }
  }

  const changed: { item: FollowupPolicyUpdateItem; before: FollowUpPolicy }[] = [];
  for (const item of input.policies) {
    const policy = byId.get(item.id)!;
    if (
      policy.intervalDays !== item.intervalDays ||
      policy.taskType !== item.taskType ||
      policy.advanceDays !== item.advanceDays ||
      policy.isActive !== item.isActive
    ) {
      changed.push({ item, before: policy });
    }
  }

  if (changed.length === 0) {
    return { policies: await listFollowUpPolicies(), affectedLeads: 0 };
  }

  const affectedQuadrants = changed.map(({ before }) => before.quadrantCode) as (
    | "a"
    | "b"
    | "c"
    | "d"
  )[];

  const { affectedLeads, auditPayloads } = await prisma.$transaction(async (tx) => {
    const payloads: Parameters<typeof writeAudit>[0][] = [];
    for (const { item, before } of changed) {
      const updated = await tx.followUpPolicy.update({
        where: { id: item.id },
        data: {
          intervalDays: item.intervalDays,
          taskType: item.taskType,
          advanceDays: item.advanceDays,
          isActive: item.isActive,
          updatedBy: actor.id,
        },
      });
      // 审计在事务提交后统一写入（writeAudit 走全局连接，避免回滚孤儿行）
      payloads.push({
        userId: actor.id,
        action: "settings.followup_policy_updated",
        objectType: "follow_up_policy",
        objectId: updated.id,
        detail: {
          name: before.name,
          quadrant: before.quadrantCode,
          from: describePolicy(before),
          to: describePolicy(updated),
        },
      });
    }

    // 命中客户批量重算（§4.6）：未终态 + 未删除 + 命中象限 →
    // recalcFollowUpPlan 取消未来计划并按新周期立即重建（当月到期月度任务
    // 仍适用则保留）；plan_changed 事件在 recalc 内写（reason=policy_updated）
    const leads = await tx.lead.findMany({
      where: {
        deletedAt: null,
        quadrantCode: { in: affectedQuadrants },
        stage: { semanticKey: { notIn: [...TASK_GENERATION_TERMINAL_STAGES] } },
      },
      select: { id: true },
    });
    for (const lead of leads) {
      await recalcFollowUpPlan(lead.id, "policy_updated", actor.id, {
        tx,
        now: new Date(),
      });
    }
    return { affectedLeads: leads.length, auditPayloads: payloads };
  });

  for (const payload of auditPayloads) {
    await writeAudit(payload);
  }

  return { policies: await listFollowUpPolicies(), affectedLeads };
}
