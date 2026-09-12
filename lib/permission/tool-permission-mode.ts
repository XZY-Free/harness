import type { PolicyEvaluationResult } from "./policy-evaluator";

export const TOOL_PERMISSION_MODES = ["auto", "ask", "full_access"] as const;
export type ToolPermissionMode = (typeof TOOL_PERMISSION_MODES)[number];
export function isToolPermissionMode(value: unknown): value is ToolPermissionMode {
  return TOOL_PERMISSION_MODES.includes(value as ToolPermissionMode);
}
export function applyToolPermissionMode(input: {
  mode: ToolPermissionMode | undefined;
  evaluation: PolicyEvaluationResult;
  sideEffect: string;
  riskClass: string;
  executorKind: string;
  targetKind?: string;
}): PolicyEvaluationResult {
  const { evaluation, mode } = input;
  // 历史快照没有模式时保留原决策；显式组织规则与 agent 门禁不能被偏好放宽。
  if (!mode || evaluation.decision === "block") return evaluation;
  if (mode === "ask")
    return {
      ...evaluation,
      decision: "pause",
      reasonCodes: [...evaluation.reasonCodes, "USER_MODE_ASK"],
      decisionSummary: "当前会话设置为执行前询问。",
    };
  if (evaluation.matchedRule || evaluation.agentGated) return evaluation;
  const safeRead = input.riskClass === "low" && ["none", "read"].includes(input.sideEffect);
  const isolatedCommand =
    input.executorKind === "builtin.shell" && input.targetKind === "container";
  if (mode === "full_access" || safeRead || isolatedCommand) {
    return {
      ...evaluation,
      decision: "allow",
      reasonCodes: [
        ...evaluation.reasonCodes,
        mode === "full_access" ? "USER_MODE_FULL_ACCESS" : "USER_MODE_AUTO",
      ],
      decisionSummary: "已按当前会话权限自动允许。",
    };
  }
  return evaluation;
}
