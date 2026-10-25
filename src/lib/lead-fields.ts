// 内置客户字段清单（T03）：PRD §5.3 字段全集 ↔ leads 物理列的单一事实源。
//
// 用途：
// - seed 按 key 幂等生成 lead_field_defs 内置字段定义（可启停/排序，M4）；
// - 线索服务用它判定"提交的内置字段是否已被停用"；
// - T04 表单/详情页按 group + label 渲染。
//
// 注意：内置字段的取值校验（长度/格式/范围）一律以 src/lib/schemas/lead.ts 的
// Zod Schema 为准（前后端共用），本清单只描述展示元数据，不重复维护校验规则。
// considering_switch / has_clear_demand 两列为布尔语义（null=未知），
// lead_field_type 无布尔类型，展示层按 Zod Schema 的 boolean 处理，此处标 text。

export type LeadFieldGroup = "basic" | "system" | "purchase" | "management";

export interface BuiltinLeadField {
  /** 稳定内部 ID，即 leads 表物理列名（snake_case），永不可变 */
  readonly key: string;
  readonly label: string;
  readonly group: LeadFieldGroup;
  readonly type: "text" | "number" | "date";
}

export const BUILTIN_LEAD_FIELDS: readonly BuiltinLeadField[] = [
  // —— 基本信息 ——
  { key: "name", label: "客户名称", group: "basic", type: "text" },
  { key: "city", label: "城市", group: "basic", type: "text" },
  { key: "industry", label: "行业细分", group: "basic", type: "text" },
  { key: "main_category", label: "主营品类", group: "basic", type: "text" },
  { key: "contact_name", label: "联系人", group: "basic", type: "text" },
  { key: "contact_title", label: "联系人职务", group: "basic", type: "text" },
  { key: "contact_phone", label: "联系方式", group: "basic", type: "text" },
  { key: "source", label: "客户来源", group: "basic", type: "text" },
  { key: "sales_team_size", label: "业务员人数", group: "basic", type: "number" },
  { key: "revenue_range", label: "营收区间", group: "basic", type: "text" },
  { key: "sales_mode", label: "销售模式", group: "basic", type: "text" },
  // —— 系统情况 ——
  { key: "current_system", label: "当前使用系统", group: "system", type: "text" },
  { key: "system_modules", label: "使用模块", group: "system", type: "text" },
  { key: "contract_expiry", label: "合同/到期时间", group: "system", type: "date" },
  { key: "known_pains", label: "已知不满", group: "system", type: "text" },
  { key: "considering_switch", label: "是否考虑更换系统", group: "system", type: "text" },
  // —— 采购情况 ——
  { key: "has_clear_demand", label: "是否有明确需求", group: "purchase", type: "text" },
  { key: "purchase_time", label: "采购时间", group: "purchase", type: "text" },
  { key: "budget", label: "预算情况", group: "purchase", type: "text" },
  { key: "decision_maker", label: "决策人", group: "purchase", type: "text" },
  { key: "decision_process", label: "决策流程", group: "purchase", type: "text" },
  { key: "main_concerns", label: "主要顾虑", group: "purchase", type: "text" },
  // —— 管理 ——
  { key: "remark", label: "备注", group: "management", type: "text" },
];

export const BUILTIN_LEAD_FIELD_KEYS: ReadonlySet<string> = new Set(
  BUILTIN_LEAD_FIELDS.map((field) => field.key),
);

/** 四个带核实状态列的关键事实字段（实施计划 §4.3「值列 + 状态列」成对设计） */
export const FACT_STATUS_FIELDS = [
  {
    valueKey: "currentSystem",
    statusKey: "currentSystemStatus",
    defKey: "current_system",
    label: "当前使用系统",
  },
  {
    valueKey: "contractExpiry",
    statusKey: "contractExpiryStatus",
    defKey: "contract_expiry",
    label: "合同/到期时间",
  },
  {
    valueKey: "purchaseTime",
    statusKey: "purchaseTimeStatus",
    defKey: "purchase_time",
    label: "采购时间",
  },
  {
    valueKey: "decisionMaker",
    statusKey: "decisionMakerStatus",
    defKey: "decision_maker",
    label: "决策人",
  },
] as const;

export const LEAD_FIELD_GROUP_LABELS: Record<LeadFieldGroup, string> = {
  basic: "基本信息",
  system: "系统情况",
  purchase: "采购情况",
  management: "管理字段",
};
