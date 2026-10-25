import type { RunStatusValue, RunTypeValue } from "@/lib/schemas/ai";

// AiRun 视图映射（T09）：服务端详情页首屏整形与客户端轮询结果映射共用同一实现，
// 保证两条路径产出的字段口径一致。API 返回的日期是 ISO 字符串，服务层对象是 Date。

export interface AiRunView {
  id: string;
  runType: RunTypeValue;
  status: RunStatusValue;
  errorType: string | null;
  errorMessage: string | null;
  output: unknown;
  durationMs: number | null;
  retryOfId: string | null;
  inputDataVersion: number;
  /** ISO 字符串（服务端 Date 也先转 ISO，客户端再本地化展示） */
  createdAt: string;
  /** 面板展示：服务商/模型名（不含密钥相关列，§8.3） */
  provider: string | null;
  modelName: string | null;
  promptVersion: number | null;
}

interface RawRunLike {
  id: string;
  runType: string;
  status: string;
  errorType?: string | null;
  errorMessage?: string | null;
  output?: unknown;
  durationMs?: number | null;
  retryOfId?: string | null;
  inputDataVersion?: number;
  createdAt: Date | string;
  modelConfig?:
    | { provider?: string | null; modelName?: string | null }
    | null;
  promptVersion?: { version?: number | null } | null;
}

export function toAiRunView(run: RawRunLike): AiRunView {
  return {
    id: run.id,
    runType: run.runType as RunTypeValue,
    status: run.status as RunStatusValue,
    errorType: run.errorType ?? null,
    errorMessage: run.errorMessage ?? null,
    output: run.output ?? null,
    durationMs: run.durationMs ?? null,
    retryOfId: run.retryOfId ?? null,
    inputDataVersion: run.inputDataVersion ?? 0,
    createdAt:
      run.createdAt instanceof Date
        ? run.createdAt.toISOString()
        : run.createdAt,
    provider: run.modelConfig?.provider ?? null,
    modelName: run.modelConfig?.modelName ?? null,
    promptVersion: run.promptVersion?.version ?? null,
  };
}
