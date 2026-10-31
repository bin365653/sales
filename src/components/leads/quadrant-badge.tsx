// 四象限徽章（V2.0-T03/T04，UIUX §3.1 象限配色 + §4.1 QuadrantBadge）。
// 固定格式「{字母}·第{N}象限」，永远带文字（不只靠颜色）；
// 画像待完善 = 琥珀（任一维度未确认，未知≠否）。

import type { LeadQuadrantCode } from "@/lib/quadrant";

export const QUADRANT_LABELS: Record<LeadQuadrantCode | "pending", string> = {
  a: "A·第一象限",
  b: "B·第二象限",
  c: "C·第三象限",
  d: "D·第四象限",
  pending: "画像待完善",
};

/** 维度说明（分类卡/悬停依据展示） */
export const QUADRANT_DIMENSIONS: Record<LeadQuadrantCode, string> = {
  a: "在用新一代手机开单 + 有意愿沟通了解勤策",
  b: "在用新一代手机开单 + 暂无意愿",
  c: "未用新一代手机开单 + 有意愿",
  d: "未用新一代手机开单 + 暂无意愿",
};

export const QUADRANT_BADGE_CLASS: Record<LeadQuadrantCode | "pending", string> = {
  a: "bg-blue-50 text-blue-700",
  b: "bg-teal-50 text-teal-700",
  c: "bg-emerald-50 text-emerald-700",
  d: "bg-gray-100 text-gray-600",
  pending: "bg-amber-50 text-amber-700",
};

export function QuadrantBadge({
  code,
  withDimension = false,
}: {
  code: LeadQuadrantCode | "pending" | null | undefined;
  /** 分类卡场景附维度说明文字 */
  withDimension?: boolean;
}) {
  const key = code ?? "pending";
  return (
    <span
      title={
        key === "pending"
          ? "存在未确认的分类维度，客户暂不进入四象限；未知与待核实不会被当作「否」。"
          : QUADRANT_DIMENSIONS[key]
      }
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
        QUADRANT_BADGE_CLASS[key]
      }`}
    >
      {QUADRANT_LABELS[key]}
      {withDimension && key !== "pending" && (
        <span className="font-normal opacity-80">（{QUADRANT_DIMENSIONS[key]}）</span>
      )}
    </span>
  );
}
