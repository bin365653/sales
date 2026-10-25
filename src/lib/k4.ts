import { BOOKED_DEMO_STAGE_ANCHOR, QUALIFIED_STAGE_ANCHOR } from "@/lib/stages";

// K4 阶段联动的表单提示（T06/T07 前端侧）：与服务端 resolveStageAdvance
// （interaction-write.ts）同一规则——目标阶段启用且排序晚于当前才推进，
// 同时勾选合格与预约取排序更远者。仅用于提交前提示，不代替服务端判定。

export interface StageOptionLike {
  name: string;
  sortOrder: number;
  semanticKey: string | null;
}

/** 返回将自动推进到的目标阶段名；不满足推进条件时返回 null（不提示） */
export function resolveStageAdvanceTargetName(
  stages: StageOptionLike[],
  currentStageSortOrder: number,
  flags: { isQualified?: boolean; demoBooked?: boolean },
): string | null {
  const targets: StageOptionLike[] = [];
  if (flags.isQualified) {
    const stage = stages.find((item) => item.semanticKey === QUALIFIED_STAGE_ANCHOR);
    if (stage && currentStageSortOrder < stage.sortOrder) {
      targets.push(stage);
    }
  }
  if (flags.demoBooked) {
    const stage = stages.find((item) => item.semanticKey === BOOKED_DEMO_STAGE_ANCHOR);
    if (stage && currentStageSortOrder < stage.sortOrder) {
      targets.push(stage);
    }
  }
  if (targets.length === 0) {
    return null;
  }
  return targets.reduce((a, b) => (b.sortOrder > a.sortOrder ? b : a)).name;
}
