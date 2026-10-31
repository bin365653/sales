import { LeadFieldVerification, Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import {
  LEGACY_STATUS_COLUMN_BY_FIELD,
  VERIFIABLE_FIELD_KEYS,
} from "@/lib/lead-fields";
import { toUtcDateString } from "@/lib/format";
import { FACT_STATUSES } from "@/lib/schemas/lead";

// 字段核实元数据服务（V2.0-T01，实施计划 §3.1 五元组 + P2 四态）。
//
// 关键不变量：
// - 状态主存储 = lead_field_verifications（unique(lead_id, field_key)）；
//   V1.0 四个旧状态列同事务镜像（LEGACY_STATUS_COLUMN_BY_FIELD），只写不改读语义
//   （优先级规则 / AI context / 详情徽章三处旧读取点不漂移，deprecated 待下线）；
// - 值变化 → 状态自动置 unverified 并更新核实人/时间（修复 V1.0「值变状态不变」缺陷）；
//   清空值 → unknown（本来就 unknown 且无行时不写）；显式提交的状态输入优先；
// - 写入必须发生在调用方事务内（applyVerificationWrites 传 tx），任一步失败整体回滚；
// - 白名单（VERIFIABLE_FIELD_KEYS）外的字段不进入核实体系。
//
// 口径提示：进入四象限的「确认」= confirmed 或 stated（P3，V2-T04 evaluateQuadrant）。

export type Db = Prisma.TransactionClient | typeof prisma;

export type FactStatusValue = (typeof FACT_STATUSES)[number];
export type VerificationSourceValue =
  | "manual"
  | "import"
  | "interaction"
  | "initial";

export interface VerificationWrite {
  fieldKey: string;
  status: FactStatusValue;
  source: VerificationSourceValue;
  verifiedBy: string | null;
  verifiedAt: Date | null;
}

/** 事件 changed 条目（snake_case 字段名 → 变更明细；from/to 为序列化展示值） */
export interface FieldChange {
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  statusFrom?: FactStatusValue;
  statusTo?: FactStatusValue;
}

export interface ComputedVerificationWrites {
  writes: VerificationWrite[];
  /** 值/状态变更明细（核实字段 + 联系方式脱敏占位），供 updated 事件 detail.changed */
  changed: Record<string, FieldChange>;
  /** 需镜像到 leads 旧状态列的值（camelCase 列名 → status） */
  legacyMirrors: Record<string, FactStatusValue>;
}

// ---------- 读取 ----------

export async function getFieldVerifications(
  leadId: string,
): Promise<LeadFieldVerification[]> {
  return prisma.leadFieldVerification.findMany({ where: { leadId } });
}

/** 事件/展示用的值序列化：Date → YYYY-MM-DD（UTC 日期列口径），空值归 null */
export function serializeLeadValue(value: unknown): string | number | boolean | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (value instanceof Date) {
    return toUtcDateString(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  return String(value);
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

/** 白名单校验（Schema 已拦一次，服务层兜底防内部调用方绕过） */
export function assertVerifiableKeys(fieldKeys: string[]): void {
  const violated = fieldKeys.filter((key) => !VERIFIABLE_FIELD_KEYS.has(key));
  if (violated.length > 0) {
    throw new ApiError(
      400,
      "verification_field_invalid",
      `字段「${violated.join("、")}」不可核实`,
    );
  }
}

// ---------- 现状读取辅助 ----------

/** 现存核实状态：行优先，V1.0 旧状态列兜底（迁移前数据/未写行场景） */
export function resolveExistingStatus(
  rows: Pick<LeadFieldVerification, "fieldKey" | "status">[],
  fieldKey: string,
  legacyStatuses: Record<string, string>,
): FactStatusValue {
  const row = rows.find((item) => item.fieldKey === fieldKey);
  if (row) {
    return row.status;
  }
  const legacyColumn = LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey];
  if (legacyColumn) {
    const legacy = legacyStatuses[legacyColumn];
    if (
      legacy === "unknown" ||
      legacy === "unverified" ||
      legacy === "stated" ||
      legacy === "confirmed"
    ) {
      return legacy;
    }
  }
  return "unknown";
}

/**
 * 收集显式核实状态输入：verifications map（snake_case）+ V1.0 旧状态键别名
 * （currentSystemStatus 等，表单/老客户端兼容通道）。
 * 同一字段两处同提交且冲突时 verifications map 优先。
 */
export function collectExplicitStatuses(
  input: Record<string, unknown>,
): Record<string, FactStatusValue> {
  const map = input.verifications;
  const result: Record<string, FactStatusValue> = {};
  if (typeof map === "object" && map !== null) {
    for (const [key, value] of Object.entries(map)) {
      if (typeof value === "string") {
        result[key] = value as FactStatusValue;
      }
    }
  }
  for (const legacyColumn of Object.values(LEGACY_STATUS_COLUMN_BY_FIELD)) {
    const value = input[legacyColumn];
    if (typeof value !== "string") {
      continue;
    }
    const fieldKey = Object.entries(LEGACY_STATUS_COLUMN_BY_FIELD).find(
      ([, column]) => column === legacyColumn,
    )?.[0];
    if (fieldKey && result[fieldKey] === undefined) {
      result[fieldKey] = value as FactStatusValue;
    }
  }
  assertVerifiableKeys(Object.keys(result));
  return result;
}

// ---------- 写入计算（纯逻辑，便于单测） ----------

const VALUE_FIELD_CAMEL_TO_SNAKE = (key: string): string =>
  key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** V1.0 旧状态列的 snake_case 键（非值字段，值变更明细中跳过） */
const LEGACY_STATUS_SNAKE_KEYS: ReadonlySet<string> = new Set(
  Object.values(LEGACY_STATUS_COLUMN_BY_FIELD).map((column) =>
    VALUE_FIELD_CAMEL_TO_SNAKE(column),
  ),
);

/** 联系方式不落明文（脱敏原则延续）：只记「已变更」不记值 */
export const MASKED_EVENT_VALUE = "[已变更]";

interface ComputeInput {
  mode: "create" | "update";
  /** update 必传：库中现值（Prisma Lead 行） */
  existing?: Record<string, unknown> | null;
  /** update 必传：现存核实行 */
  existingRows?: Pick<LeadFieldVerification, "fieldKey" | "status">[];
  /** 本次提交的值输入（camelCase；undefined=未触及，null=显式清空）。
   * 约定传 Prisma 数据对象（createScalarData/updateScalarData 的返回值），
   * 键恰好 = 触及的字段，已含日期归一。 */
  submittedValues: Record<string, unknown>;
  /** 显式核实状态输入（snake_case fieldKey → status；由 collectExplicitStatuses 归并） */
  explicitStatuses: Record<string, FactStatusValue>;
  source: VerificationSourceValue;
  actorId: string | null;
  now: Date;
}

/**
 * 计算核实写入 + 旧列镜像 + changed 明细。
 *
 * 优先级（create / update 一致）：
 * 1. 显式提交的状态输入恒优先（含表单随值重复提交的现状值——用户带着状态下拉
 *    改值，视同对新值确认）；
 * 2. 无显式状态时：create 且值非空 → unverified；update 且值变化 → 非空 unverified /
 *    清空 unknown（本来就 unknown 不写）；
 * 3. 白名单外字段不产生核实写入（值变更仍进 changed 明细，联系方式脱敏）。
 */
export function computeVerificationWrites(input: ComputeInput): ComputedVerificationWrites {
  const { mode, submittedValues, explicitStatuses, source, actorId, now } = input;
  const existing = input.existing ?? null;
  const existingRows = input.existingRows ?? [];
  const legacyStatuses: Record<string, string> = {};
  if (existing) {
    for (const column of Object.values(LEGACY_STATUS_COLUMN_BY_FIELD)) {
      const value = existing[column];
      if (typeof value === "string") {
        legacyStatuses[column] = value;
      }
    }
  }

  const writes: VerificationWrite[] = [];
  const changed: Record<string, FieldChange> = {};
  const legacyMirrors: Record<string, FactStatusValue> = {};

  const writeOf = (fieldKey: string, status: FactStatusValue): void => {
    writes.push({
      fieldKey,
      status,
      source,
      verifiedBy: actorId,
      verifiedAt: now,
    });
    const legacyColumn = LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey];
    if (legacyColumn) {
      legacyMirrors[legacyColumn] = status;
    }
  };

  // —— 白名单内：值变化 / 显式状态 → 核实写入 ——
  for (const fieldKey of VERIFIABLE_FIELD_KEYS) {
    const camel = fieldKey.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const explicit = explicitStatuses[fieldKey];
    const existingStatus = resolveExistingStatus(existingRows, fieldKey, legacyStatuses);

    if (!(camel in submittedValues)) {
      // 值未触及：仅「显式状态 ≠ 现状」触发状态写入
      if (explicit !== undefined && explicit !== existingStatus) {
        writeOf(fieldKey, explicit);
        const current = existing ? serializeLeadValue(existing[camel]) : null;
        changed[fieldKey] = {
          from: current,
          to: current,
          statusFrom: existingStatus,
          statusTo: explicit,
        };
      }
      continue;
    }

    const submitted = submittedValues[camel];
    const oldSerialized = existing ? serializeLeadValue(existing[camel]) : null;
    const newSerialized = serializeLeadValue(submitted);
    const valueChanged =
      mode === "create"
        ? !isEmptyValue(submitted)
        : oldSerialized !== newSerialized;

    let target: FactStatusValue | null = null;
    if (explicit !== undefined) {
      target = explicit;
    } else if (mode === "create") {
      target = !isEmptyValue(submitted) ? "unverified" : null;
    } else if (valueChanged) {
      target = newSerialized === null ? "unknown" : "unverified";
    }

    const statusChanged = target !== null && target !== existingStatus;
    // 状态变化必写；状态不变但值已变也写（刷新核实人/时间 = 新的核实动作）
    if (target !== null && (statusChanged || valueChanged)) {
      writeOf(fieldKey, target);
    }
    if (valueChanged || statusChanged) {
      changed[fieldKey] = {
        from: oldSerialized,
        to: newSerialized,
        statusFrom: existingStatus,
        statusTo: target ?? existingStatus,
      };
    }
  }

  // —— 白名单外：值变更仍记入 changed（联系方式脱敏）——
  for (const [camel, submitted] of Object.entries(submittedValues)) {
    const snake = VALUE_FIELD_CAMEL_TO_SNAKE(camel);
    if (
      changed[snake] !== undefined ||
      VERIFIABLE_FIELD_KEYS.has(snake) ||
      LEGACY_STATUS_SNAKE_KEYS.has(snake)
    ) {
      continue;
    }
    const oldSerialized = existing ? serializeLeadValue(existing[camel]) : null;
    const newSerialized = serializeLeadValue(submitted);
    if (mode === "update" && oldSerialized === newSerialized) {
      continue;
    }
    if (mode === "create" && isEmptyValue(submitted)) {
      continue;
    }
    changed[snake] =
      snake === "contact_phone"
        ? { from: MASKED_EVENT_VALUE, to: MASKED_EVENT_VALUE }
        : { from: oldSerialized, to: newSerialized };
  }

  return { writes, changed, legacyMirrors };
}

// ---------- 事务内落库 ----------

/** 在调用方事务内 upsert 核实行（调用方保证与线索行写入同事务） */
export async function applyVerificationWrites(
  tx: Db,
  leadId: string,
  writes: VerificationWrite[],
): Promise<void> {
  for (const write of writes) {
    await tx.leadFieldVerification.upsert({
      where: {
        leadId_fieldKey: { leadId, fieldKey: write.fieldKey },
      },
      create: {
        leadId,
        fieldKey: write.fieldKey,
        status: write.status,
        source: write.source,
        verifiedBy: write.verifiedBy,
        verifiedAt: write.verifiedAt,
      },
      update: {
        status: write.status,
        source: write.source,
        verifiedBy: write.verifiedBy,
        verifiedAt: write.verifiedAt,
      },
    });
  }
}

/** 核实状态 → 展示文案（format.ts FACT_STATUS_LABELS 的服务端别名，导出复用） */
export function formatVerificationStatus(status: string): string {
  switch (status) {
    case "confirmed":
      return "已确认";
    case "stated":
      return "客户自述待复核";
    case "unverified":
      return "待核实";
    default:
      return "未知";
  }
}

/** Prisma 输入类型守卫：JSONB detail 写入用（避免 as 强转散落） */
export function asEventDetail(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
