/**
 * AgentCall 领域实体与状态机。
 *
 * 专题01 冻结架构（00 §5.2 / 02 §五）：
 * - AgentCall 是 Parent Harness Invocation 内部的 Agent 能力调用子执行域，
 *   绝不成为第二个顶层 Invocation。
 * - AgentCall.parentInvocationId 恒必填，且必须属于同一 tenant。
 * - AgentCall 有自己的独立状态机，不复用 parent Invocation 的状态 Authority：
 *     AgentCall completed ≠ parent Invocation completed
 *     AgentCall failed  ≠ 自动修改 parent Invocation
 *   父 Invocation 后续如何处理，由 Harness Loop 决定。
 *
 * 状态：
 * - queued：已创建，等待调用。
 * - running：正在对远端 Agent 执行。
 * - waiting_user：等待用户补充信息（A2A input-required）。
 * - completed：调用完成（终态）。
 * - failed：调用失败（终态）。
 * - cancelled：被取消（终态）。
 * - lost：心跳/事件超时，被标记为丢失（终态）。
 *
 * 终态不可逆；进入终态后不允许再转移。
 */

export const AGENT_CALL_STATES = [
  "queued",
  "running",
  "waiting_user",
  "completed",
  "failed",
  "cancelled",
  "lost",
] as const;
export type AgentCallState = (typeof AGENT_CALL_STATES)[number];

/** AgentCall 终态集合（不可恢复）。 */
export const AGENT_CALL_TERMINAL_STATES: readonly AgentCallState[] = [
  "completed",
  "failed",
  "cancelled",
  "lost",
];

/** AgentCall 来源类型（专题01 第一阶段只会出现 user_selected）。 */
export const AGENT_CALL_SOURCE_TYPES = [
  "user_selected",
  "dynamic_discovery",
  "policy",
  "gateway",
] as const;
export type AgentCallSourceType = (typeof AGENT_CALL_SOURCE_TYPES)[number];

/**
 * AgentCall 状态转移表。
 *
 * 合法转移（专题01 冻结）：
 * - queued → running：开始执行。
 * - running → waiting_user：远端 input-required，等待用户。
 * - waiting_user → running：用户补充后 resume。
 * - running / waiting_user → completed：成功完成。
 * - running / waiting_user → failed：失败。
 * - queued / running / waiting_user → cancelled：取消。
 * - running / waiting_user → lost：心跳/事件超时。
 *
 * 禁止：
 * - 任何终态再转移。
 * - queued 直接 → completed/failed（必须先 running，防止未调用就声称完成）。
 * - waiting_user 直接 → failed/lost 之外不经 running。
 */
export const AGENT_CALL_TRANSITIONS: Readonly<Record<AgentCallState, readonly AgentCallState[]>> = {
  queued: ["running", "cancelled"],
  running: ["waiting_user", "completed", "failed", "cancelled", "lost"],
  waiting_user: ["running", "completed", "failed", "cancelled", "lost"],
  completed: [],
  failed: [],
  cancelled: [],
  lost: [],
};

export class AgentCallStateTransitionError extends Error {
  constructor(
    public readonly callId: string,
    public readonly from: AgentCallState,
    public readonly to: AgentCallState,
  ) {
    super(`AgentCall ${callId} 非法状态转移: ${from} → ${to}`);
    this.name = "AgentCallStateTransitionError";
  }
}

export class AgentCallDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCallDomainError";
  }
}

/** 校验状态转移合法性；非法时抛 AgentCallStateTransitionError。 */
export function assertAgentCallTransition(
  callId: string,
  from: AgentCallState,
  to: AgentCallState,
): void {
  if (AGENT_CALL_TRANSITIONS[from].includes(to)) return;
  throw new AgentCallStateTransitionError(callId, from, to);
}

export function isAgentCallTerminal(state: AgentCallState): boolean {
  return (AGENT_CALL_TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * AgentCall 领域实体（持久化面向）。
 *
 * 可变字段仅限：state、externalContextRef、externalTaskRef、result、
 * error、lifecycle timestamp、versionNo、attempts 等。
 * 证据类字段（见 AgentCallBinding）不可变。
 */
export interface AgentCall {
  id: string;
  tenantId: string;
  /** Parent Harness Invocation id — 恒必填，AgentCall 永远是子执行域。 */
  parentInvocationId: string;
  /** stable Agent.id（能力资产）。 */
  agentId: string;
  /** exact AgentRevision.id（冻结，见 AgentCallBinding）。 */
  agentRevisionId: string;
  /** 调用来源类型。 */
  sourceType: AgentCallSourceType;
  /** 来源引用（user_selected → Turn.id）。 */
  sourceRef: string | null;
  /** 当前状态。 */
  state: AgentCallState;
  /** A2A contextId（外部上下文引用）；由 AgentSessionBinding.externalContextRef 持有，此处为冗余快照。 */
  externalContextRef: string | null;
  /** A2A taskId（外部任务引用）。 */
  externalTaskRef: string | null;
  /** 归一化结果（resultText / resultJson / resultDigest 见 result 持久化）。 */
  resultText: string | null;
  resultJson: unknown;
  resultDigest: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  /** 业务幂等键（parentInvocationId + logicalCallKey 幂等）。 */
  logicalCallKey: string | null;
  createdAt: Date;
  startedAt: Date | null;
  waitingAt: Date | null;
  finishedAt: Date | null;
  versionNo: number;
}
