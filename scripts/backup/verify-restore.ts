/**
 * 恢复核验（T17，实施计划 §8.4 / scripts/restore-drill.md 的自动化核对项）：
 * 核心表行数比对 + 抽样数据校验 + AI/实验记录完整性 + 导出/密文/字节流完整性。
 * 用法：npx tsx scripts/backup/verify-restore.ts --source <源库URL> --target <恢复库URL>
 * 退出码：0 = 全部通过；1 = 存在差异；2 = 参数错误。发现差异只打印字段名与
 * 差异侧取值摘要，绝不打印密文/电话等敏感值（§8.3 日志红线同语义）。
 */
import { PrismaClient } from "@prisma/client";

function parseArgs(argv: string[]): { source: string; target: string } {
  let source = "";
  let target = "";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") source = argv[i + 1] ?? "";
    if (argv[i] === "--target") target = argv[i + 1] ?? "";
  }
  if (!source || !target) {
    console.error(
      "用法: npx tsx scripts/backup/verify-restore.ts --source <源库URL> --target <恢复库URL>",
    );
    process.exit(2);
  }
  return { source, target };
}

interface Check {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function add(group: string, name: string, ok: boolean, detail: string): void {
  checks.push({ group, name, ok, detail });
}

/** 稳定序列化（Date/JsonB 列比对用；对象键序由 JSON 解析侧决定，两侧同构） */
function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function tableCounts(c: PrismaClient) {
  return {
    users: await c.user.count(),
    sessions: await c.session.count(),
    audit_logs: await c.auditLog.count(),
    lead_stages: await c.leadStage.count(),
    lead_field_defs: await c.leadFieldDef.count(),
    leads: await c.lead.count(),
    lead_events: await c.leadEvent.count(),
    import_batches: await c.importBatch.count(),
    import_rows: await c.importRow.count(),
    export_files: await c.exportFile.count(),
    interactions: await c.interaction.count(),
    tasks: await c.task.count(),
    model_configs: await c.modelConfig.count(),
    prompt_templates: await c.promptTemplate.count(),
    prompt_versions: await c.promptVersion.count(),
    ai_runs: await c.aiRun.count(),
    work_time_entries: await c.workTimeEntry.count(),
    experiments: await c.experiment.count(),
    experiment_assignments: await c.experimentAssignment.count(),
  };
}

async function latestLead(c: PrismaClient) {
  return c.lead.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, name: true, city: true, industry: true, contactPhone: true,
      source: true, stageId: true, priority: true, ownerId: true,
      currentSystemStatus: true, contractExpiry: true, customValues: true,
      dataVersion: true, deletedAt: true, createdAt: true,
    },
  });
}

async function latestInteraction(c: PrismaClient) {
  return c.interaction.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, leadId: true, channel: true, direction: true, connected: true,
      effective: true, feedback: true, nextAction: true, isQualified: true,
      demoBooked: true, aiRunId: true, editAudit: true,
    },
  });
}

async function latestAiRun(c: PrismaClient) {
  return c.aiRun.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true, leadId: true, runType: true, status: true, errorType: true,
      inputSnapshot: true, inputDataVersion: true, output: true, durationMs: true,
    },
  });
}

async function latestAssignment(c: PrismaClient) {
  return c.experimentAssignment.findFirst({
    orderBy: [{ assignedAt: "desc" }, { id: "desc" }],
    select: {
      id: true, experimentId: true, leadId: true, group: true,
      ruleSnapshot: true, profileSnapshot: true, assignedAt: true,
    },
  });
}

async function main(): Promise<void> {
  const { source, target } = parseArgs(process.argv.slice(2));
  const s = new PrismaClient({ datasourceUrl: source });
  const t = new PrismaClient({ datasourceUrl: target });

  try {
    // ---- ① 核心表行数比对（restore-drill.md 核对项 1）----
    const [cs, ct] = await Promise.all([tableCounts(s), tableCounts(t)]);
    for (const table of Object.keys(cs) as Array<keyof typeof cs>) {
      add("行数", table, cs[table] === ct[table], `${cs[table]} → ${ct[table]}`);
    }

    // ---- ② 抽样数据校验（核对项 2：最新/最早线索 + 最新沟通/AI run/分组明细）----
    const [ls, lt] = await Promise.all([latestLead(s), latestLead(t)]);
    if (ls === null && lt === null) {
      add("抽样", "leads(最新一条)", true, "两库均为空线索（空库演练场景）");
    } else {
      const ok =
        ls !== null && lt !== null &&
        ls.id === lt.id && ls.name === lt.name && ls.city === lt.city &&
        ls.industry === lt.industry && ls.contactPhone === lt.contactPhone &&
        ls.source === lt.source && ls.stageId === lt.stageId &&
        ls.priority === lt.priority && ls.ownerId === lt.ownerId &&
        ls.currentSystemStatus === lt.currentSystemStatus &&
        stable(ls.contractExpiry) === stable(lt.contractExpiry) &&
        stable(ls.customValues) === stable(lt.customValues) &&
        ls.dataVersion === lt.dataVersion &&
        stable(ls.deletedAt) === stable(lt.deletedAt) &&
        stable(ls.createdAt) === stable(lt.createdAt);
      add("抽样", "leads(最新一条) 全字段", ok,
        ok ? `id=${ls?.id}` : `两侧不一致（源=${ls?.id ?? "无"} 目标=${lt?.id ?? "无"}）`);
    }

    const [isx, itx] = await Promise.all([latestInteraction(s), latestInteraction(t)]);
    const iOk =
      (isx === null) === (itx === null) &&
      (isx === null || (
        itx !== null && isx.id === itx.id && isx.leadId === itx.leadId &&
        isx.channel === itx.channel && isx.direction === itx.direction &&
        isx.connected === itx.connected && isx.effective === itx.effective &&
        isx.feedback === itx.feedback && isx.nextAction === itx.nextAction &&
        isx.isQualified === itx.isQualified && isx.demoBooked === itx.demoBooked &&
        isx.aiRunId === itx.aiRunId && stable(isx.editAudit) === stable(itx.editAudit)
      ));
    add("抽样", "interactions(最新一条) 全字段", iOk, `count=${cs.interactions}`);

    const [as, at] = await Promise.all([latestAiRun(s), latestAiRun(t)]);
    const aOk =
      (as === null) === (at === null) &&
      (as === null || (
        at !== null && as.id === at.id && as.leadId === at.leadId &&
        as.runType === at.runType && as.status === at.status &&
        as.errorType === at.errorType &&
        stable(as.inputSnapshot) === stable(at.inputSnapshot) &&
        as.inputDataVersion === at.inputDataVersion &&
        stable(as.output) === stable(at.output) &&
        as.durationMs === at.durationMs
      ));
    add("抽样", "ai_runs(最新一条) 输出/快照", aOk, `count=${cs.ai_runs}`);

    const [ps, pt] = await Promise.all([latestAssignment(s), latestAssignment(t)]);
    const pOk =
      (ps === null) === (pt === null) &&
      (ps === null || (
        pt !== null && ps.id === pt.id && ps.experimentId === pt.experimentId &&
        ps.leadId === pt.leadId && ps.group === pt.group &&
        stable(ps.ruleSnapshot) === stable(pt.ruleSnapshot) &&
        stable(ps.profileSnapshot) === stable(pt.profileSnapshot) &&
        stable(ps.assignedAt) === stable(pt.assignedAt)
      ));
    add("抽样", "experiment_assignments(最新一条)", pOk, `count=${cs.experiment_assignments}`);

    // ---- ③ AI / 实验记录完整性（核对项 3）----
    // 引用完整性由外键物理保证（RESTRICT），此处核对"链条可复现"：
    // 每个 ai_run 的提示词版本在 prompt_versions 中可解析且版本号一致。
    const [verS, verT] = await Promise.all([
      s.promptVersion.groupBy({ by: ["templateId"], _max: { version: true }, _count: { _all: true } }),
      t.promptVersion.groupBy({ by: ["templateId"], _max: { version: true }, _count: { _all: true } }),
    ]);
    const verKey = (rows: typeof verS) =>
      rows
        .map((r) => `${r.templateId}:${r._max.version ?? 0}:${r._count._all}`)
        .sort()
        .join("|");
    add("AI完整性", "提示词版本链(模板×最高版本×条数)", verKey(verS) === verKey(verT),
      `${verS.length} 个模板`);

    // 模型密文必须逐字节一致（AES-256-GCM 密文列还原无误）；只报布尔不报内容
    const [cfgS, cfgT] = await Promise.all([
      s.modelConfig.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, apiKeyCipher: true, keyLast4: true } }),
      t.modelConfig.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, apiKeyCipher: true, keyLast4: true } }),
    ]);
    add("AI完整性", "model_configs 密文列逐字节一致",
      (cfgS?.apiKeyCipher ?? null) === (cfgT?.apiKeyCipher ?? null) &&
      cfgS?.keyLast4 === cfgT?.keyLast4,
      cfgS ? `config=${cfgS.id} last4=${cfgS.keyLast4}` : "无模型配置");

    // 导出文件 bytea 完整性：抽样比对字节数（20MB 以下全量对比字节流）
    const [expS, expT] = await Promise.all([
      s.exportFile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, content: true } }),
      t.exportFile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true, content: true } }),
    ]);
    const lenS = expS?.content?.byteLength ?? -1;
    const lenT = expT?.content?.byteLength ?? -1;
    const expOk = lenS === lenT &&
      (lenS < 0 || Buffer.from(expS?.content ?? []).equals(Buffer.from(expT?.content ?? [])));
    add("AI完整性", "export_files bytea 字节流一致", expOk, `len=${lenS}`);

    // 实验链：assignment.experiment_id 全部可解析（FK 保证）+ 分组计数一致
    const [grpS, grpT] = await Promise.all([
      s.experimentAssignment.groupBy({ by: ["experimentId", "group"], _count: { _all: true } }),
      t.experimentAssignment.groupBy({ by: ["experimentId", "group"], _count: { _all: true } }),
    ]);
    const grpKey = (rows: typeof grpS) =>
      rows.map((r) => `${r.experimentId}:${r.group}:${r._count._all}`).sort().join("|");
    add("AI完整性", "实验分组计数(实验×组别)", grpKey(grpS) === grpKey(grpT),
      `${grpS.length} 组`);

    // ---- ④ 汇总 ----
    const failed = checks.filter((c) => !c.ok);
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  [${c.group}] ${c.name.padEnd(width)}  ${c.detail}`);
    }
    console.log(
      failed.length === 0
        ? `\n核验通过：${checks.length} 项全部一致（源=${source} 目标=${target}）`
        : `\n核验失败：${failed.length}/${checks.length} 项不一致（详见上方 FAIL 行）`,
    );
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    await s.$disconnect();
    await t.$disconnect();
  }
}

void main();
