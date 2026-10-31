import type { Interaction, Task } from "@prisma/client";
import {
  isTaskDueToday,
  isTaskOverdue,
  taskOverdueDays,
  TaskStatusValue,
} from "@/lib/tasks";
import { toExpiryMonth, formatExpiryChip } from "@/lib/expiry";
import { autoTaskReasonLabel, TASK_SOURCE_BADGE_LABELS, type QuadrantCode } from "@/lib/followup";
import {
  toDateTimeInputValue,
  toShanghaiDateTimeString,
} from "@/lib/format";

// 任务展示视图（T07）：服务端页面整形 → 客户端组件只渲染。
// 逾期/今日标记统一在服务端计算（isTaskOverdue 同一实现），前端不自算。
// V2.0-T07：来源徽章（到期月度/四象限周期/画像补充；手工不显示——降噪）+
// 自动任务原因行（生成规则文案，服务端派生）+ 优先级（§4.4 1–5）+
// 手工约定任务「客户约定」标记 + 客户到期年月（模块四：任务行可看到到期语境）。

export interface TaskLeadInfo {
  id: string;
  name: string;
  stageName: string;
  stageSortOrder: number;
  /** 客户软件到期（任务行展示年月语境；手工任务通常为 null） */
  contractExpiry?: Date | null;
  /** 到期核实行状态（原因行窗口口径；缺省按已知值处理） */
  expiryStatus?: string | null;
}

export interface TaskView {
  id: string;
  type: string;
  title: string;
  status: string;
  remark: string | null;
  /** 上海时区 "YYYY-MM-DD HH:mm" */
  dueAtDisplay: string;
  /** datetime-local 输入框初值（编辑预填） */
  dueAtInput: string;
  overdue: boolean;
  /** 已逾期天数（≥1）；未逾期为 null */
  overdueDays: number | null;
  /** 截止日是否为今天（上海） */
  dueToday: boolean;
  completedAtDisplay: string | null;
  /** 完成时生成的沟通记录 id（UIUX P6：已完成任务显示沟通记录链接） */
  interactionId: string | null;
  lead: TaskLeadInfo;
  // —— V2.0-T07 ——
  /** 任务来源（§4.4 优先级映射的来源类别） */
  sourceType: string;
  /** 来源徽章文案（manual 不显示 → null） */
  sourceLabel: string | null;
  /** 自动任务原因行（生成规则文案；手工任务 null） */
  reason: string | null;
  /** 任务优先级 1–5（§4.4） */
  priority: number | null;
  /** 手工约定任务（priority=1 的 manual）→ 显示「客户约定」小签 */
  isPinned: boolean;
  /** 客户到期年月（如 "2026-12"；买断 "2099-12"；未知 null） */
  expiryMonth: string | null;
  /** 客户到期语境短文案（含窗口语义） */
  expiryDisplay: string | null;
}

/** 服务端统一整形（任务中心 / 客户详情共用同一实现） */
export function toTaskView(
  task: Task & {
    lead: TaskLeadInfo;
    policy?: { quadrantCode: string | null; intervalDays: number } | null;
    interaction?: Pick<Interaction, "id"> | null;
  },
  now: Date = new Date(),
): TaskView {
  const overdue = isTaskOverdue(
    task.dueAt,
    task.status as TaskStatusValue,
    now,
  );
  const sourceType = task.sourceType;
  const expiryMonth = task.lead.contractExpiry
    ? toExpiryMonth(task.lead.contractExpiry)
    : null;
  const expiryDisplay = task.lead.contractExpiry
    ? formatExpiryChip(task.lead.contractExpiry, now, {
        status: task.lead.expiryStatus ?? undefined,
      })
    : null;
  const reason =
    sourceType === "manual"
      ? null
      : autoTaskReasonLabel(sourceType, {
          contractExpiry: task.lead.contractExpiry ?? null,
          expiryVerificationStatus: task.lead.expiryStatus ?? "unverified",
          quadrant: (task.policy?.quadrantCode as QuadrantCode | undefined) ?? null,
          intervalDays: task.policy?.intervalDays ?? null,
          now,
        });
  const priority = task.priority ?? null;
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    status: task.status,
    remark: task.remark,
    dueAtDisplay: toShanghaiDateTimeString(task.dueAt),
    dueAtInput: toDateTimeInputValue(task.dueAt),
    overdue,
    overdueDays: overdue ? taskOverdueDays(task.dueAt, now) : null,
    dueToday: isTaskDueToday(task.dueAt, now),
    completedAtDisplay:
      task.completedAt !== null ? toShanghaiDateTimeString(task.completedAt) : null,
    interactionId: task.interactionId ?? null,
    lead: {
      id: task.lead.id,
      name: task.lead.name,
      stageName: task.lead.stageName,
      stageSortOrder: task.lead.stageSortOrder,
      contractExpiry: task.lead.contractExpiry ?? null,
      expiryStatus: task.lead.expiryStatus ?? null,
    },
    sourceType,
    sourceLabel:
      sourceType === "manual" ? null : (TASK_SOURCE_BADGE_LABELS[sourceType] ?? null),
    reason,
    priority,
    isPinned: sourceType === "manual" && (priority ?? 1) === 1,
    expiryMonth,
    expiryDisplay,
  };
}

/** 截止时间展示：今日显示"今天 HH:mm"，逾期前置"已逾期 X 天"（UIUX P6 卡片样式） */
export function taskDueDisplay(view: {
  dueAtDisplay: string;
  dueToday: boolean;
  overdue: boolean;
  overdueDays: number | null;
}): string {
  if (view.overdue) {
    return `已逾期 ${view.overdueDays ?? 1} 天 · ${view.dueAtDisplay}`;
  }
  if (view.dueToday) {
    return `今天 ${view.dueAtDisplay.slice(11)}`;
  }
  return view.dueAtDisplay;
}

/** 来源徽章样式（UIUX §3.1：到期月度=琥珀 / 四象限周期=蓝 / 画像补充=青） */
export const SOURCE_BADGE_CLASS: Record<string, string> = {
  expiry_monthly: "bg-amber-50 text-amber-700",
  quadrant_periodic: "bg-blue-50 text-blue-700",
  profile_gap: "bg-teal-50 text-teal-700",
};
