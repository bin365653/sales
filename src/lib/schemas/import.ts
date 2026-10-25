import { z } from "zod";
import { leadListQuerySchema } from "@/lib/schemas/lead";

// 导入 / 导出入参 Schema（T05）：与 §6 导入导出端点一一对应。
//
// - mapping 键为文件列下标（字符串化的 0..n），值为目标字段 key（内置物理列名或
//   自定义字段 key）或 null（该列不导入）；目标合法性（存在且启用、无重复目标、
//   必须映射客户名称）由服务层结合库中字段定义校验；
// - decisions 仅允许 skip / create_new（M2：只允许"跳过/仍新建"，不静默覆盖），
//   错误行的决定固定为跳过（服务层钳制）；
// - 导出筛选复用线索列表同一 Schema → 导出范围与列表口径必然一致（验收项）。

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "ID 格式不合法",
  );

// ---------- 保存映射（PATCH /api/imports/:id） ----------

export const importMappingSchema = z.object({
  mapping: z.record(z.string(), z.string().nullable()),
});

export type ImportMappingInput = z.infer<typeof importMappingSchema>;

// ---------- 确认导入（POST /api/imports/:id/confirm） ----------

export const importConfirmSchema = z.object({
  decisions: z
    .array(
      z.object({
        rowId: uuidSchema,
        decision: z.enum(["skip", "create_new"], {
          message: "导入决定须为 skip / create_new",
        }),
      }),
    )
    .max(5000, "决定条目过多")
    .optional(),
});

export type ImportConfirmInput = z.infer<typeof importConfirmSchema>;

// ---------- 预览行查询（GET /api/imports/:id/rows） ----------

export const importRowsQuerySchema = z.object({
  tab: z.enum(["all", "valid", "error", "dup"]).default("all"),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export type ImportRowsQuery = z.infer<typeof importRowsQuerySchema>;

// ---------- 创建导出（POST /api/exports/leads） ----------

export const leadsExportCreateSchema = z.object({
  format: z.enum(["xlsx", "csv"], { message: "导出格式须为 xlsx / csv" }),
  /** 缺省 = 不附加筛选（仍受数据范围强制约束：销售=本人，管理员=全量） */
  filters: leadListQuerySchema.optional(),
});

export type LeadsExportCreateInput = z.infer<typeof leadsExportCreateSchema>;
