/**
 * AgentCallEventIngress — AgentCall 回传候选事件的持久批次账本（专题01 02 §六）。
 *
 * 职责：对 Agent transport 回传的事件做幂等接收与归一化，防止重复处理。
 *
 * 幂等键：
 * - UNIQUE(callId, producerEventId)：Agent 稳定事件 id 唯一。
 * - UNIQUE(callId, producerSequence)：Agent 连续序号唯一。
 * - 相同 producerEventId/producerSequence 但 payloadHash 不同 → 直接拒绝（hash 冲突）。
 *
 * Agent transport 的事件必须先成为 AgentCall event/state，由 Harness Loop 决定
 * 是否继续 / 是否最终完成顶层 Invocation。绝不能：
 *   AgentCall event → 直接写顶层 Invocation/Turn 终态。
 */

export const AGENT_CALL_EVENT_INGRESS_STATES = ["accepted", "mapped", "rejected"] as const;
export type AgentCallEventIngressState = (typeof AGENT_CALL_EVENT_INGRESS_STATES)[number];

/**
 * AgentCall 候选事件类型（归一化到 AgentCall 域，不直接映射 Invocation 终态）。
 * - call.started：远端 Task 已启动。
 * - call.completed：调用完成（归一化结果）。
 * - call.input_required：远端请求用户补充信息。
 * - call.failed：调用失败。
 * - call.cancelled：调用被取消。
 * - call.lost：调用丢失。
 */
export const AGENT_CALL_CANDIDATE_EVENT_TYPES = [
  "call.started",
  "call.completed",
  "call.input_required",
  "call.failed",
  "call.cancelled",
  "call.lost",
] as const;
export type AgentCallCandidateEventType = (typeof AGENT_CALL_CANDIDATE_EVENT_TYPES)[number];

export interface AgentCallEventIngress {
  id: string;
  callId: string;
  tenantId: string;
  /** Agent 稳定事件 id（幂等键 1）。 */
  producerEventId: string;
  /** Agent 连续序号（幂等键 2，整个 AgentCall 内连续）。 */
  producerSequence: number;
  /** AgentCall 候选事件类型。 */
  candidateType: string;
  /** 候选负载 SHA-256 hash（递归排序 key 后 sha256）。 */
  payloadHash: string;
  /** 短期保存原候选负载（诊断采样）。 */
  payloadJson: unknown;
  ingressState: AgentCallEventIngressState;
  receivedAt: Date;
  mappedAt: Date | null;
  rejectedReason: string | null;
}
