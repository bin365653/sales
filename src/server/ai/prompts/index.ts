import { RunTypeValue } from "@/lib/schemas/ai";
import {
  ANALYSIS_OUTPUT_SCHEMA,
  ANALYSIS_PROMPT_NAME,
  ANALYSIS_SYSTEM_PROMPT,
} from "./analysis";
import {
  CALL_PREP_OUTPUT_SCHEMA,
  CALL_PREP_PROMPT_NAME,
  CALL_PREP_SYSTEM_PROMPT,
} from "./call-prep";
import {
  INTERACTION_SUMMARY_OUTPUT_SCHEMA,
  INTERACTION_SUMMARY_PROMPT_NAME,
  INTERACTION_SUMMARY_SYSTEM_PROMPT,
} from "./interaction-summary";

// 提示词模板注册表（实施计划 §7.1 Prompt Registry 的种子源 / §7.3 交付物）。
// seed 以此为源建 prompt_templates + v1 版本；此后版本只增不改（T15 版本管理），
// 业务代码零硬编码提示词——运行时一律经 Prompt Registry 读库。

export interface PromptTemplateSeed {
  runType: RunTypeValue;
  name: string;
  content: string;
  outputSchema: Record<string, unknown>;
}

export const PROMPT_TEMPLATE_SEEDS: PromptTemplateSeed[] = [
  {
    runType: "analysis",
    name: ANALYSIS_PROMPT_NAME,
    content: ANALYSIS_SYSTEM_PROMPT,
    outputSchema: ANALYSIS_OUTPUT_SCHEMA,
  },
  {
    runType: "call_prep",
    name: CALL_PREP_PROMPT_NAME,
    content: CALL_PREP_SYSTEM_PROMPT,
    outputSchema: CALL_PREP_OUTPUT_SCHEMA,
  },
  {
    runType: "interaction_summary",
    name: INTERACTION_SUMMARY_PROMPT_NAME,
    content: INTERACTION_SUMMARY_SYSTEM_PROMPT,
    outputSchema: INTERACTION_SUMMARY_OUTPUT_SCHEMA,
  },
];
