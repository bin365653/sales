// 预置客户阶段定义（PRD §5.8 的 13 个阶段）
//
// semanticKey 是不可移除的语义锚点（实施计划 K2/C02）：
// - 指标口径（合格线索率、预约转化率、报价数、成交数等）锚定语义而非阶段名称；
// - 沟通记录勾选"合格线索/预约演示"后的自动推进（K4/C09）也锚定语义；
// - 预置阶段的语义锚点不可移除；管理员新增的自定义阶段无语义锚点。
// code 初始与 semanticKey 相同，但 code 允许管理员修改，semanticKey 永不修改。

export interface PresetStageDef {
  readonly semanticKey: string;
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export const PRESET_STAGES: readonly PresetStageDef[] = [
  { semanticKey: "new_lead", code: "new_lead", name: "新线索", sortOrder: 1 },
  { semanticKey: "to_contact", code: "to_contact", name: "待联系", sortOrder: 2 },
  { semanticKey: "contacted", code: "contacted", name: "已接通", sortOrder: 3 },
  {
    semanticKey: "effective_contacted",
    code: "effective_contacted",
    name: "已有效沟通",
    sortOrder: 4,
  },
  {
    semanticKey: "needs_unconfirmed",
    code: "needs_unconfirmed",
    name: "需求待确认",
    sortOrder: 5,
  },
  { semanticKey: "qualified", code: "qualified", name: "合格商机", sortOrder: 6 },
  {
    semanticKey: "booked_demo",
    code: "booked_demo",
    name: "已预约演示",
    sortOrder: 7,
  },
  {
    semanticKey: "demo_completed",
    code: "demo_completed",
    name: "已完成演示",
    sortOrder: 8,
  },
  { semanticKey: "quoted", code: "quoted", name: "方案报价", sortOrder: 9 },
  {
    semanticKey: "negotiating",
    code: "negotiating",
    name: "商务谈判",
    sortOrder: 10,
  },
  { semanticKey: "won", code: "won", name: "已成交", sortOrder: 11 },
  { semanticKey: "on_hold", code: "on_hold", name: "暂缓", sortOrder: 12 },
  { semanticKey: "closed", code: "closed", name: "已关闭", sortOrder: 13 },
];

// 指标引擎依赖的语义锚点（T12/T13 使用；此处作为 seed 校验基线）：
// - qualified / booked_demo / quoted / won：PRD §5.9 指标锚定；
// - closed：单条线索平均处理时间的终点之一（K5：创建 → 首次成为合格商机或关闭）。
export const REQUIRED_METRIC_ANCHORS = [
  "qualified",
  "booked_demo",
  "quoted",
  "won",
  "closed",
] as const;

// 沟通记录自动推进阶段使用的锚点（K4/C09，T06 使用）。
export const QUALIFIED_STAGE_ANCHOR = "qualified";
export const BOOKED_DEMO_STAGE_ANCHOR = "booked_demo";
