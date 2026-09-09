/** e2e 回复前缀，便于在服务端日志中辨认确定性回复。 */
export const E2E_REPLY_PREFIX = "[e2e-model]";

/** 由用户输入推导确定性回复。 */
export function buildE2eModelReply(userText: string): string {
  const trimmed = userText.trim();
  if (trimmed.length === 0) return `${E2E_REPLY_PREFIX} 收到空消息。`;
  // generateObject 与最终回答共用同一个 OpenAI 端点。行动决策必须返回符合
  // HARNESS_NEXT_ACTION_SCHEMA 的 JSON；否则正式 Harness Loop 会按协议拒绝普通正文。
  if (trimmed.includes("SnowHarness 的行动决策器")) {
    return JSON.stringify({
      actionId: "e2e-respond-1",
      stepNo: 1,
      purposeCode: "answer_user",
      shortPurpose: "生成最终回答",
      actionType: "respond",
      payload: {},
    });
  }
  // 最终回答端口会把 Harness 视图作为内部提示传给模型。测试服务必须像真实模型一样
  // 只返回用户可见答案，不能把 invocation / capability / actionHistory 等内部上下文回显。
  if (trimmed.startsWith("根据当前用户目标与已完成 observations")) {
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const view = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
        const objective = typeof view.objective === "string" ? view.objective.trim() : "";
        if (objective) return `${E2E_REPLY_PREFIX} ${objective}：已完成。`;
      } catch {
        return `${E2E_REPLY_PREFIX} 已完成处理。`;
      }
    }
  }
  return `${E2E_REPLY_PREFIX} 已收到你的消息：「${trimmed}」。这是 e2e 确定性回复。`;
}
