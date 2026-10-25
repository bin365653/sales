// T01–T07 最小闭环端到端冒烟（HTTP 层，黑盒）：
// 健康检查 → 认证 → 建线索/阶段流转/乐观锁 → 线索池/批量 → 导入/导出 →
// 沟通（K4 推进）→ 任务（完成弹窗事务/今日逾期视图）→ 个人全量导出 → 登出。
// 运行前置：应用已启动（默认 http://localhost:3000）且数据库已迁移 + seed。
// 结束时清理本次冒烟数据（含启动时清理上次异常中断的残留）。
/* eslint-disable @typescript-eslint/no-require-imports -- Node 端 .cjs 黑盒冒烟脚本，CommonJS 有意为之 */
"use strict";

require("dotenv").config();

const BASE = process.env.SMOKE_BASE || "http://localhost:3000";
const USERNAME = process.env.SMOKE_USERNAME || "admin";
const PASSWORD = process.env.SMOKE_PASSWORD || "admin-local-2026";

let cookie = "";
let passed = 0;
const cleanup = { leadIds: [], exportIds: [], prisma: null, userId: null };

function ok(label) {
  passed += 1;
  console.log("  ok -", label);
}

function section(title) {
  console.log("\n[" + title + "]");
}

function assert(cond, label) {
  if (!cond) {
    throw new Error("冒烟失败：" + label);
  }
  ok(label);
}

async function api(method, path, body, extra = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: {
      Origin: BASE,
      ...(body !== undefined && !(body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra.headers,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    if (line.startsWith("qince_session=")) {
      cookie = line.split(";")[0];
    }
    if (line.startsWith("qince_session=;")) {
      cookie = "";
    }
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json, location: res.headers.get("location") };
}

/** 上海时区的 "YYYY-MM-DD HH:mm" 与 "YYYY-MM-DD"（相对今天偏移 offsetDays 天） */
function shanghaiNow(offsetDays = 0, withTime = true) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const base = `${parts.year}-${parts.month}-${parts.day}`;
  if (!offsetDays) {
    return withTime ? `${base} ${parts.hour}:${parts.minute}` : base;
  }
  const shifted = new Date(`${base}T12:00:00+08:00`);
  shifted.setUTCDate(shifted.getUTCDate() + offsetDays);
  const d = shifted.toISOString().slice(0, 10);
  return withTime ? `${d} 09:00` : d;
}

function buildImportCsv() {
  // 3 行：1 有效 / 1 错误（电话非法）/ 1 精确重复（与既有客户同手机号）
  const lines = [
    "客户名称,城市,联系方式",
    "闭环导入客户A,合肥,13912340001",
    "闭环导入客户B,合肥,电话见面谈",
    "闭环既有客户,合肥,13900000099",
  ];
  return Buffer.from("\uFEFF" + lines.join("\r\n"), "utf8");
}

async function cleanupSmokeData() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  cleanup.prisma = prisma;
  try {
    const leftovers = await prisma.lead.findMany({
      where: { name: { startsWith: "闭环" } },
      select: { id: true },
    });
    const ids = [...new Set([...leftovers.map((l) => l.id), ...cleanup.leadIds])];
    if (ids.length > 0) {
      await prisma.task.deleteMany({ where: { leadId: { in: ids } } });
      await prisma.interaction.deleteMany({ where: { leadId: { in: ids } } });
      await prisma.leadEvent.deleteMany({ where: { leadId: { in: ids } } });
      await prisma.lead.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.importBatch.deleteMany({ where: { filename: "smoke-import.csv" } });
    if (cleanup.exportIds.length > 0) {
      await prisma.exportFile.deleteMany({ where: { id: { in: cleanup.exportIds } } });
    }
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  await cleanupSmokeData();

  // ---------- T01 工程基座 ----------
  section("T01 健康检查");
  const health = await api("GET", "/api/health");
  assert(health.status === 200 && health.json.checks?.db === "up", "GET /api/health 200 且数据库连接正常");

  // ---------- T02 认证与数据范围 ----------
  section("T02 认证");
  const anon = await fetch(BASE + "/leads", { redirect: "manual" });
  assert(
    anon.status >= 300 && anon.status < 400 && (anon.headers.get("location") || "").includes("/login"),
    "未登录访问 /leads 重定向到 /login",
  );

  const bad = await api("POST", "/api/auth/login", { username: USERNAME, password: "wrong-password" });
  assert(bad.status === 401, "错误密码登录被拒绝（401）");

  const login = await api("POST", "/api/auth/login", { username: USERNAME, password: PASSWORD });
  assert(login.status === 200 && !!login.json.user?.id, "管理员登录成功并下发会话 Cookie");
  cleanup.userId = login.json.user.id;

  const session = await api("GET", "/api/auth/session");
  assert(session.status === 200, "会话有效（GET /api/auth/session 200）");

  // ---------- T03 线索模型与配置 ----------
  section("T03 线索与阶段配置");
  const stages = await api("GET", "/api/settings/stages");
  assert(
    stages.status === 200 && stages.json.stages?.length >= 13,
    `阶段配置可读（当前 ${stages.json.stages?.length ?? 0} 个）`,
  );
  const stageBysemantic = Object.fromEntries(stages.json.stages.map((s) => [s.semanticKey, s.id]));
  const qualifiedStageId = stageBysemantic.qualified;
  const toContactStageId = stageBysemantic.to_contact;
  assert(!!qualifiedStageId && !!toContactStageId, "语义锚点阶段（to_contact / qualified）存在");

  const invalid = await api("POST", "/api/leads", { name: "", city: "合肥" });
  assert(invalid.status === 400, "空客户名称新建被拒（400 校验错误）");

  const lead = await api("POST", "/api/leads", {
    name: "闭环冒烟客户-合肥机械",
    city: "合肥",
    industry: "装备制造",
    contactName: "王经理",
    contactPhone: "13800001111",
    priority: "mid",
  });
  assert(lead.status === 201 && lead.json.lead?.id, "新建线索成功");
  const leadId = lead.json.lead.id;
  cleanup.leadIds.push(leadId);
  assert(lead.json.lead.dataVersion === 1, "初始 dataVersion = 1");

  const dupName = await api("GET", `/api/leads?keyword=${encodeURIComponent("冒烟客户-合肥机械")}`);
  assert(dupName.status === 200 && dupName.json.items?.length === 1, "关键词搜索命中新建线索");

  await api("PATCH", `/api/leads/${leadId}/stage`, { stageId: toContactStageId, dataVersion: 1 });
  const afterMove = await api("GET", `/api/leads/${leadId}`);
  assert(
    afterMove.json.lead?.stageId === toContactStageId && afterMove.json.lead?.dataVersion === 2,
    "阶段流转成功并写入事件（dataVersion 升至 2）",
  );

  const conflict = await api("PATCH", `/api/leads/${leadId}/stage`, {
    stageId: qualifiedStageId,
    dataVersion: 1,
  });
  assert(conflict.status === 409 && conflict.json.error?.code === "version_conflict", "旧版本提交被 409 version_conflict 拒绝");

  // ---------- T04 线索池与详情 ----------
  section("T04 线索池 / 详情 / 批量");
  const pool = await api("GET", `/api/leads?city=${encodeURIComponent("合肥")}&priority=mid&pageSize=5`);
  assert(
    pool.status === 200 && pool.json.items?.some((l) => l.id === leadId) && pool.json.total >= 1,
    "组合筛选（城市+优先级）命中且分页返回结构正确",
  );

  const pages = await fetch(`${BASE}/leads`, { headers: { Cookie: cookie } });
  assert(pages.status === 200, "线索池页面 /leads 渲染 200");
  const detailPage = await fetch(`${BASE}/leads/${leadId}`, { headers: { Cookie: cookie } });
  assert(detailPage.status === 200, "客户详情页 /leads/:id 渲染 200");

  const batch = await api("PATCH", "/api/leads/batch", {
    ids: [leadId],
    changes: { priority: "high" },
  });
  assert(batch.status === 200 || batch.status === 201, "批量修改优先级成功");
  const afterBatch = await api("GET", `/api/leads/${leadId}`);
  assert(afterBatch.json.lead?.priority === "high", "批量修改已生效（priority = high）");

  const batchReject = await api("PATCH", "/api/leads/batch", {
    ids: [leadId],
    changes: { name: "不允许批量改名" },
  });
  assert(batchReject.status === 400, "白名单外字段批量修改被拒（400）");

  // ---------- T05 导入与导出 ----------
  section("T05 导入与导出");
  const tpl = await fetch(`${BASE}/api/imports/template?format=csv`, { headers: { Cookie: cookie } });
  assert(tpl.status === 200, "导入模板下载 200");

  const existing = await api("POST", "/api/leads", {
    name: "闭环既有客户",
    city: "合肥",
    contactPhone: "13900000099",
  });
  assert(existing.status === 201, "预置库内既有客户（用于重复检测）");
  cleanup.leadIds.push(existing.json.lead.id);

  const form = new FormData();
  form.append(
    "file",
    new Blob([buildImportCsv()], { type: "text/csv" }),
    "smoke-import.csv",
  );
  const upload = await api("POST", "/api/imports", form);
  assert(upload.status === 201 && !!upload.json.batchId, "上传 CSV 解析成功（批次创建，两阶段不落正式表）");

  const dupRows = await api("GET", `/api/imports/${upload.json.batchId}/rows?tab=dup`);
  assert(dupRows.status === 200 && (dupRows.json.rows?.length ?? 0) >= 1, "重复检测：手机号精确重复被识别");

  const errorRows = await api("GET", `/api/imports/${upload.json.batchId}/rows?tab=error`);
  assert(errorRows.status === 200 && (errorRows.json.rows?.length ?? 0) >= 1, "行级校验：非法电话行进入错误分栏");

  const confirm = await api("POST", `/api/imports/${upload.json.batchId}/confirm`, {});
  assert(
    confirm.status === 200 && confirm.json.created === 1,
    `确认导入：有效行入库（created=${confirm.json?.created}，skipped=${confirm.json?.skipped}）`,
  );
  const imported = await api("GET", `/api/leads?keyword=${encodeURIComponent("闭环导入客户A")}`);
  assert(imported.json.items?.length === 1, "导入客户出现在线索池");

  const repeatConfirm = await api("POST", `/api/imports/${upload.json.batchId}/confirm`, {});
  assert(repeatConfirm.status === 409, "批次终态不可重复确认（409）");

  const exportLeads = await api("POST", "/api/exports/leads", {
    format: "xlsx",
    filters: { keyword: "闭环" },
  });
  assert(exportLeads.status === 201 && !!exportLeads.json.downloadPath, "按筛选创建客户列表导出（XLSX）");
  cleanup.exportIds.push(exportLeads.json.id);
  const dl = await fetch(`${BASE}${exportLeads.json.downloadPath}`, { headers: { Cookie: cookie } });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && dlBuf.subarray(0, 2).toString() === "PK", "导出文件可下载且为合法 XLSX（ZIP 容器）");

  // ---------- T06 沟通记录（K4 推进） ----------
  section("T06 沟通记录");
  const interaction = await api("POST", `/api/leads/${leadId}/interactions`, {
    occurredAt: shanghaiNow(),
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: true,
    feedback: "闭环冒烟：客户有意向，约下周演示",
    nextContactAt: shanghaiNow(3),
    isQualified: true,
  });
  assert(interaction.status === 201 && !!interaction.json.interaction?.id, "保存沟通记录成功");
  assert(
    interaction.json.stageAdvanced?.toStageId === qualifiedStageId,
    "K4：勾选合格后自动推进到 qualified 锚点阶段",
  );

  const afterInteraction = await api("GET", `/api/leads/${leadId}`);
  assert(!!afterInteraction.json.lead?.lastContactAt, "last_contact_at 已随沟通更新");
  assert(
    afterInteraction.json.lead?.stageId === qualifiedStageId,
    "线索当前阶段 = qualified",
  );

  const list = await api("GET", `/api/leads/${leadId}/interactions`);
  assert(list.status === 200 && list.json.items?.length >= 1, "沟通时间线列表包含新记录");

  const patch = await api("PATCH", `/api/interactions/${interaction.json.interaction.id}`, {
    occurredAt: shanghaiNow(),
    channel: "phone",
    direction: "outbound",
    connected: true,
    effective: true,
    feedback: "闭环冒烟：客户有意向，约下周演示（已修正）",
    nextContactAt: shanghaiNow(3),
    isQualified: true,
  });
  const patched = patch.json.interaction ?? patch.json;
  const auditLen = patched.editAudit?.length ?? patched.editAuditCount ?? 0;
  assert(patch.status === 200 && auditLen >= 1, "修正留痕：edit_audit 追加变更记录");

  // ---------- T07 任务管理 ----------
  section("T07 任务管理");
  const overdue = await api("POST", "/api/tasks", {
    leadId,
    type: "follow_up",
    title: "闭环冒烟-逾期任务",
    dueAt: shanghaiNow(-1),
  });
  assert(overdue.status === 201 && overdue.json.task?.status === "pending", "新建逾期任务（昨天截止）");
  const today = await api("POST", "/api/tasks", {
    leadId,
    type: "needs_diag",
    title: "闭环冒烟-今日任务",
    dueAt: shanghaiNow(0),
  });
  assert(today.status === 201, "新建今日任务");

  const overdueView = await api("GET", "/api/tasks?view=overdue");
  assert(
    overdueView.json.items?.some((t) => t.title === "闭环冒烟-逾期任务"),
    "逾期视图包含昨天截止任务",
  );
  const todayView = await api("GET", "/api/tasks?view=today");
  assert(
    todayView.json.items?.some((t) => t.title === "闭环冒烟-逾期任务") &&
      todayView.json.counts?.overdue >= 1 &&
      todayView.json.counts?.today >= 1,
    "今日视图含逾期置顶，今日/逾期计数分开统计",
  );

  const complete = await api("POST", `/api/tasks/${overdue.json.task.id}/complete-with-interaction`, {
    interaction: {
      occurredAt: shanghaiNow(),
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
      feedback: "闭环冒烟：完成任务时留下的沟通记录",
    },
    nextTask: {
      type: "online_demo",
      title: "闭环冒烟-下一任务",
      dueAt: shanghaiNow(5),
    },
  });
  assert(complete.status === 201 && complete.json.task?.status === "done", "完成任务弹窗：任务标记 done");
  assert(!!complete.json.task?.completedAt, "completed_at 已保留（验收项，不回写清空）");
  assert(!!complete.json.task?.interactionId, "完成时沟通记录已生成并回填 interaction_id");
  assert(complete.json.nextTask?.title === "闭环冒烟-下一任务", "下一步任务已创建（同一事务）");

  const again = await api("POST", `/api/tasks/${overdue.json.task.id}/complete-with-interaction`, {
    interaction: {
      occurredAt: shanghaiNow(),
      channel: "phone",
      direction: "outbound",
      connected: true,
      effective: true,
    },
  });
  assert(again.status === 400 && again.json.error?.code === "task_not_editable", "已完成任务不可再编辑（400）");

  const cancel = await api("PATCH", `/api/tasks/${today.json.task.id}`, { status: "canceled" });
  assert(cancel.status === 200 && cancel.json.task?.status === "canceled", "取消任务");

  const tasksPage = await fetch(`${BASE}/tasks`, { headers: { Cookie: cookie } });
  assert(tasksPage.status === 200, "任务中心页面 /tasks 渲染 200");

  // ---------- 个人全量导出（M9） ----------
  section("个人全量导出");
  const me = await api("POST", "/api/exports/me", {});
  assert(me.status === 201 && !!me.json.downloadPath, "创建个人全量导出（ZIP）");
  cleanup.exportIds.push(me.json.id);
  const meDl = await fetch(`${BASE}${me.json.downloadPath}`, { headers: { Cookie: cookie } });
  const meBuf = Buffer.from(await meDl.arrayBuffer());
  assert(meDl.status === 200 && meBuf.subarray(0, 2).toString() === "PK", "个人全量 ZIP 可下载");

  // ---------- T02 登出 ----------
  section("登出与会话失效");
  const logout = await api("POST", "/api/auth/logout");
  assert(logout.status === 200 || logout.status === 204, "登出成功");
  const afterLogout = await api("GET", "/api/auth/session");
  assert(afterLogout.status === 401 || afterLogout.status === 403, "登出后会话立即失效");

  console.log(`\nSMOKE PASS：最小闭环 ${passed} 项断言全部通过（${BASE}）`);
})()
  .catch((error) => {
    console.error("\n" + (error?.message || error));
    console.error("SMOKE FAIL");
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await cleanupSmokeData();
      console.log("冒烟数据已清理（线索/任务/沟通/事件/导入批次/导出文件）");
    } catch (error) {
      console.error("清理失败（可忽略，不影响判定）：", error?.message || error);
    }
  });
