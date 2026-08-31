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
  return `${E2E_REPLY_PREFIX} 已收到你的消息：「${trimmed}」。这是 e2e 确定性回复。`;
}
