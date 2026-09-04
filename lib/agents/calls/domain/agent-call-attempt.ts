/**
 * AgentCallAttempt — AgentCall 的持久化出站尝试记录。
 *
 * - 用于幂等与唯一性：一次 AgentCall 的远端 Task 只能成功创建一个（Attempt 幂等边界）。
 * - 业务幂等键：parentInvocationId + logicalCallKey；同一 Invocation 重试不得重复创建
 *   第二个远端 Task。
 * - UNIQUE(callId, attemptNo) 保证 Attempt 编号唯一。
 * - dispatchAttemptCount 记录该 Attempt 对远端实际发起的 outbound 次数。
 */

export const AGENT_CALL_ATTEMPT_STATES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type AgentCallAttemptState = (typeof AGENT_CALL_ATTEMPT_STATES)[number];

/** Harness 触发 Agent 调用时的平台执行通道；不是 AgentCall 的业务来源。 */
export const AGENT_CALL_TRANSPORT_CHANNELS = ["hosted", "gateway"] as const;
export type AgentCallTransportChannel = (typeof AGENT_CALL_TRANSPORT_CHANNELS)[number];

/** AgentCallAttempt 终态集合。 */
export const AGENT_CALL_ATTEMPT_TERMINAL_STATES: readonly AgentCallAttemptState[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
];

export interface AgentCallAttempt {
  id: string;
  callId: string;
  tenantId: string;
  /** 1 表示第一次尝试。 */
  attemptNo: number;
  attemptState: AgentCallAttemptState;
  /** 该 Attempt 累计 outbound 次数（防重复 outbound）。 */
  dispatchAttemptCount: number;
  retryReasonCode: string | null;
  /** A2A taskId 的唯一 Authority。 */
  externalTaskRef: string | null;
  /** Hosted 进程内或 External Runtime 经 Gateway 触发。 */
  transportChannel: AgentCallTransportChannel;
  /** 可审计但不参与业务判断的 transport 元数据。 */
  transportMetadata: unknown;
  /** 初始 claim 的 durable 请求摘要（sha256: 前缀）；null=未被认领。 */
  requestDigest: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isAgentCallAttemptTerminal(state: AgentCallAttemptState): boolean {
  return (AGENT_CALL_ATTEMPT_TERMINAL_STATES as readonly string[]).includes(state);
}
