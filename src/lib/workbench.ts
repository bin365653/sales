import { QUADRANT_ADVICE, type LeadQuadrantCode } from "@/lib/quadrant";
import type { ExpiryWindow } from "@/lib/expiry";

// 首页经营视图（V2.0-T09，PRD 模块七 / UIUX §5.6）纯函数层：
// 「本次联系原因」与「推荐沟通内容」均为确定性规则文案（服务端生成，
// 前端不自算；迭代四起推荐内容可由 AI 个性化增强，但规则模板仍是兜底）。
// 红线：规则必须说人话（UIUX §7.1），无采购信号不出高意向话术（V1.0 延续）。

/** 各作战列表 Tab 元信息（服务端渲染 Tab 链接用） */
export const WORKBENCH_TABS = [
  { key: "today", label: "今日优先" },
  { key: "monthly", label: "月度必跟" },
  { key: "gap", label: "画像待完善" },
  { key: "focus", label: "四象限重点" },
  { key: "nurture", label: "长期培育" },
] as const;

export type WorkbenchTabKey = (typeof WORKBENCH_TABS)[number]["key"];

export const WORKBENCH_TAB_DEFAULT: WorkbenchTabKey = "today";

export function isWorkbenchTab(key: string): key is WorkbenchTabKey {
  return WORKBENCH_TABS.some((tab) => tab.key === key);
}

/**
 * 推荐沟通内容（规则模板，一行可展开）：
 * 到期语境叠加象限经营建议——已过期先核实续费/换系统；半年内叠加续费窗口；
 * 象限未定（待完善）以画像补全为第一动作；买断（beyond）按象限建议。
 */
export function recommendedTalkTrack(input: {
  quadrant: LeadQuadrantCode | null;
  expiryWindow: ExpiryWindow;
}): string {
  if (input.expiryWindow === "unknown") {
    return "先补全核心画像：核实当前使用系统与软件到期时间，再按象限安排跟进节奏";
  }
  if (input.expiryWindow === "expired") {
    return "核实续费状态（续费/换系统/停用），同步收集当前系统使用痛点";
  }
  if (input.expiryWindow === "within_6m") {
    const advice = input.quadrant ? QUADRANT_ADVICE[input.quadrant] : null;
    return advice
      ? `核实续费意向与时间表；${advice}`
      : "核实续费意向与时间表；顺带补全核心画像";
  }
  // beyond_6m（含 2099 买断）：按象限长期节奏
  return input.quadrant
    ? QUADRANT_ADVICE[input.quadrant]
    : "完成核心画像核实后，系统将自动按象限安排周期跟进";
}

/** 画像待完善列表的联系原因（核心缺口必显，确定性模板——迭代四起 AI 增强） */
export function profileGapReason(missingCoreLabels: string[]): string {
  if (missingCoreLabels.length === 0) {
    return "核心画像已核实，建议补充辅助信息提升完善度";
  }
  return `核心画像未全部核实：缺 ${missingCoreLabels.join("、")}`;
}
