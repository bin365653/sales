import { notFound, redirect } from "next/navigation";
import type { Lead } from "@prisma/client";
import { getCurrentUser } from "@/server/auth/current-user";
import { getLeadDetail } from "@/server/services/leads";
import { listInteractions } from "@/server/services/interactions";
import { listLeadTasks } from "@/server/services/tasks";
import { listFieldDefs } from "@/server/services/lead-fields";
import { listStages } from "@/server/services/stages";
import { getUserNames } from "@/server/services/users";
import { listLeadAiRuns } from "@/server/ai/runner";
import { getTodayUsage } from "@/server/ai/rate-limit";
import { resolveActivePromptVersion } from "@/server/ai/prompt-registry";
import { getRunningExperimentGroups } from "@/server/services/experiments";
import { getActiveDictOptionMap } from "@/server/services/dicts";
import { toAiRunView, type AiRunView } from "@/lib/ai-run-view";
import type { RunTypeValue } from "@/lib/schemas/ai";
import {
  toDateTimeInputValue,
  toShanghaiDateString,
  toShanghaiDateTimeString,
} from "@/lib/format";
import {
  FACT_STATUS_FIELDS,
  buildBuiltinFormFields,
  buildCustomFormFields,
  buildFieldLabelMap,
  FORM_GROUP_ORDER,
  LEAD_FIELD_GROUP_LABELS,
  type FieldDefRow,
} from "@/lib/lead-form-fields";
import {
  LEGACY_STATUS_COLUMN_BY_FIELD,
  PROFILE_CORE_FIELDS,
  VERIFIABLE_FIELD_KEYS,
} from "@/lib/lead-fields";
import { formatExpiryChip } from "@/lib/expiry";
import { evaluateQuadrant, QUADRANT_ADVICE } from "@/lib/quadrant";
import { FACT_STATUS_LABELS } from "@/lib/format";
import { QUADRANT_LABELS } from "@/components/leads/quadrant-badge";
import type { VerifyMeta } from "@/components/leads/lead-detail-client";
import type { FieldOption } from "@/lib/lead-field-validation";
import {
  InteractionAuditEntry,
  InteractionView,
} from "@/components/leads/interactions-panel";
import { toTaskView } from "@/components/tasks/task-view";
import { LeadDetailClient } from "@/components/leads/lead-detail-client";

export const dynamic = "force-dynamic";

// P5 客户详情（T04）：画像全部字段 + 核实状态徽标 + 阶段时间线（lead_events）。
// 服务端完成全部数据整形（时间/文案/字段名映射），客户端组件只负责
// 查看/编辑切换、阶段流转与删除的交互。沟通记录区块随 T06 交付；
// 任务区块随 T07 交付；AI 面板随 T09 交付（含错误边界，AI 异常不影响页面）。

interface StageSnapshotEntryLike {
  id: string;
  code: string;
  name: string;
  semanticKey: string | null;
}

interface EventRow {
  id: string;
  eventType: string;
  fromStageId: string | null;
  toStageId: string | null;
  stageSnapshot: unknown;
  detail: unknown;
  actorId: string | null;
  occurredAt: Date;
}

function asSnapshot(raw: unknown): {
  from?: StageSnapshotEntryLike;
  to?: StageSnapshotEntryLike;
} | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return raw as { from?: StageSnapshotEntryLike; to?: StageSnapshotEntryLike };
}

function asDetail(raw: unknown): {
  fields?: unknown[];
  batch?: boolean;
  reason?: string;
  source?: string;
  changed?: Record<
    string,
    { from?: unknown; to?: unknown; statusFrom?: string; statusTo?: string }
  >;
} | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return raw as {
    fields?: unknown[];
    batch?: boolean;
    reason?: string;
    source?: string;
    changed?: Record<
      string,
      { from?: unknown; to?: unknown; statusFrom?: string; statusTo?: string }
    >;
  };
}

function optionsOf(def: FieldDefRow): FieldOption[] {
  if (!Array.isArray(def.options)) {
    return [];
  }
  return def.options.filter(
    (item): item is FieldOption =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as FieldOption).value === "string" &&
      typeof (item as FieldOption).label === "string",
  );
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const { id } = await params;

  let detail: {
    lead: Lead & { stage: { id: string; name: string; sortOrder: number } };
    events: EventRow[];
    verifications: {
      fieldKey: string;
      status: string;
      source: string;
      verifiedBy: string | null;
      verifiedAt: Date | null;
    }[];
  };
  try {
    detail = (await getLeadDetail(user, id)) as unknown as typeof detail;
  } catch {
    notFound();
  }

  const [defs, stages, actorNames, interactions, tasks, dictMap] = await Promise.all([
    listFieldDefs({ activeOnly: false }),
    listStages({ activeOnly: true }),
    getUserNames(
      [
        ...detail.events
          .map((event) => event.actorId)
          .filter((actorId): actorId is string => actorId !== null),
        // 核实历史/五元组展示：核实人姓名（V2.0-T01/T03）
        ...detail.verifications
          .map((row) => row.verifiedBy)
          .filter((id): id is string => id !== null),
      ],
    ),
    listInteractions(user, id),
    listLeadTasks(user, id),
    getActiveDictOptionMap(),
  ]);

  // AI 面板初始数据（T09）：首屏整形与客户端轮询共用 toAiRunView；
  // 提示词版本仅展示用，缺失时降级（发起 run 时服务层仍会 fail fast）。
  const aiRuns: AiRunView[] = (await listLeadAiRuns(user, id).catch(() => [])).map(
    (run) => toAiRunView(run),
  );
  const aiUsage = await getTodayUsage(user.id).catch(() => ({ used: 0, limit: 0 }));
  const activePromptVersions: Partial<Record<RunTypeValue, number | null>> = {};
  for (const runType of ["analysis", "call_prep", "interaction_summary"] as RunTypeValue[]) {
    try {
      activePromptVersions[runType] = (await resolveActivePromptVersion(runType)).version;
    } catch {
      activePromptVersions[runType] = null;
    }
  }

  const now = new Date();
  // 实验分组（T14）：进行中实验覆盖该线索时展示 GroupBadge；
  // 常规组 → AI 面板替换为说明卡（前端隐藏入口 + 服务端 403 双防线）
  const experimentGroups = await getRunningExperimentGroups([detail.lead.id]);
  const experimentGroup = experimentGroups.get(detail.lead.id) ?? null;
  const taskViews = tasks.map((task) =>
    toTaskView(
      {
        ...task,
        lead: {
          id: detail.lead.id,
          name: detail.lead.name,
          stageName: detail.lead.stage.name,
          stageSortOrder: detail.lead.stage.sortOrder,
          contractExpiry: detail.lead.contractExpiry,
          expiryStatus:
            detail.verifications?.find((row) => row.fieldKey === "contract_expiry")
              ?.status ?? null,
        },
      },
      now,
    ),
  );

  const interactionRows: InteractionView[] = interactions.map((row) => ({
    id: row.id,
    occurredAtDisplay: toShanghaiDateTimeString(row.occurredAt),
    occurredAtInput: toDateTimeInputValue(row.occurredAt),
    channel: row.channel,
    direction: row.direction,
    connected: row.connected,
    effective: row.effective,
    feedback: row.feedback,
    confirmedPains: row.confirmedPains,
    currentSystemConfirmed: row.currentSystemConfirmed,
    purchaseTimeConfirmed: row.purchaseTimeConfirmed,
    decisionMakerNote: row.decisionMakerNote,
    objections: row.objections,
    nextAction: row.nextAction,
    nextContactAtDisplay: row.nextContactAt
      ? toShanghaiDateTimeString(row.nextContactAt)
      : null,
    nextContactAtInput: row.nextContactAt
      ? toDateTimeInputValue(row.nextContactAt)
      : null,
    isQualified: row.isQualified,
    demoBooked: row.demoBooked,
    aiRunId: row.aiRunId,
    userName: actorNames.get(row.userId) ?? null,
    editAudit: (Array.isArray(row.editAudit) ? row.editAudit : []).map(
      (entry): InteractionAuditEntry => {
        const raw = entry as { at?: unknown; by?: unknown; changed?: unknown };
        return {
          at: typeof raw.at === "string" ? raw.at : "",
          by: typeof raw.by === "string" ? raw.by : "",
          byName: (typeof raw.by === "string" && actorNames.get(raw.by)) || null,
          changed:
            typeof raw.changed === "object" && raw.changed !== null
              ? (raw.changed as InteractionAuditEntry["changed"])
              : {},
        };
      },
    ),
  }));
  const fieldDefs: FieldDefRow[] = defs.map((def) => ({
    key: def.key,
    label: def.label,
    isActive: def.isActive,
    isBuiltin: def.isBuiltin,
    type: def.type,
    options: def.options,
    validation: def.validation,
  }));

  const lead = detail.lead;
  const customValues = (lead.customValues ?? {}) as Record<string, unknown>;
  const builtinFields = buildBuiltinFormFields(fieldDefs);
  const customFields = buildCustomFormFields(fieldDefs);
  const labelMap = buildFieldLabelMap(fieldDefs);

  // ---------- V2.0 核实状态（verification-first，V2.0-T01/T03） ----------

  const verificationByField = new Map(
    detail.verifications.map((row) => [row.fieldKey, row]),
  );

  /** 核实行优先；V1.0 四个旧状态列兜底；缺省 unknown */
  function statusOf(fieldKey: string): string {
    const row = verificationByField.get(fieldKey);
    if (row) {
      return row.status;
    }
    const legacyColumn = LEGACY_STATUS_COLUMN_BY_FIELD[fieldKey];
    if (legacyColumn) {
      const value = (lead as unknown as Record<string, string>)[legacyColumn];
      if (value) {
        return value;
      }
    }
    return "unknown";
  }

  const VERIFICATION_SOURCE_LABELS: Record<string, string> = {
    manual: "人工录入",
    import: "导入",
    interaction: "沟通确认",
    initial: "系统初始化",
  };

  /** 五元组（来源/核实人/核实时间）：未知且无动作痕迹时不展示 */
  function verifyMetaOf(fieldKey: string): VerifyMeta | undefined {
    if (!VERIFIABLE_FIELD_KEYS.has(fieldKey)) {
      return undefined;
    }
    const row = verificationByField.get(fieldKey);
    if (!row || (row.status === "unknown" && row.source === "initial")) {
      return undefined;
    }
    return {
      source: VERIFICATION_SOURCE_LABELS[row.source] ?? row.source,
      person: row.verifiedBy ? (actorNames.get(row.verifiedBy) ?? null) : null,
      time: row.verifiedAt ? toShanghaiDateTimeString(row.verifiedAt) : null,
    };
  }

  // ---------- 展示值 ----------

  function displayOf(key: string): string {
    const value = (lead as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined || value === "") {
      return "—";
    }
    if (typeof value === "boolean") {
      return value ? "是" : "否";
    }
    return String(value);
  }

  interface DisplayField {
    label: string;
    text: string;
    factStatus?: string;
    verifyMeta?: VerifyMeta;
  }
  // V2.0（P4）：软件到期一律显示年月（ExpiryChip 语义文案，买断 2099-12）
  const expiryDisplay = lead.contractExpiry
    ? formatExpiryChip(lead.contractExpiry, now, {
        status: statusOf("contract_expiry"),
      })
    : null;
  const groups = FORM_GROUP_ORDER.map((group) => {
    const fields: DisplayField[] = builtinFields
      .filter((field) => field.group === group)
      .map((field) => {
        const verifiable = VERIFIABLE_FIELD_KEYS.has(field.defKey);
        return {
          label: field.label,
          text:
            field.key === "contractExpiry" && expiryDisplay
              ? expiryDisplay
              : displayOf(field.key),
          ...(verifiable
            ? {
                factStatus: statusOf(field.defKey),
                verifyMeta: verifyMetaOf(field.defKey),
              }
            : {}),
        };
      });
    return { title: LEAD_FIELD_GROUP_LABELS[group], fields };
  });

  // 自定义字段：启用中的展示；停用但仍有值的也展示（标注已停用，不静默隐藏）
  const customDisplay = customFields.map((field) => {
    const value = customValues[field.key];
    const def = fieldDefs.find((row) => row.key === field.key);
    const text =
      value === null || value === undefined || value === ""
        ? "—"
        : field.input === "single_select"
          ? (optionsOf(def!).find((option) => option.value === value)?.label ??
            String(value))
          : String(value);
    return { label: field.label, text, archived: false };
  });
  for (const def of fieldDefs) {
    if (def.isBuiltin || def.isActive) {
      continue;
    }
    const value = customValues[def.key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const text =
      def.type === "single_select"
        ? (optionsOf(def).find((option) => option.value === value)?.label ??
          String(value))
        : String(value);
    customDisplay.push({ label: def.label, text, archived: true });
  }

  // ---------- 时间线 ----------

  const timeline = detail.events
    .map((event) => {
      const snapshot = asSnapshot(event.stageSnapshot);
      const detailInfo = asDetail(event.detail);
      const actor = event.actorId ? actorNames.get(event.actorId) : null;
      let title: string;
      let detailText: string | null = null;
      switch (event.eventType) {
        case "created":
          title = "创建客户";
          detailText = snapshot?.to
            ? `初始阶段：${snapshot.to.name}`
            : null;
          break;
        case "imported":
          title = "导入创建";
          break;
        case "updated": {
          title =
            detailInfo?.source === "interaction"
              ? "沟通确认更新画像"
              : detailInfo?.batch
                ? "批量修改资料"
                : "修改资料";
          const fields = (detailInfo?.fields ?? [])
            .map((field) => labelMap.get(String(field)) ?? String(field))
            .filter(Boolean);
          detailText = fields.length > 0 ? fields.join("、") : null;
          break;
        }
        case "stage_changed":
          title = "阶段流转";
          detailText =
            snapshot?.from && snapshot?.to
              ? `${snapshot.from.name} → ${snapshot.to.name}${
                  detailInfo?.reason === "interaction_advance"
                    ? "（沟通记录联动）"
                    : ""
                }`
              : null;
          break;
        case "deleted":
          title = "删除客户";
          break;
        case "quadrant_changed": {
          title = "分类变化";
          const info = asDetail(event.detail) as {
            from?: string | null;
            to?: string | null;
          } | null;
          detailText =
            info && (info.from || info.to)
              ? `${QUADRANT_LABELS[(info.from ?? "pending") as "pending"]} → ${QUADRANT_LABELS[(info.to ?? "pending") as "pending"]}（依据双维核实状态快照）`
              : null;
          break;
        }
        default:
          title = event.eventType;
      }
      return {
        id: event.id,
        eventType: event.eventType,
        title,
        detailText,
        actorName: actor ?? null,
        occurredAt: toShanghaiDateTimeString(event.occurredAt),
      };
    })
    .reverse(); // 最新在前

  // ---------- V2.0-T03：画像核实历史 / 缺失项 / 核心进度 ----------

  function changeValueText(value: unknown): string {
    if (value === null || value === undefined) {
      return "（空）";
    }
    if (typeof value === "boolean") {
      return value ? "是" : "否";
    }
    return String(value);
  }

  const verifyHistory = detail.events
    .filter((event) => event.eventType === "updated")
    .map((event) => {
      const info = asDetail(event.detail);
      if (!info?.changed || Object.keys(info.changed).length === 0) {
        return null;
      }
      return {
        id: event.id,
        occurredAt: toShanghaiDateTimeString(event.occurredAt),
        actorName: event.actorId ? (actorNames.get(event.actorId) ?? null) : null,
        source: info.source
          ? (VERIFICATION_SOURCE_LABELS[info.source] ?? info.source)
          : null,
        fields: Object.entries(info.changed).map(([key, change]) => ({
          label:
            key.startsWith("custom:")
              ? (labelMap.get(key) ?? key.slice("custom:".length))
              : (labelMap.get(key) ?? key),
          from: changeValueText(change.from),
          to: changeValueText(change.to),
          statusText:
            change.statusFrom &&
            change.statusTo &&
            change.statusFrom !== change.statusTo
              ? `${FACT_STATUS_LABELS[change.statusFrom as keyof typeof FACT_STATUS_LABELS] ?? change.statusFrom} → ${FACT_STATUS_LABELS[change.statusTo as keyof typeof FACT_STATUS_LABELS] ?? change.statusTo}`
              : null,
        })),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .reverse(); // 最新在前

  /** 核心缺失项的确定性核实话术模板（V2.4 起 AI 增强） */
  const CORE_VERIFY_SCRIPTS: Record<string, string> = {
    current_system: "请问您现在用的是哪套开单/进销存软件？用得怎么样？",
    next_gen_mobile_order: "咱们现在开单是在手机上操作，还是电脑/纸质为主？",
    qince_interest: "如果有一套能提升开单效率的手机系统，您愿意花几分钟了解一下吗？",
    contract_expiry: "您现在的系统大概什么时候到期？续费价格还满意吗？",
    industry: "咱们主要做哪个行业？",
    main_category: "主营是哪一类商品？",
    sales_team_scale: "咱们业务员团队大概有多少人？",
  };

  const isConfirmedStatus = (status: string) =>
    status === "confirmed" || status === "stated";
  const coreVerifiedCount = PROFILE_CORE_FIELDS.filter((key) =>
    isConfirmedStatus(statusOf(key)),
  ).length;
  const missingCoreFields = PROFILE_CORE_FIELDS.filter(
    (key) => !isConfirmedStatus(statusOf(key)),
  ).map((key) => ({
    defKey: key,
    label: labelMap.get(key) ?? key,
    statusText: FACT_STATUS_LABELS[statusOf(key) as keyof typeof FACT_STATUS_LABELS] ?? statusOf(key),
    script: CORE_VERIFY_SCRIPTS[key] ?? `请核实「${labelMap.get(key) ?? key}」`,
  }));

  // ---------- V2.0-T04：分类信息卡 ----------

  const axisX = {
    value: lead.nextGenMobileOrder,
    status: statusOf("next_gen_mobile_order"),
  } as const;
  const axisY = {
    value: lead.qinceInterest,
    status: statusOf("qince_interest"),
  } as const;
  const evaluation = evaluateQuadrant(
    { value: axisX.value, status: axisX.status as "unknown" | "unverified" | "stated" | "confirmed" },
    { value: axisY.value, status: axisY.status as "unknown" | "unverified" | "stated" | "confirmed" },
  );
  const lastQuadrantEvent = [...detail.events]
    .reverse()
    .find((event) => event.eventType === "quadrant_changed");
  const lastQuadrantInfo = lastQuadrantEvent
    ? (asDetail(lastQuadrantEvent.detail) as {
        from?: string | null;
        to?: string | null;
      } | null)
    : null;
  const valueText = (value: boolean | null): string =>
    value === null ? "未知" : value ? "是" : "否";
  const classification = {
    quadrant: evaluation.quadrant,
    computedAtLabel: lead.quadrantComputedAt
      ? toShanghaiDateTimeString(lead.quadrantComputedAt)
      : null,
    basis: {
      xLabel: "是否使用新一代手机开单系统",
      xValueText: valueText(axisX.value ?? null),
      xStatusText:
        FACT_STATUS_LABELS[axisX.status as keyof typeof FACT_STATUS_LABELS] ??
        axisX.status,
      yLabel: "是否愿意沟通了解勤策",
      yValueText: valueText(axisY.value ?? null),
      yStatusText:
        FACT_STATUS_LABELS[axisY.status as keyof typeof FACT_STATUS_LABELS] ??
        axisY.status,
    },
    advice: evaluation.quadrant ? QUADRANT_ADVICE[evaluation.quadrant] : null,
    missing: evaluation.missing,
    lastChange:
      lastQuadrantEvent && lastQuadrantInfo
        ? {
            fromLabel:
              QUADRANT_LABELS[(lastQuadrantInfo.from ?? "pending") as "pending"],
            toLabel: QUADRANT_LABELS[(lastQuadrantInfo.to ?? "pending") as "pending"],
            dateLabel: toShanghaiDateString(lastQuadrantEvent.occurredAt),
            actorName: lastQuadrantEvent.actorId
              ? (actorNames.get(lastQuadrantEvent.actorId) ?? null)
              : null,
            sourceText: "分类由系统重算",
          }
        : null,
  };

  // ---------- 表单初值（原始字符串，空 = 空输入） ----------

  const formValues: Record<string, string | number | boolean | null> = {};
  for (const field of builtinFields) {
    const raw = (lead as unknown as Record<string, unknown>)[field.key];
    formValues[field.key] =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? raw
        : null;
  }
  for (const fact of FACT_STATUS_FIELDS) {
    // V2.0（T01）：表单状态下拉初值 = 核实行状态（verification-first）
    formValues[fact.statusKey] = statusOf(fact.defKey);
  }
  formValues.priority = lead.priority;
  formValues.nextContactAt = lead.nextContactAt
    ? toDateTimeInputValue(lead.nextContactAt)
    : null;
  for (const field of customFields) {
    const value = customValues[field.key];
    formValues[field.key] =
      typeof value === "string" || typeof value === "number" ? value : null;
  }

  return (
    <LeadDetailClient
      lead={{
        id: lead.id,
        name: lead.name,
        dataVersion: lead.dataVersion,
        stageId: lead.stage.id,
        stageName: lead.stage.name,
        priority: lead.priority,
        nextContactAt: lead.nextContactAt
          ? toShanghaiDateTimeString(lead.nextContactAt)
          : null,
        lastContactAt: lead.lastContactAt
          ? toShanghaiDateTimeString(lead.lastContactAt)
          : null,
        remark: lead.remark,
        createdAt: toShanghaiDateTimeString(lead.createdAt),
        updatedAt: toShanghaiDateTimeString(lead.updatedAt),
      }}
      groups={groups}
      customDisplay={customDisplay}
      timeline={timeline}
      fieldDefs={fieldDefs}
      stages={stages.map((stage) => ({ id: stage.id, name: stage.name }))}
      stageOptions={stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        sortOrder: stage.sortOrder,
        semanticKey: stage.semanticKey,
      }))}
      currentStageSortOrder={lead.stage.sortOrder}
      interactions={interactionRows}
      tasks={taskViews}
      formValues={formValues}
      dictOptions={Object.fromEntries(dictMap)}
      coreVerifiedCount={coreVerifiedCount}
      verifyHistory={verifyHistory}
      missingCoreFields={missingCoreFields}
      classification={classification}
      aiRuns={aiRuns}
      aiUsage={aiUsage}
      activePromptVersions={activePromptVersions}
      experimentGroup={experimentGroup}
    />
  );
}
