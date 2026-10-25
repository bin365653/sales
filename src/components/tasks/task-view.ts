import type { Interaction, Task } from "@prisma/client";
import {
  isTaskDueToday,
  isTaskOverdue,
  taskOverdueDays,
  TaskStatusValue,
} from "@/lib/tasks";
import {
  toDateTimeInputValue,
  toShanghaiDateTimeString,
} from "@/lib/format";

// 任务展示视图（T07）：服务端页面整形 → 客户端组件只渲染。
// 逾期/今日标记统一在服务端计算（isTaskOverdue 同一实现），前端不自算。

export interface TaskLeadInfo {
  id: string;
  name: string;
  stageName: string;
  stageSortOrder: number;
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
}

/** 服务端统一整形（任务中心 / 客户详情共用同一实现） */
export function toTaskView(
  task: Task & {
    lead: TaskLeadInfo;
    interaction?: Pick<Interaction, "id"> | null;
  },
  now: Date = new Date(),
): TaskView {
  const overdue = isTaskOverdue(
    task.dueAt,
    task.status as TaskStatusValue,
    now,
  );
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
    },
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
