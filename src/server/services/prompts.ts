import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { AuthUser } from "@/lib/auth";
import { assertAdmin } from "@/server/permissions";
import { AuditAction, writeAudit } from "@/server/auth/audit";
import { PromptVersionCreateInput } from "@/lib/schemas/settings";

// 提示词模板与版本（T15 补齐写侧；T08 已建表 + 只读 API + Registry）。
// 版本只增不改（验收项：不可变、可追溯）——不提供修改/删除端点；
// "启用"即版本号最高者（T08 Registry 约定），新建版本保存后立即生效，
// 回滚 = 用旧版本内容再建一个新版本。ai_runs.prompt_version_id 记录
// 具体 run 使用的版本，历史可复现。

export interface PromptTemplateView {
  id: string;
  name: string;
  runType: string;
  isActive: boolean;
  versions: Array<{
    id: string;
    version: number;
    content: string;
    outputSchema: Prisma.JsonValue | null;
    createdBy: string;
    createdAt: Date;
  }>;
}

export async function listPromptTemplates(): Promise<PromptTemplateView[]> {
  const templates = await prisma.promptTemplate.findMany({
    orderBy: { runType: "asc" },
    include: {
      versions: {
        orderBy: { version: "desc" },
        select: {
          id: true,
          version: true,
          content: true,
          outputSchema: true,
          createdBy: true,
          createdAt: true,
        },
      },
    },
  });
  return templates;
}

export interface PromptVersionView {
  id: string;
  version: number;
  content: string;
  outputSchema: Prisma.JsonValue | null;
  createdAt: Date;
}

/** 新建版本：version = 当前最高 + 1（唯一约束兜底并发），保存即生效 */
export async function createPromptVersion(
  actor: AuthUser,
  templateId: string,
  input: PromptVersionCreateInput,
): Promise<PromptVersionView> {
  assertAdmin(actor);
  const template = await prisma.promptTemplate.findUnique({
    where: { id: templateId },
    select: { id: true, runType: true, isActive: true },
  });
  if (!template || !template.isActive) {
    throw new ApiError(404, "not_found", "提示词模板不存在");
  }
  const maxVersion = await prisma.promptVersion.aggregate({
    where: { templateId },
    _max: { version: true },
  });
  const nextVersion = (maxVersion._max.version ?? 0) + 1;
  let created;
  try {
    created = await prisma.promptVersion.create({
      data: {
        templateId,
        version: nextVersion,
        content: input.content,
        ...(input.outputSchema !== undefined
          ? { outputSchema: input.outputSchema as Prisma.InputJsonValue }
          : {}),
        createdBy: actor.id,
      },
      select: {
        id: true,
        version: true,
        content: true,
        outputSchema: true,
        createdAt: true,
      },
    });
  } catch (error) {
    // 并发创建同版本号：唯一约束兜底，提示刷新重试
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiError(
        409,
        "prompt_version_conflict",
        "提示词版本已被其他人创建，请刷新后重试",
      );
    }
    throw error;
  }
  await writeAudit({
    userId: actor.id,
    action: AuditAction.promptVersionCreated,
    objectType: "prompt_template",
    objectId: templateId,
    detail: { run_type: template.runType, version: created.version },
  });
  return created;
}
