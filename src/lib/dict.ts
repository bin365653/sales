// 数据字典元数据（V2.0-T02，实施计划 §3.1 / 决策 D1 / D5）。
//
// 本期开放字典的 12 个画像字段（白名单）：字典值由管理员在设置中心维护，
// 启用后（lead_field_defs.dict_enabled=true，存在 ≥1 启用值即启用）
// 新建/编辑/导入值必须 ∈ 字典启用值；存量非字典值可继续显示，编辑时须改选。
//
// current_system 专用 meta.isNextGen：标记「新一代手机开单系统」
// （舟谱/爱快消/商圈云），驱动表单建议条（4.7 流程：建议必经人工确认）。

/** 本期支持数据字典的字段（snake_case，= leads 物理列名） */
export const DICT_FIELD_KEYS: readonly string[] = [
  "current_system",
  "industry",
  "main_category",
  "revenue_range",
  "sales_team_scale",
  "sales_mode",
  "business_mgmt_mode",
  "order_mgmt_mode",
  "delivery_mgmt_mode",
  "finance_mgmt_mode",
  "warehouse_type",
  "purchase_intent",
];

export const DICT_FIELD_KEY_SET: ReadonlySet<string> = new Set(DICT_FIELD_KEYS);

/** 字典字段的默认展示名（lead_field_defs.label 可被管理员改名覆盖） */
export const DICT_FIELD_LABELS: Record<string, string> = {
  current_system: "当前使用软件",
  industry: "行业细分",
  main_category: "主营品类",
  revenue_range: "营收区间",
  sales_team_scale: "业务员规模",
  sales_mode: "销售模式",
  business_mgmt_mode: "业务管理方式",
  order_mgmt_mode: "订单管理方式",
  delivery_mgmt_mode: "配送管理方式",
  finance_mgmt_mode: "财务管理方式",
  warehouse_type: "平仓/立体仓",
  purchase_intent: "当前购买意愿",
};

export interface DictEntryMeta {
  /** current_system 专用：是否新一代手机开单系统（决策 D1） */
  isNextGen?: boolean;
  [key: string]: unknown;
}

/** 字典条目视图（API / 表单共用；label 即 value——字典值就是标准存储值） */
export interface DictEntryView {
  id: string;
  value: string;
  meta: DictEntryMeta | null;
  sortOrder: number;
  isActive: boolean;
}

/** 从条目 meta 安全取 isNextGen（非布尔忽略） */
export function isNextGenMeta(meta: unknown): boolean {
  if (typeof meta !== "object" || meta === null) {
    return false;
  }
  return (meta as { isNextGen?: unknown }).isNextGen === true;
}
