// 四象限计算（V2.0-T04，实施计划 §4.1，PRD 模块三）。
//
// 纯函数、服务端唯一实现：分类由系统按两个「已确认」维度确定性计算，
// 不允许用户直填、不允许 AI 自行决定（PRD §2.2）。
//
// 口径（P1/P3）：
// - 枚举 a/b/c/d = 第一~四象限：
//   A = 在用新一代 + 有意愿 ｜ B = 在用新一代 + 无意愿
//   C = 未用新一代 + 有意愿 ｜ D = 未用新一代 + 无意愿
// - 「已确认」= status ∈ {confirmed, stated}（P3：客户自述待复核按已确认处理，
//   分类依据中标注「客户自述」）；
// - 任一维度未确认或值为 null → quadrant=null（画像待完善），未知≠否。

export type LeadQuadrantCode = "a" | "b" | "c" | "d";

export type VerificationStatus = "unknown" | "unverified" | "stated" | "confirmed";

export interface QuadrantAxisInput {
  /** 轴值：null = 未知 */
  value: boolean | null | undefined;
  status: VerificationStatus;
}

export interface QuadrantResult {
  /** null = 画像待完善（任一维度未确认） */
  quadrant: LeadQuadrantCode | null;
  /** 待完善时的缺失维度说明 */
  missing: string[];
}

/** P3 口径：进入四象限的「确认」= confirmed 或 stated */
export function isConfirmedStatus(status: string | null | undefined): boolean {
  return status === "confirmed" || status === "stated";
}

export const QUADRANT_MISSING_X = "是否使用新一代手机开单系统";
export const QUADRANT_MISSING_Y = "是否愿意沟通了解勤策";

/**
 * 四象限计算（§4.1 规则 1/2）：
 * 1. x 未确认 或 y 未确认 或 任一 value=null → { quadrant: null, missing }；
 * 2. 双确认：A=x真+y真 ｜ B=x真+y假 ｜ C=x假+y真 ｜ D=x假+y假。
 */
export function evaluateQuadrant(
  x: QuadrantAxisInput,
  y: QuadrantAxisInput,
): QuadrantResult {
  const missing: string[] = [];
  const xConfirmed = isConfirmedStatus(x.status) && x.value !== null && x.value !== undefined;
  const yConfirmed = isConfirmedStatus(y.status) && y.value !== null && y.value !== undefined;
  if (!xConfirmed) {
    missing.push(QUADRANT_MISSING_X);
  }
  if (!yConfirmed) {
    missing.push(QUADRANT_MISSING_Y);
  }
  if (missing.length > 0) {
    return { quadrant: null, missing };
  }
  const xValue = x.value as boolean;
  const yValue = y.value as boolean;
  if (xValue && yValue) {
    return { quadrant: "a", missing: [] };
  }
  if (xValue && !yValue) {
    return { quadrant: "b", missing: [] };
  }
  if (!xValue && yValue) {
    return { quadrant: "c", missing: [] };
  }
  return { quadrant: "d", missing: [] };
}

/** 象限的经营建议（规则文案，详情分类卡展示；迭代四起 AI 增强） */
export const QUADRANT_ADVICE: Record<LeadQuadrantCode, string> = {
  a: "重点客户：维护关系并推进商机转化，按周期（默认 30 天）定期回访。",
  b: "产品已触达但意愿待培育：低频触达，用客户案例与效率数据重建兴趣，避免过度打扰。",
  c: "价值切入：优先安排产品演示，突出手机开单效率对比，按较短周期（默认 14 天）跟进。",
  d: "长期培育：低频跟进（默认 90 天），关注经营变化信号，保持基本联系不丢失。",
};
