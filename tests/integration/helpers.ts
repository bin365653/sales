import { randomBytes } from "node:crypto";
import { AuthUser } from "@/lib/auth";
import { hashPassword } from "@/server/auth/password";
import { prisma } from "@/server/db";

// 集成测试夹具：每个用例创建随机用户名/线索/阶段/字段定义，结束后统一清理。
// 清理顺序（FK 约束）：lead_events → leads（按 owner 全量，覆盖经服务创建的线索）
// → 登记的自定义字段定义 → 登记的自定义阶段 → audit_logs → users（sessions 级联）。

const createdUserIds: string[] = [];
const createdStageIds: string[] = [];
const createdFieldDefIds: string[] = [];
const createdModelConfigIds: string[] = [];

/** 登记经服务层创建、需随清理回收的测试阶段/字段定义 */
export function registerTestStage(id: string): void {
  createdStageIds.push(id);
}

export function registerTestFieldDef(id: string): void {
  createdFieldDefIds.push(id);
}

/** 登记测试创建的模型配置（全局数据，清理时统一回收；T08） */
export function registerTestModelConfig(id: string): void {
  createdModelConfigIds.push(id);
}

export interface TestUser extends AuthUser {
  plainPassword: string;
}

/** 取 seed 预置阶段（缺失说明未跑 seed，直接失败给出明确提示） */
export async function getPresetStage(semanticKey: string) {
  const stage = await prisma.leadStage.findUnique({ where: { semanticKey } });
  if (!stage) {
    throw new Error(`缺少预置阶段 ${semanticKey}：请先运行 npm run db:seed`);
  }
  return stage;
}

export function uniqueUsername(prefix: string): string {
  return `t03-${prefix}-${randomBytes(4).toString("hex")}`;
}

/** 随机后缀：保证 code/key 等唯一约束列在测试间不冲突 */
export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

export async function createTestUser(
  role: AuthUser["role"],
  password = "Passw0rd!123",
): Promise<TestUser> {
  const user = await prisma.user.create({
    data: {
      username: uniqueUsername(role),
      passwordHash: await hashPassword(password),
      name: `测试${role === "admin" ? "管理员" : "销售"}`,
      role,
      status: "active",
    },
  });
  createdUserIds.push(user.id);
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    plainPassword: password,
  };
}

export async function createTestStage(data: {
  code: string;
  name: string;
  sortOrder?: number;
  isActive?: boolean;
}) {
  const stage = await prisma.leadStage.create({
    data: {
      code: data.code,
      name: data.name,
      sortOrder: data.sortOrder ?? 999,
      isActive: data.isActive ?? true,
    },
  });
  createdStageIds.push(stage.id);
  return stage;
}

export async function createTestFieldDef(data: {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "single_select";
  options?: unknown;
  validation?: unknown;
  isActive?: boolean;
}) {
  const def = await prisma.leadFieldDef.create({
    data: {
      key: data.key,
      label: data.label,
      type: data.type,
      ...(data.options !== undefined ? { options: data.options as never } : {}),
      ...(data.validation !== undefined
        ? { validation: data.validation as never }
        : {}),
      isBuiltin: false,
      isActive: data.isActive ?? true,
      sortOrder: 500,
    },
  });
  createdFieldDefIds.push(def.id);
  return def;
}

export async function cleanupTestUsers(): Promise<void> {
  // 0) 导入批次（import_rows 级联删除）与导出文件（T05，按 user_id 直接清理）
  if (createdUserIds.length > 0) {
    await prisma.importBatch.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
    await prisma.exportFile.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
  }
  // 1) 测试用户名下的线索：先删子表（任务/事件/沟通记录，T07 起含 tasks）
  //    再删线索（覆盖夹具与服务层两种创建路径）
  if (createdUserIds.length > 0) {
    const leads = await prisma.lead.findMany({
      where: { ownerId: { in: createdUserIds } },
      select: { id: true },
    });
    const leadIds = leads.map((lead) => lead.id);
    // 1.0) 实验分组（T14）：experiment_assignments 对 lead/experiment 均为
    //      RESTRICT 外键，必须先于线索删除；实验由测试管理员创建，一并回收
    const experiments = await prisma.experiment.findMany({
      where: { createdBy: { in: createdUserIds } },
      select: { id: true },
    });
    const experimentIds = experiments.map((experiment) => experiment.id);
    if (experimentIds.length > 0) {
      await prisma.experimentAssignment.deleteMany({
        where: { experimentId: { in: experimentIds } },
      });
      await prisma.experiment.deleteMany({
        where: { id: { in: experimentIds } },
      });
    }
    if (leadIds.length > 0) {
      // ai_runs 引用线索（RESTRICT），先于线索删除（T08）
      await prisma.aiRun.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.task.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.leadEvent.deleteMany({ where: { leadId: { in: leadIds } } });
      await prisma.interaction.deleteMany({ where: { leadId: { in: leadIds } } });
      // 兜底：挂在测试线索上但归属他人实验的分组明细（本套测试不产生，防御性）
      await prisma.experimentAssignment.deleteMany({
        where: { leadId: { in: leadIds } },
      });
      await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
    }
  }
  // 1.5) 测试创建的模型配置（此时 ai_runs 已删，无 FK 引用）
  if (createdModelConfigIds.length > 0) {
    await prisma.modelConfig.deleteMany({
      where: { id: { in: createdModelConfigIds } },
    });
    createdModelConfigIds.length = 0;
  }
  // 2) 自定义字段定义（此时已无引用）
  if (createdFieldDefIds.length > 0) {
    await prisma.leadFieldDef.deleteMany({ where: { id: { in: createdFieldDefIds } } });
    createdFieldDefIds.length = 0;
  }
  // 3) 自定义阶段（leads 已删，FK 无引用）
  if (createdStageIds.length > 0) {
    await prisma.leadStage.deleteMany({ where: { id: { in: createdStageIds } } });
    createdStageIds.length = 0;
  }
  if (createdUserIds.length === 0) {
    return;
  }
  // 4) audit_logs 无外键（§4.4），按 user_id 清理后删用户（sessions 级联删除）
  await prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  createdUserIds.length = 0;
}
