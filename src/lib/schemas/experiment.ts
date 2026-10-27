import { z } from "zod";

// 实验分组入参 Schema（T14，PRD §5.10 / UIUX P8 / M3、C04）：
// - 创建即草稿：名称 + 圈选条件（来源/行业精确、阶段当前快照、负责人）+
//   AI 辅助组占比（10–90 整数百分比，默认 50）+ 最小样本阈值（默认 50）；
// - 更新：草稿可改配置；进行中仅接受 {status:"closed"}（关闭实验）；
//   配置字段与 status 混传一律拒绝（不静默忽略——与批量白名单同一哲学）；
//   分组执行后配置冻结（C04"分组后固定不可改"）。
// 负责人 ownerId 仅管理员语义有效，与看板圈选同约定（服务层兜底）。

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID 格式不合法",
  );

const optionalFilter = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label}不能为空`)
    .max(max, `${label}最长 ${max} 字`)
    .optional();

export const EXPERIMENT_MIN_RATIO = 10;
export const EXPERIMENT_MAX_RATIO = 90;
export const EXPERIMENT_MAX_NAME_LENGTH = 64;

const assistedRatioSchema = z
  .number()
  .int("分组比例须为整数百分比")
  .min(EXPERIMENT_MIN_RATIO, `分组比例最低 ${EXPERIMENT_MIN_RATIO}%`)
  .max(EXPERIMENT_MAX_RATIO, `分组比例最高 ${EXPERIMENT_MAX_RATIO}%`);

const minSampleSizeSchema = z
  .number()
  .int("最小样本阈值须为整数")
  .min(1, "最小样本阈值至少为 1")
  .max(100000, "最小样本阈值过大");

export const experimentCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "实验名称不能为空")
    .max(
      EXPERIMENT_MAX_NAME_LENGTH,
      `实验名称最长 ${EXPERIMENT_MAX_NAME_LENGTH} 字`,
    ),
  source: optionalFilter("客户来源", 64),
  industry: optionalFilter("行业", 64),
  stageId: uuidSchema.optional(),
  ownerId: uuidSchema.optional(),
  assistedRatio: assistedRatioSchema.default(50),
  minSampleSize: minSampleSizeSchema.default(50),
});

// 服务层入参用 z.input：assistedRatio/minSampleSize 可缺省（服务层兜底默认值）；
// API 路由先经 schema.parse（default 已应用）再传入，两种调用形态皆可。
export type ExperimentCreateInput = z.input<typeof experimentCreateSchema>;

// 更新 shape 的数值字段不带 default——缺省键必须保持 undefined，
// 否则空对象/关闭请求会被默认值误判为"提供了配置"。
const updateConfigShape = {
  name: experimentCreateSchema.shape.name.optional(),
  source: optionalFilter("客户来源", 64),
  industry: optionalFilter("行业", 64),
  stageId: uuidSchema.optional(),
  ownerId: uuidSchema.optional(),
  assistedRatio: assistedRatioSchema.optional(),
  minSampleSize: minSampleSizeSchema.optional(),
} as const;

export const experimentUpdateSchema = z
  .object({
    ...updateConfigShape,
    status: z.literal("closed").optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status !== undefined) {
      const configKeys = Object.keys(updateConfigShape) as Array<
        keyof typeof updateConfigShape
      >;
      const withConfig = configKeys.find(
        (key) => value[key] !== undefined,
      );
      if (withConfig) {
        ctx.addIssue({
          code: "custom",
          path: [withConfig],
          message: "关闭实验不能同时修改其他配置",
        });
      }
      return;
    }
    const hasAny = configKeysOf(value).length > 0;
    if (!hasAny) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "请至少提供一项要修改的内容",
      });
    }
  });

/** 与批量修改同款：只挑出实际提供的键（Schema 层不引入额外依赖） */
function configKeysOf(value: Record<string, unknown>): string[] {
  return Object.keys(updateConfigShape).filter(
    (key) => value[key] !== undefined,
  );
}

export type ExperimentUpdateInput = z.infer<typeof experimentUpdateSchema>;
