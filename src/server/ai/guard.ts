import { ApiError } from "@/server/http/api";

// AI 发起 guard（T09 预留 / T14 实验分组接入位，UIUX §4.7 常规组拦截、§6.2）：
// 实验进行中且该线索属于常规组时，服务端 403 拒绝 AI 调用（前端以同文案呈现，
// 直达 URL 绕过前端同样被拦）。T09 阶段实验分组尚未交付（无分组表），此处恒通过；
// T14 实现时替换函数体：查实验分组表 → 命中常规组即抛
// ApiError(403, "ai_control_group", "该客户属于实验常规组，按实验设计不提供 AI 辅助")。
// 调用位置在频控之前（createAiRun / retryAiRun）：常规组拒绝不消耗每日调用额度。

export async function assertAiAllowedForLead(leadId: string): Promise<void> {
  void leadId;
}

/** 常规组拦截的统一错误（T14 直接抛出；UIUX §7.2 常规组文案） */
export function controlGroupError(): ApiError {
  return new ApiError(
    403,
    "ai_control_group",
    "该客户属于实验常规组，按实验设计不提供 AI 辅助",
  );
}
