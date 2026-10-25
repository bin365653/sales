import { prisma } from "@/server/db";
import { ApiError } from "@/server/http/api";
import { RunTypeValue } from "@/lib/schemas/ai";

// Prompt Registry（T08，实施计划 §7.1 / PRD §5.11）：
// 按 run_type 加载启用模板的当前版本（version 最高者即"启用"，模板内版本递增）。
// 业务代码零硬编码提示词：run 与版本绑定落库（ai_runs.prompt_version_id），历史可复现。
// 版本只增不改（T15 提供版本管理 UI）；模板/版本缺失属服务端配置问题，500。

export interface ResolvedPrompt {
  versionId: string;
  version: number;
  content: string;
}

export async function resolveActivePromptVersion(
  runType: RunTypeValue,
): Promise<ResolvedPrompt> {
  const template = await prisma.promptTemplate.findUnique({
    where: { runType },
    select: { id: true, isActive: true },
  });
  if (!template || !template.isActive) {
    throw new ApiError(500, "prompt_missing", `AI 提示词模板缺失（${runType}），请联系管理员`);
  }
  const version = await prisma.promptVersion.findFirst({
    where: { templateId: template.id },
    orderBy: { version: "desc" },
    select: { id: true, version: true, content: true },
  });
  if (!version) {
    throw new ApiError(500, "prompt_missing", `AI 提示词版本缺失（${runType}），请联系管理员`);
  }
  return { versionId: version.id, version: version.version, content: version.content };
}
