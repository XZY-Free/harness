/**
 * AgentCall Store — 仓储接口。
 *
 * 职责：
 * - finalizeAgentCall：统一事务锁定全部 Authority，严格处理幂等，并原子创建
 *   AgentCall + AgentCallBinding + 初始 Attempt(1) + CapabilityUse。
 * - updateState：AgentCall 状态转移（合法转移由 domain 校验，Store 做原子 CAS）。
 * - recordOutbound：记录一次 outbound（Attempt.dispatchAttemptCount++）。
 * - 查询按 tenantId 过滤（跨租户隔离）。
 */
import type { AgentCall, AgentCallSourceType } from "@/lib/agents/calls/domain/agent-call";
import type { AgentCallAttempt } from "@/lib/agents/calls/domain/agent-call-attempt";
import type { AgentCallTransportChannel } from "@/lib/agents/calls/domain/agent-call-attempt";
import type {
  AgentCallBindingCandidate,
  AgentCallBindingConfigInput,
} from "@/lib/agents/calls/domain/agent-call-binding";

export interface StoreAgentCallInput {
  id: string;
  tenantId: string;
  parentInvocationId: string;
  agentId: string;
  sourceType: AgentCallSourceType;
  sourceRef: string;
  /** 业务幂等键。 */
  logicalCallKey: string;
  transportChannel: AgentCallTransportChannel;
  /** 待最终事务验证的候选证据。 */
  bindingCandidate: AgentCallBindingCandidate;
  bindingHash: string;
  createdAt: Date;
}

/**
 * 当前 Attempt claim 结果。
 * - owner：本调用赢得认领（唯一会 record outbound / 发 HTTP 的调用方）。
 * - idempotent：已存在同 input 的认领（并发同 call 同 input），返回既有 attempt/call，不重复 outbound。
 * - conflict：已存在不同 input 的认领，稳定冲突。
 * - terminal：call/attempt 已终态（如已 completed），返回既有结果，不重复 outbound。
 */
export type InitialAttemptClaimResult =
  | { status: "owner"; attempt: AgentCallAttempt; call: AgentCall }
  | { status: "idempotent"; attempt: AgentCallAttempt; call: AgentCall }
  | { status: "conflict"; attempt: AgentCallAttempt; call: AgentCall }
  | { status: "terminal"; attempt: AgentCallAttempt; call: AgentCall };

export interface AgentCallStore {
  /** 最终事务冻结：Authority 校验 + 幂等 + Call/Binding/Attempt/CapabilityUse 原子写。 */
  finalizeAgentCall(input: StoreAgentCallInput): Promise<{
    call: AgentCall;
    binding: AgentCallBindingConfigInput;
    status: "created" | "replayed";
  }>;
  getById(params: { callId: string; tenantId: string }): Promise<AgentCall | null>;
  getByLogicalCallKey(params: {
    parentInvocationId: string;
    tenantId: string;
    logicalCallKey: string;
  }): Promise<AgentCall | null>;
  getBinding(params: {
    callId: string;
    tenantId: string;
  }): Promise<AgentCallBindingConfigInput | null>;
  /** 新建 Attempt（attemptNo 递增）。 */
  createAttempt(params: {
    callId: string;
    tenantId: string;
    retryReasonCode: string;
    transportChannel: AgentCallTransportChannel;
    now: Date;
  }): Promise<AgentCallAttempt>;
  /** 以 taskId 幂等绑定指定 Attempt；不同 taskId 或跨 Attempt 复用均冲突。 */
  bindAttemptTask(params: {
    callId: string;
    tenantId: string;
    attemptNo: number;
    externalTaskRef: string;
    now: Date;
  }): Promise<AgentCallAttempt>;
  /** 按 tenant + taskId 精确定位 Attempt。 */
  getAttemptByTaskRef(params: {
    tenantId: string;
    externalTaskRef: string;
  }): Promise<AgentCallAttempt | null>;
  /** 唯一活动 Attempt；无活动时返回 attemptNo 最大的终态 Attempt。 */
  getCurrentAttempt(params: {
    callId: string;
    tenantId: string;
  }): Promise<AgentCallAttempt | null>;
  finishAttempt(params: {
    callId: string;
    tenantId: string;
    attemptNo: number;
    to: "completed" | "failed" | "cancelled" | "lost";
    errorCode?: string | null;
    errorSummary?: string | null;
    now: Date;
  }): Promise<AgentCallAttempt>;
  /** 记录一次 outbound（Attempt.dispatchAttemptCount++）。 */
  recordOutbound(params: {
    callId: string;
    tenantId: string;
    attemptNo: number;
  }): Promise<AgentCallAttempt>;
  /**
   * 原子认领当前唯一活动 Attempt；禁止默认读取 Attempt 1。
   *
   * 语义：requestDigest IS NULL → owner（唯一发 HTTP 者，dispatchAttemptCount 置 1，
   * attempt 转 running，AgentCall 仍等待正式 call.started）；requestDigest 已存在 → 同 digest=idempotent、
   * 异 digest=conflict；call/attempt 已终态 → terminal。跨并发 start 用行锁串行化。
   */
  claimCurrentAttempt(params: {
    callId: string;
    tenantId: string;
    requestDigest: string;
    now: Date;
  }): Promise<InitialAttemptClaimResult>;
}
