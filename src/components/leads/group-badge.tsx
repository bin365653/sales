import {
  CONTROL_GROUP_NOTICE,
  EXPERIMENT_GROUP_BADGE_CLASS,
  EXPERIMENT_GROUP_LABELS,
  type ExperimentGroupValue,
} from "@/lib/experiments";

// 实验分组徽章（T14，UIUX §5 GroupBadge / P8）：常规组 = 灰 + 文字，
// AI 辅助组 = 紫 + 文字（与阶段紫同时出现时带文字不混淆）。
// 展示条件由调用方决定：该线索被实验覆盖且实验进行中（UIUX §4.6）。

export function GroupBadge({ group }: { group: ExperimentGroupValue }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-medium ${EXPERIMENT_GROUP_BADGE_CLASS[group]}`}
    >
      {EXPERIMENT_GROUP_LABELS[group]}
    </span>
  );
}

/** 常规组说明卡（UIUX §4.7：AI Tab 整体替换为说明卡，无任何 AI 入口） */
export function ControlGroupNoticeCard() {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">AI 助手</h2>
      <p className="mt-3 rounded-md bg-gray-50 px-3 py-3 text-sm text-gray-600">
        {CONTROL_GROUP_NOTICE}
      </p>
    </section>
  );
}
