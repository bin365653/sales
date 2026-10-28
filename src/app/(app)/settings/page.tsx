import { notFound, redirect } from "next/navigation";
import { AuthUser } from "@/lib/auth";
import { getCurrentUser } from "@/server/auth/current-user";
import { listModelConfigs } from "@/server/ai/model-configs";
import { getWorktimeWeek } from "@/server/services/worktime";
import { listStages } from "@/server/services/stages";
import { listFieldDefs } from "@/server/services/lead-fields";
import {
  getUserNames,
  listUsers,
} from "@/server/services/users";
import { listPromptTemplates } from "@/server/services/prompts";
import { listAuditLogs } from "@/server/services/audit-logs";
import { auditLogQuerySchema } from "@/lib/schemas/settings";
import { workDateStringSchema } from "@/lib/schemas/worktime";
import { toShanghaiDateString, toShanghaiDateTimeString } from "@/lib/format";
import {
  SettingsTabs,
  isAdminTab,
  isPersonalTab,
} from "@/components/settings/settings-tabs";
import { PasswordChangeForm } from "@/components/settings/password-change-form";
import { PersonalExportCard } from "@/components/settings/personal-export-card";
import { WorktimeWeekForm } from "@/components/settings/worktime-week-form";
import { ModelConfigsManager } from "@/components/settings/model-configs-manager";
import { PromptVersionsManager } from "@/components/settings/prompt-versions-manager";
import { StagesManager } from "@/components/settings/stages-manager";
import { FieldsManager } from "@/components/settings/fields-manager";
import { UsersManager } from "@/components/settings/users-manager";
import { AuditLogsView } from "@/components/settings/audit-logs-view";

export const dynamic = "force-dynamic";

// P9 设置中心（T15，UIUX P9）：两大分段页签——个人设置 / 管理员设置，
// 页签经 URL ?tab= 切换（禁 JS 可用）。管理员分段对销售整体隐藏，
// 直达 URL 越权访问按项目惯例 404。各页签数据在服务端取自服务层
// （与 API 同一实现，口径必然一致）。

interface SearchParams {
  [key: string]: string | string[] | undefined;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  const isAdmin = user.role === "admin";

  const raw = await searchParams;
  const tabParam = firstParam(raw.tab) ?? "account";
  // 销售访问管理员页签 → 404（越权不暴露资源存在性，§8.2）
  if (isAdminTab(tabParam) && !isAdmin) {
    notFound();
  }
  const tab =
    isPersonalTab(tabParam) || isAdminTab(tabParam) ? tabParam : "account";

  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">设置中心</h1>
        <p className="mt-1 text-sm text-gray-500">
          个人配置与数据管理；管理类配置集中在下方独立分段，仅管理员可见（移动端仅保障改密码/填工时/导出数据）。
        </p>
      </header>
      <SettingsTabs current={tab} isAdmin={isAdmin} />
      <TabContent tab={tab} params={raw} user={user} />
    </section>
  );
}

async function TabContent({
  tab,
  params,
  user,
}: {
  tab: string;
  params: SearchParams;
  user: AuthUser;
}) {
  switch (tab) {
    case "worktime":
      return <WorktimeTab user={user} params={params} />;
    case "export":
      return <PersonalExportCard />;
    case "ai":
      return <AiServiceTab user={user} />;
    case "prompts":
      return <PromptsTab />;
    case "stages":
      return <StagesTab />;
    case "fields":
      return <FieldsTab />;
    case "users":
      return <UsersTab user={user} />;
    case "audit":
      return <AuditTab user={user} params={params} />;
    default:
      return <PasswordChangeForm />;
  }
}

// ---------- 个人设置 ----------

async function WorktimeTab({
  user,
  params,
}: {
  user: AuthUser;
  params: SearchParams;
}) {
  const weekParam = firstParam(params.week);
  const parsedWeek = weekParam ? workDateStringSchema.safeParse(weekParam) : null;
  // 非法/缺省 week 参数一律回落到本周（上海日历日，C13），不报错
  const anchor = parsedWeek?.success
    ? parsedWeek.data
    : toShanghaiDateString(new Date());
  const week = await getWorktimeWeek(user, anchor);
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <p className="text-sm text-gray-500">
        每人每日一条，重复保存会覆盖当天数值、不会报错；未填报的日期，
        看板「每小时有效沟通」将显示 — 而非 0（C03）。
      </p>
      <WorktimeWeekForm weekStart={week.weekStart} initialDays={week.days} today={toShanghaiDateString(new Date())} />
    </div>
  );
}

// ---------- 管理员设置 ----------

async function AiServiceTab({ user }: { user: AuthUser }) {
  const configs = await listModelConfigs(user);
  const items = configs.map((config) => ({
    id: config.id,
    provider: config.provider,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    keyLast4: config.keyLast4,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    isActive: config.isActive,
  }));
  return <ModelConfigsManager configs={items} />;
}

async function PromptsTab() {
  const templates = await listPromptTemplates();
  const creatorIds = Array.from(
    new Set(templates.flatMap((template) => template.versions.map((v) => v.createdBy))),
  );
  const names = await getUserNames(creatorIds);
  const display = templates.map((template) => ({
    id: template.id,
    name: template.name,
    runType: template.runType,
    versions: template.versions.map((version) => ({
      id: version.id,
      version: version.version,
      content: version.content,
      outputSchema: version.outputSchema,
      creatorName: names.get(version.createdBy) ?? null,
      createdAtLabel: toShanghaiDateTimeString(version.createdAt),
    })),
  }));
  return <PromptVersionsManager templates={display} />;
}

async function StagesTab() {
  const stages = await listStages({ activeOnly: false });
  const items = stages.map((stage) => ({
    id: stage.id,
    code: stage.code,
    name: stage.name,
    sortOrder: stage.sortOrder,
    isActive: stage.isActive,
    semanticKey: stage.semanticKey,
  }));
  return <StagesManager stages={items} />;
}

async function FieldsTab() {
  const fields = await listFieldDefs({ activeOnly: false });
  const items = fields.map((field) => ({
    id: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options,
    validation: field.validation,
    isBuiltin: field.isBuiltin,
    isActive: field.isActive,
  }));
  return <FieldsManager fields={items} />;
}

async function UsersTab({ user }: { user: AuthUser }) {
  const users = await listUsers(user);
  const items = users.map((item) => ({
    id: item.id,
    username: item.username,
    name: item.name,
    role: item.role,
    status: item.status,
    createdAtLabel: toShanghaiDateString(item.createdAt),
  }));
  return <UsersManager users={items} currentUserId={user.id} />;
}

async function AuditTab({ user, params }: { user: AuthUser; params: SearchParams }) {
  const parsed = auditLogQuerySchema.safeParse({
    ...(firstParam(params.action) ? { action: firstParam(params.action) } : {}),
    ...(firstParam(params.userId) ? { userId: firstParam(params.userId) } : {}),
    ...(firstParam(params.from) ? { from: firstParam(params.from) } : {}),
    ...(firstParam(params.to) ? { to: firstParam(params.to) } : {}),
    ...(firstParam(params.page) ? { page: firstParam(params.page) } : {}),
  });
  // 非法筛选参数回落到第一页全量，不报错（与线索池筛选同策略）
  const query = parsed.success ? parsed.data : {};
  const [result, allUsers] = await Promise.all([
    listAuditLogs(user, query),
    listUsers(user),
  ]);
  const rows = result.logs.map((log) => ({
    id: log.id,
    createdAtLabel: toShanghaiDateTimeString(log.createdAt),
    action: log.action,
    objectType: log.objectType,
    objectId: log.objectId,
    detail: log.detail,
    ip: log.ip,
    userName: log.userName,
  }));
  return (
    <AuditLogsView
      rows={rows}
      users={allUsers.map((item) => ({ id: item.id, name: item.name }))}
      filters={{
        action: query.action,
        userId: query.userId,
        from: query.from,
        to: query.to,
      }}
      page={result.page}
      total={result.total}
    />
  );
}
