import {
  analysisSchema,
  callPrepSchema,
  interactionSummarySchema,
  type AnalysisOutput,
  type CallPrepOutput,
  type InteractionSummaryOutput,
} from "@/server/ai/validator";
import type { RunTypeValue } from "@/lib/schemas/ai";

// AI 输出复制格式（T09/T10，UIUX §4.10）：复制一律产出纯文本（不带 Markdown 符号），
// 分节排版，末尾常驻"AI 生成，仅供参考"标识。分析（PRD §5.4 八项）、
// 准备卡（PRD §5.5 六项）与沟通摘要草稿（T10）各一份格式；
// 纯函数，单测固化（UIUX §7.2 合规文案）。

const FIT_LEVEL_LABELS: Record<string, string> = {
  high: "高",
  mid: "中",
  low: "低",
  insufficient: "信息不足",
};

const COPY_FOOTER = "(AI 生成,仅供参考,请核对后使用)";

function numbered(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function formatAnalysisCopy(
  leadName: string,
  generatedAtDisplay: string,
  output: AnalysisOutput,
): string {
  const knownFacts = output.facts.filter((fact) => fact.status === "confirmed");
  const unverifiedFacts = output.facts.filter(
    (fact) => fact.status === "unverified",
  );
  const sections: string[] = [
    `【AI 客户分析】客户:${leadName}  生成时间:${generatedAtDisplay}`,
    `■ 匹配度：${FIT_LEVEL_LABELS[output.fit.level] ?? output.fit.level}\n依据：${output.fit.reason}`,
  ];
  sections.push(
    knownFacts.length > 0
      ? `■ 已知事实\n${numbered(knownFacts.map((fact) => `${fact.topic}：${fact.detail}`))}`
      : "■ 已知事实\n（暂无输入资料支撑的已知事实）",
  );
  if (unverifiedFacts.length > 0) {
    sections.push(
      `■ 待核实信息\n${numbered(unverifiedFacts.map((fact) => `${fact.topic}：${fact.detail}`))}`,
    );
  }
  if (output.pains.length > 0) {
    sections.push(
      `■ 经营痛点（含推断依据）\n${numbered(output.pains.map((pain) => `${pain.pain}（依据：${pain.evidence}）`))}`,
    );
  }
  if (output.angles.length > 0) {
    sections.push(`■ 沟通切入点\n${numbered(output.angles)}`);
  }
  sections.push(`■ 推荐下一步动作\n${output.next_action}`);
  if (output.verify_questions.length > 0) {
    sections.push(`■ 建议向客户核实的问题\n${numbered(output.verify_questions)}`);
  }
  return `${sections.join("\n\n")}\n${COPY_FOOTER}`;
}

export function formatCallPrepCopy(
  leadName: string,
  generatedAtDisplay: string,
  output: CallPrepOutput,
): string {
  const sections: string[] = [
    `【AI 电话准备卡】客户:${leadName}  生成时间:${generatedAtDisplay}`,
    `■ 本次沟通目标\n${output.goal}`,
    `■ 开场建议(15–30 秒)\n${output.opening}`,
    `■ 需求诊断问题\n${numbered(output.diag_questions)}`,
    `■ 可能异议与回应\n${numbered(
      output.objections.map((item) => `异议:${item.objection} / 建议回应:${item.response}`),
    )}`,
    `■ 希望确认的下一步\n${output.confirm_next}`,
    `■ 需要避免的表述\n${numbered(output.avoid)}`,
  ];
  return `${sections.join("\n\n")}\n${COPY_FOOTER}`;
}

/** T10 摘要草稿：标注"草稿"字样，提示以确认保存后的正式记录为准 */
export function formatInteractionSummaryCopy(
  leadName: string,
  generatedAtDisplay: string,
  output: InteractionSummaryOutput,
): string {
  const sections: string[] = [
    `【AI 沟通摘要草稿】客户:${leadName}  生成时间:${generatedAtDisplay}`,
    `■ 客户实际反馈（草稿）\n${output.summary}`,
    `■ 下一步动作（草稿）\n${output.next_action}`,
    "（以上为 AI 草稿，经你修改确认保存后才形成正式沟通记录）",
  ];
  return `${sections.join("\n\n")}\n${COPY_FOOTER}`;
}

/** 按 run 类型分发；输出先经与后端同一份 Zod Schema 校验（结构异常返回 null，
 * 调用方提示复制失败），不信任历史数据形态 */
export function formatAiRunCopy(
  runType: RunTypeValue,
  leadName: string,
  generatedAtDisplay: string,
  output: unknown,
): string | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  try {
    if (runType === "analysis") {
      const verdict = analysisSchema.safeParse(output);
      return verdict.success
        ? formatAnalysisCopy(leadName, generatedAtDisplay, verdict.data)
        : null;
    }
    if (runType === "call_prep") {
      const verdict = callPrepSchema.safeParse(output);
      return verdict.success
        ? formatCallPrepCopy(leadName, generatedAtDisplay, verdict.data)
        : null;
    }
    if (runType === "interaction_summary") {
      const verdict = interactionSummarySchema.safeParse(output);
      return verdict.success
        ? formatInteractionSummaryCopy(leadName, generatedAtDisplay, verdict.data)
        : null;
    }
  } catch {
    return null;
  }
  return null;
}
