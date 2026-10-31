// 内置客户字段清单（T03 / V2.0-T01）：PRD §5.3 + V2.0 模块一字段全集
// ↔ leads 物理列的单一事实源。
//
// 用途：
// - seed 按 key 幂等生成 lead_field_defs 内置字段定义（可启停/排序，M4）；
// - 线索服务用它判定"提交的内置字段是否已被停用"；
// - 表单/详情页按 group + label 渲染（V2.0 六组分区，UIUX §5.1）；
// - 核实机制以 PROFILE_VERIFIABLE_FIELDS 白名单为准（V2-T01，五元组 + 四态）。
//
// 注意：内置字段的取值校验（长度/格式/范围）一律以 src/lib/schemas/lead.ts 的
// Zod Schema 为准（前后端共用），本清单只描述展示元数据，不重复维护校验规则。
// considering_switch / has_clear_demand / next_gen_mobile_order / qince_interest /
// is_boss_contact 为布尔语义（null=未知），lead_field_type 无布尔类型，
// 展示层按 Zod Schema 的 boolean 处理，此处标 text。

// V2.0 六组（UIUX §5.1）：基础/业务/软件/意愿/决策/管理，替换 V1.0 四组。
export type LeadFieldGroup =
  | "basic"
  | "business"
  | "software"
  | "intent"
  | "decision"
  | "management";

export interface BuiltinLeadField {
  /** 稳定内部 ID，即 leads 表物理列名（snake_case），永不可变 */
  readonly key: string;
  readonly label: string;
  readonly group: LeadFieldGroup;
  readonly type: "text" | "number" | "date";
}

export const BUILTIN_LEAD_FIELDS: readonly BuiltinLeadField[] = [
  // —— 基础画像 ——
  { key: "name", label: "客户名称", group: "basic", type: "text" },
  { key: "city", label: "城市", group: "basic", type: "text" },
  { key: "industry", label: "行业细分", group: "basic", type: "text" },
  { key: "main_category", label: "主营品类", group: "basic", type: "text" },
  { key: "revenue_range", label: "营收区间", group: "basic", type: "text" },
  { key: "sales_team_scale", label: "业务员规模", group: "basic", type: "text" },
  { key: "sales_team_size", label: "业务员人数", group: "basic", type: "number" },
  { key: "customer_count", label: "客户数量", group: "basic", type: "number" },
  { key: "contact_name", label: "联系人", group: "basic", type: "text" },
  { key: "contact_title", label: "联系人职务", group: "basic", type: "text" },
  { key: "contact_phone", label: "联系方式", group: "basic", type: "text" },
  { key: "source", label: "客户来源", group: "basic", type: "text" },
  // —— 业务画像 ——
  { key: "sales_mode", label: "销售模式", group: "business", type: "text" },
  { key: "business_mgmt_mode", label: "业务管理方式", group: "business", type: "text" },
  { key: "order_mgmt_mode", label: "订单管理方式", group: "business", type: "text" },
  { key: "delivery_mgmt_mode", label: "配送管理方式", group: "business", type: "text" },
  { key: "finance_mgmt_mode", label: "财务管理方式", group: "business", type: "text" },
  { key: "warehouse_area", label: "仓储面积", group: "business", type: "text" },
  { key: "warehouse_type", label: "平仓/立体仓", group: "business", type: "text" },
  { key: "picker_count", label: "拣货员人数", group: "business", type: "number" },
  // —— 软件画像 ——
  { key: "current_system", label: "当前使用软件", group: "software", type: "text" },
  { key: "software_version", label: "软件品牌及版本", group: "software", type: "text" },
  { key: "next_gen_mobile_order", label: "是否新一代手机开单", group: "software", type: "text" },
  { key: "contract_expiry", label: "软件到期时间", group: "software", type: "date" },
  { key: "system_modules", label: "使用模块", group: "software", type: "text" },
  { key: "known_pains", label: "当前软件使用问题/主要痛点", group: "software", type: "text" },
  { key: "considering_switch", label: "是否考虑更换系统", group: "software", type: "text" },
  // —— 意愿画像 ——
  { key: "qince_interest", label: "是否愿意沟通了解勤策", group: "intent", type: "text" },
  { key: "purchase_intent", label: "当前购买意愿", group: "intent", type: "text" },
  { key: "expressed_needs", label: "已表达的需求", group: "intent", type: "text" },
  { key: "no_interest_reason", label: "暂无意愿的原因", group: "intent", type: "text" },
  { key: "has_clear_demand", label: "是否有明确需求", group: "intent", type: "text" },
  { key: "purchase_time", label: "采购计划", group: "intent", type: "text" },
  { key: "budget", label: "预算情况", group: "intent", type: "text" },
  // —— 决策画像 ——
  { key: "decision_maker", label: "决策人", group: "decision", type: "text" },
  { key: "is_boss_contact", label: "是否对接老板", group: "decision", type: "text" },
  { key: "decision_process", label: "决策流程", group: "decision", type: "text" },
  { key: "main_concerns", label: "主要顾虑", group: "decision", type: "text" },
  // —— 管理 ——
  { key: "remark", label: "备注", group: "management", type: "text" },
];

export const BUILTIN_LEAD_FIELD_KEYS: ReadonlySet<string> = new Set(
  BUILTIN_LEAD_FIELDS.map((field) => field.key),
);

/** 四个带核实状态列的关键事实字段（V1.0 §4.3「值列 + 状态列」成对设计）。
 * V2.0 起状态主存储为 lead_field_verifications，本组 statusKey 提交值
 * 作为对应字段的显式核实状态输入（同事务镜像到旧列，deprecated）。 */
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
    label: "软件到期时间",
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

/** FACT_STATUS_FIELDS.defKey → 旧状态列（camelCase），核实服务镜像写入用 */
export const LEGACY_STATUS_COLUMN_BY_FIELD: Readonly<Record<string, string>> =
  Object.fromEntries(
    FACT_STATUS_FIELDS.map((item) => [item.defKey, item.statusKey]),
  );

export const LEAD_FIELD_GROUP_LABELS: Record<LeadFieldGroup, string> = {
  basic: "基础画像",
  business: "业务画像",
  software: "软件画像",
  intent: "意愿画像",
  decision: "决策画像",
  management: "管理信息",
};

// ---------- V2.0 字段核实白名单（V2-T01，实施计划 §3.1） ----------

/**
 * 可核实的画像字段（四态 + 五元组）：核心 7（P5 完善度门槛）+ PRD 模块一其余
 * 重要字段 + 全部 V2.0 新增画像字段 ≈ 26 个 fieldKey。
 * 白名单外字段（联系方式/来源/备注/自定义字段等）不进入核实体系。
 */
export const PROFILE_VERIFIABLE_FIELDS: readonly string[] = [
  // 核心 7（P5）：全部核实（confirmed/stated）=「基本完善」门槛
  "current_system",
  "next_gen_mobile_order",
  "qince_interest",
  "contract_expiry",
  "industry",
  "main_category",
  "sales_team_scale",
  // PRD 模块一其余重要字段
  "revenue_range",
  "sales_team_size",
  "sales_mode",
  "known_pains",
  "purchase_time",
  "decision_maker",
  // V2.0 新增画像字段
  "software_version",
  "customer_count",
  "business_mgmt_mode",
  "order_mgmt_mode",
  "delivery_mgmt_mode",
  "finance_mgmt_mode",
  "warehouse_area",
  "warehouse_type",
  "picker_count",
  "purchase_intent",
  "expressed_needs",
  "no_interest_reason",
  "is_boss_contact",
];

export const VERIFIABLE_FIELD_KEYS: ReadonlySet<string> = new Set(
  PROFILE_VERIFIABLE_FIELDS,
);

/** 画像核心 7 字段（P5）：核心全核实=进入四象限前提 +「基本完善」门槛 */
export const PROFILE_CORE_FIELDS: readonly string[] = [
  "current_system",
  "next_gen_mobile_order",
  "qince_interest",
  "contract_expiry",
  "industry",
  "main_category",
  "sales_team_scale",
];

export const PROFILE_CORE_FIELD_KEYS: ReadonlySet<string> = new Set(
  PROFILE_CORE_FIELDS,
);
