/**
 * AgentCall Store — 仓储接口。
 *
 * 职责：
 * - create：统一事务创建 AgentCall + AgentCallBinding + 初始 Attempt(1)，并校验
 *   parent Invocation 同租户（cross-tenant fail-closed）与幂等（parentInvocationId +
 *   logicalCallKey）。
 * - updateState：AgentCall 状态转移（合法转移由 domain 校验，Store 做原子 CAS）。
 * - recordOutbound：记录一次 outbound（Attempt.dispatchAttemptCount++）。
 * - 查询按 tenantId 过滤（跨租户隔离）。
 */
import type {
  AgentCall,
  AgentCallSourceType,
  AgentCallState,
} from "@/lib/agents/calls/domain/agent-call";
import type { AgentCallAttempt } from "@/lib/agents/calls/domain/agent-call-attempt";
import type { AgentCallBindingConfigInput } from "@/lib/agents/calls/domain/agent-call-binding";

export interface StoreAgentCallInput {
  id: string;
  tenantId: string;
  parentInvocationId: string;
  agentId: string;
  agentRevisionId: string;
  sourceType: AgentCallSourceType;
  sourceRef: string | null;
  /** 业务幂等键。 */
  logicalCallKey: string | null;
  /** 冻结的不可变证据。 */
  binding: AgentCallBindingConfigInput;
  bindingHash: string;
  createdAt: Date;
}

export interface UpdateAgentCallStateInput {
  callId: string;
  tenantId: string;
  from: AgentCallState;
  to: AgentCallState;
  now: Date;
  /** 进入终态时填 finishedAt；waiting_user 填 waitingAt；running 填 startedAt。 */
  lifecycle?: Partial<Pick<AgentCall, "startedAt" | "waitingAt" | "finishedAt">>;
  externalTaskRef?: string | null;
  externalContextRef?: string | null;
  resultText?: string | null;
  resultJson?: unknown;
  resultDigest?: string | null;
  errorCode?: string | null;
  errorSummary?: string | null;
}

export interface AgentCallStore {
  create(input: StoreAgentCallInput): Promise<AgentCall>;
  /** 幂等创建：若 (parentInvocationId, logicalCallKey) 已存在则返回已存在 call（不重复创建）。 */
  createIdempotent(input: StoreAgentCallInput): Promise<{
    call: AgentCall;
    binding: AgentCallBindingConfigInput;
    created: boolean;
  }>;
  /** 原子状态转移（CAS on versionNo）。非法转移由 domain 层校验后调用。 */
  updateState(input: UpdateAgentCallStateInput): Promise<AgentCall>;
  getById(params: { callId: string; tenantId: string }): Promise<AgentCall | null>;
  getBinding(params: {
    callId: string;
    tenantId: string;
  }): Promise<AgentCallBindingConfigInput | null>;
  /** 新建 Attempt（attemptNo 递增）。 */
  createAttempt(params: {
    callId: string;
    tenantId: string;
    attemptNo: number;
    now: Date;
  }): Promise<AgentCallAttempt>;
  /** 记录一次 outbound（Attempt.dispatchAttemptCount++）。 */
  recordOutbound(params: {
    callId: string;
    tenantId: string;
    attemptNo: number;
  }): Promise<AgentCallAttempt>;
}
