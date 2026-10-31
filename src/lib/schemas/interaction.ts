import { z } from "zod";
import { normalizeExpiryInput } from "@/lib/expiry";

// 沟通记录入参 Schema（T06）：API 入参与前端表单共用（实施计划 §2.1）。
// 字段全集 = PRD §5.6；direction 为看板"呼出数"口径来源（K5/C08）。
//
// 设计要点：
// - occurred_at 允许补录过去时间，不允许未来（表单默认当前时间）；
// - effective 依赖 connected：未接通的沟通不可能"有效"（PRD 统一定义）；
// - 除 channel/direction/connected/effective 外全部可空（允许只记一次通话）；
// - confirmCurrentSystem / confirmPurchaseTime 是"本次确认"动作标记（UIUX §P5）：
//   仅提交时单向把对应画像核实状态置为已确认，不入库到本表、修正表单不含此项；
// - 文本统一 trim，空串归一化为 null（与线索 Schema 同一口径）。

export const INTERACTION_CHANNELS = ["phone", "wechat", "visit", "other"] as const;
export const INTERACTION_DIRECTIONS = ["outbound", "inbound"] as const;

export type InteractionChannel = (typeof INTERACTION_CHANNELS)[number];
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

export const CHANNEL_LABELS: Record<InteractionChannel, string> = {
  phone: "电话",
  wechat: "微信",
  visit: "拜访",
  other: "其他",
};

export const DIRECTION_LABELS: Record<InteractionDirection, string> = {
  outbound: "呼出",
  inbound: "呼入",
};

/** PRD §5.6 统一定义（表单常驻文案，UIUX §8.2 固定话术） */
export const EFFECTIVE_DEFINITION =
  "有效沟通 = 获得有价值的业务信息，或明确了双方认可的下一步动作。仅接通电话不等于有效沟通。";

/** edit_audit.changed 的字段键 → 展示名（M11 修改审计可读性） */
export const INTERACTION_FIELD_LABELS: Record<string, string> = {
  occurred_at: "沟通时间",
  channel: "沟通渠道",
  direction: "沟通方向",
  connected: "是否接通",
  effective: "是否有效沟通",
  feedback: "客户实际反馈",
  confirmed_pains: "已确认的业务痛点",
  current_system_confirmed: "客户当前系统",
  purchase_time_confirmed: "采购时间",
  decision_maker_note: "决策人情况",
  objections: "主要异议",
  next_action: "下一步动作",
  next_contact_at: "下次联系时间",
  is_qualified: "形成合格线索",
  demo_booked: "预约演示/拜访",
};

/** 本地日期时间（按 Asia/Shanghai 解释）+ 不允许晚于当前时间（5 分钟容差） */
const occurredAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/,
    "沟通时间格式应为 YYYY-MM-DD HH:mm",
  )
  .refine((value) => {
    const parsed = new Date(
      /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T00:00:00+08:00`
        : value.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"),
    );
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    return parsed.getTime() <= Date.now() + 5 * 60 * 1000;
  }, "沟通时间不能晚于当前时间");

const emptyToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value;

const optionalText = (max: number, label: string) =>
  z.preprocess(
    emptyToNull,
    z
      .string()
      .trim()
      .max(max, `${label}不能超过 ${max} 字`)
      .nullable()
      .optional(),
  );

const optionalMultilineText = (label: string) =>
  z.preprocess(
    emptyToNull,
    z.string().trim().max(2000, `${label}不能超过 2000 字`).nullable().optional(),
  );

const nextContactAtSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/,
      "下次联系时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm",
    )
    .nullable()
    .optional(),
);

/** V2.0（P4）：到期年月输入 YYYY-MM（含 2099-12 买断）或 YYYY（归一为当年 12 月） */
const expiryMonthConfirmedSchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeExpiryInput(value) : value),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "软件到期年月格式应为 YYYY-MM")
    .nullable()
    .optional(),
);

/** 可空布尔（是/否下拉；空 = 未确认） */
const optionalYesNo = () =>
  z.preprocess(
    (value) => {
      if (value === "" || value === null) {
        return null;
      }
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
      return value;
    },
    z
      .boolean({ message: "仅支持填写 是 / 否" })
      .nullable()
      .optional(),
  );

const baseInteractionFields = z.object({
  occurredAt: occurredAtSchema,
  channel: z.enum(INTERACTION_CHANNELS, {
    message: "沟通渠道须为 电话 / 微信 / 拜访 / 其他",
  }),
  direction: z.enum(INTERACTION_DIRECTIONS, {
    message: "沟通方向须为 呼出 / 呼入",
  }),
  connected: z.boolean({ message: "是否接通须为是 / 否" }),
  effective: z.boolean({ message: "是否有效沟通须为是 / 否" }),
  feedback: optionalMultilineText("客户实际反馈"),
  confirmedPains: optionalMultilineText("已确认的业务痛点"),
  currentSystemConfirmed: optionalText(128, "客户当前系统"),
  purchaseTimeConfirmed: optionalText(64, "采购时间"),
  decisionMakerNote: optionalText(255, "决策人情况"),
  objections: optionalMultilineText("主要异议"),
  nextAction: optionalText(255, "下一步动作"),
  nextContactAt: nextContactAtSchema,
  isQualified: z.boolean().optional(),
  demoBooked: z.boolean().optional(),
  confirmCurrentSystem: z.boolean().optional(),
  confirmPurchaseTime: z.boolean().optional(),
  // —— V2.0-T03「本次确认」扩展（UIUX §4.7；确认即同事务写值+置 confirmed）——
  /** 是否新一代手机开单（X 轴）：勾选时必填值 */
  confirmNextGen: z.boolean().optional(),
  nextGenConfirmed: optionalYesNo(),
  /** 是否愿意沟通了解勤策（Y 轴）：勾选时必填值 */
  confirmQinceInterest: z.boolean().optional(),
  qinceInterestConfirmed: optionalYesNo(),
  /** 软件到期年月：勾选时必填值（YYYY-MM；2099-12 = 买断） */
  confirmExpiry: z.boolean().optional(),
  expiryMonthConfirmed: expiryMonthConfirmedSchema,
});

// effective 依赖 connected 的交叉校验（zod v4：refine 必须放在 omit 之后叠加，
// 对含 refinement 的 schema 直接 omit 会抛错，故字段面与 refine 分两步组合）
const effectiveRequiresConnected = (
  value: { effective: boolean; connected: boolean },
) => !value.effective || value.connected;

/** AI 草稿来源 run（T10）：仅新建可携带；服务层校验归属/类型/状态后落库 */
const aiRunIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "AI 草稿来源标识不合法",
  )
  .optional();

// 修正（M11）：同一套字段校验；不含"本次确认"标记（一次性动作，不在修正中重复触发）。
export const interactionUpdateSchema = baseInteractionFields
  .omit({
    confirmCurrentSystem: true,
    confirmPurchaseTime: true,
    confirmNextGen: true,
    nextGenConfirmed: true,
    confirmQinceInterest: true,
    qinceInterestConfirmed: true,
    confirmExpiry: true,
    expiryMonthConfirmed: true,
  })
  .refine(effectiveRequiresConnected, {
    message: "未接通的沟通不能标记为有效沟通",
    path: ["effective"],
  });

// 交叉校验（create）：新一代/意愿/到期年月勾选确认时必须提供值
// （空值确认会让分类轴永远停在未知，直接拒绝并提示）。
export const interactionCreateSchema = baseInteractionFields
  .extend({ aiRunId: aiRunIdSchema })
  .refine(effectiveRequiresConnected, {
    message: "未接通的沟通不能标记为有效沟通",
    path: ["effective"],
  })
  .superRefine((value, ctx) => {
    if (value.confirmNextGen && (value.nextGenConfirmed ?? null) === null) {
      ctx.addIssue({
        code: "custom",
        path: ["nextGenConfirmed"],
        message: "勾选确认「是否新一代」时请先选择 是 / 否",
      });
    }
    if (
      value.confirmQinceInterest &&
      (value.qinceInterestConfirmed ?? null) === null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["qinceInterestConfirmed"],
        message: "勾选确认「沟通意愿」时请先选择 是 / 否",
      });
    }
    if (value.confirmExpiry && !value.expiryMonthConfirmed) {
      ctx.addIssue({
        code: "custom",
        path: ["expiryMonthConfirmed"],
        message: "勾选确认「软件到期年月」时请先选择年月（买断选 2099-12）",
      });
    }
  });

export type InteractionCreateInput = z.infer<typeof interactionCreateSchema>;
export type InteractionUpdateInput = z.infer<typeof interactionUpdateSchema>;
