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
import { toAiRunView, type AiRunView } from "@/lib/ai-run-view";
import type { RunTypeValue } from "@/lib/schemas/ai";
import {
  toDateTimeInputValue,
  toShanghaiDateTimeString,
  toUtcDateString,
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
} | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  return raw as { fields?: unknown[]; batch?: boolean; reason?: string };
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
  };
  try {
    detail = (await getLeadDetail(user, id)) as typeof detail;
  } catch {
    notFound();
  }

  const [defs, stages, actorNames, interactions, tasks] = await Promise.all([
    listFieldDefs({ activeOnly: false }),
    listStages({ activeOnly: true }),
    getUserNames(
      detail.events
        .map((event) => event.actorId)
        .filter((actorId): actorId is string => actorId !== null),
    ),
    listInteractions(user, id),
    listLeadTasks(user, id),
  ]);

  // AI 面板初始数据（T09）：首屏整形与客户端轮询共用 toAiRunView；
  // 提示词版本仅展示用，缺失时降级（发起 run 时服务层仍会 fail fast）。
  const aiRuns: AiRunView[] = (await listLeadAiRuns(user, id).catch(() => [])).map(
    (run) => toAiRunView(run),
  );
  const aiUsage = await getTodayUsage(user.id).catch(() => ({ used: 0, limit: 0 }));
  const activePromptVersions: Partial<Record<RunTypeValue, number | null>> = {};
  for (const runType of ["analysis", "call_prep"] as RunTypeValue[]) {
    try {
      activePromptVersions[runType] = (await resolveActivePromptVersion(runType)).version;
    } catch {
      activePromptVersions[runType] = null;
    }
  }

  const now = new Date();
  const taskViews = tasks.map((task) =>
    toTaskView(
      {
        ...task,
        lead: {
          id: detail.lead.id,
          name: detail.lead.name,
          stageName: detail.lead.stage.name,
          stageSortOrder: detail.lead.stage.sortOrder,
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
  }
  const groups = FORM_GROUP_ORDER.map((group) => {
    const fields: DisplayField[] = builtinFields
      .filter((field) => field.group === group)
      .map((field) => {
        const fact = FACT_STATUS_FIELDS.find(
          (item) => item.valueKey === field.key,
        );
        return {
          label: field.label,
          text:
            field.key === "contractExpiry" && lead.contractExpiry
              ? toUtcDateString(lead.contractExpiry)
              : displayOf(field.key),
          ...(fact
            ? {
                factStatus: (
                  (lead as unknown as Record<string, string>)[fact.statusKey] ??
                  "unknown"
                ),
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
          title = detailInfo?.batch ? "批量修改资料" : "修改资料";
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
    formValues[fact.statusKey] =
      (lead as unknown as Record<string, string>)[fact.statusKey] ?? "unknown";
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
      aiRuns={aiRuns}
      aiUsage={aiUsage}
      activePromptVersions={activePromptVersions}
    />
  );
}
