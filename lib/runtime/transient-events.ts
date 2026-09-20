import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { INVOCATION_TERMINAL_STATES } from "@/lib/persistence/schema/executions";
/**
 * Transient 事件处理。
 *
 * 事实源：
 * - docs/architecture/persistence.md （RuntimeEventIngress L486-500）
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API：transient 通道）
 * - docs/architecture/runtime-control-plane.md
 *
 * 职责：
 * - ingressTransientBatch：接收 Runtime transient 事件批次（response.delta/heartbeat/stdout/stderr）。
 * - 不持久化（不写 RuntimeEventIngress 行）。
 * - 不消费 producerSequence（transient 序号独立于持久序号）。
 * - 会话模式通过进程内事件总线推给 SSE 订阅者。
 * - 返回 accepted_through_transient_sequence。
 *
 * 关键约束：
 * - transient 事件不进入持久账本（与 RuntimeEventIngress 区分）。
 * - transient_sequence 在整个 Invocation 内连续，但独立于 producerSequence。
 * - transient 事件不影响 Invocation/Turn 状态。
 * - 批次非空校验 + transientSequenceStart 与 events[0] 一致校验。
 */
import { IngressBatchEmptyError } from "@/lib/runtime/application/ingress-runtime-events";
import { IngressAuthorityMismatchError } from "@/lib/runtime/application/ingress-runtime-events";
import {
  IngressInvocationNotFoundError,
  IngressInvocationTerminalError,
} from "@/lib/runtime/errors";
import { getRuntimeSessionBindingByOwnership } from "@/lib/runtime/persistence/runtime-session-store";
import type { AuthorityIdentity } from "@/lib/runtime/runtime-protocol";
import { isDecimalLeaseEpoch } from "@/lib/runtime/thread-generation";
import { publishThreadTransientEvent } from "@/lib/runtime/transient-event-bus";

/** Transient 事件输入（不持久化）。 */
export interface TransientCandidateEvent {
  /** Transient 事件稳定 id（仅供诊断，不参与持久化键）。 */
  transient_id: string;
  /** Transient 事件类型（response.delta/heartbeat/stdout/stderr/...）。 */
  type: string;
  /** Transient 连续序号（独立于持久 producerSequence，整个 Invocation 内连续）。 */
  transient_sequence: number;
  /** 候选负载（结构化、已脱敏）。 */
  payload: Record<string, unknown>;
}

/** ingressTransientBatch 入参。 */
export interface IngressTransientBatchParams {
  tenantId: string;
  invocationId: string;
  /**
   * 本条 transient 通道所属的**执行代际**（R02 §2）。
   *
   * A11：transient 不持久化，但"不持久化"不等于"没有身份"。接管之后 Invocation 仍在运行，
   * 旧 Hosted 执行者在发现租约丢失/abort 生效之前发出的 delta 若只看 `invocationId`，
   * 就会混进新代际的流式展示。因此这里必须逐项复核 (Attempt, Ownership, leaseEpoch)
   * 及其唯一 Session——与持久入口同一条代际语义，只是不做加锁重活。
   */
  authority: AuthorityIdentity;
  /** 本批次起始 transient_sequence（必须等于 events[0].transient_sequence）。 */
  transientSequenceStart: number;
  /** Transient 事件列表（按 transient_sequence 升序）。 */
  events: TransientCandidateEvent[];
  /** 关联标识（X-Request-Id / traceparent）。 */
  correlationId?: string | null;
}

/** ingressTransientBatch 返回结果。 */
export interface TransientBatchResult {
  invocationId: string;
  /** 本批次接受到的最大 transient_sequence（含）。 */
  acceptedThroughTransientSequence: number;
  /** transient 事件不持久化。 */
  persisted: false;
}

/**
 * 入口：接收 Runtime transient 事件批次。
 *
 * 行为：
 * 1. 查 Invocation（跨租户隔离），不存在 → IngressInvocationNotFoundError。
 * 2. 校验 Invocation 非终态 → IngressInvocationTerminalError。
 * 3. 校验批次非空 + transientSequenceStart 与 events[0] 一致。
 * 4. 校验 transient_sequence 连续性（从 transientSequenceStart 开始递增）。
 * 5. 不持久化；会话模式通过事件总线推送给当前 Thread 订阅者。
 * 6. 返回 acceptedThroughTransientSequence + persisted=false。
 *
 * @throws IngressInvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws IngressInvocationTerminalError Invocation 已终态
 * @throws IngressBatchEmptyError 批次为空
 * @throws IngressSequenceStartMismatchError transientSequenceStart 与 events[0] 不一致
 * @throws EventSequenceGapError transient_sequence 不连续（retryable）
 */
export async function ingressTransientBatch(
  params: IngressTransientBatchParams,
): Promise<TransientBatchResult> {
  // 1. 查 Invocation（跨租户隔离）
  const invocation = await getInvocationById(params.tenantId, params.invocationId);
  if (!invocation) {
    throw new IngressInvocationNotFoundError(params.invocationId);
  }

  // 2. 校验非终态
  if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
    throw new IngressInvocationTerminalError(params.invocationId, invocation.executionState);
  }

  // 2.5 代际校验（A11）：请求携带的 (Attempt, Ownership, leaseEpoch) 必须仍等于**当前**
  //     活跃代际，且该 Ownership 的唯一 Session 与请求一致。任何一项不符 → 拒绝发布，
  //     旧执行者的迟到增量不会进入当前页面的流。
  await requireCurrentTransientGeneration(params);

  // 3. 校验批次非空
  if (params.events.length === 0) {
    throw new IngressBatchEmptyError(params.invocationId);
  }

  // 4. 校验 transientSequenceStart 与 events[0] 一致
  const firstEvent = params.events[0];
  if (firstEvent && firstEvent.transient_sequence !== params.transientSequenceStart) {
    throw new IngressAuthorityMismatchError(params.invocationId);
  }

  // 5. 校验 transient_sequence 连续性（从 transientSequenceStart 开始递增）
  for (let i = 0; i < params.events.length; i++) {
    const event = params.events[i];
    if (!event) continue;
    const expected = params.transientSequenceStart + i;
    if (event.transient_sequence !== expected) {
      throw new TransientSequenceGapError(params.invocationId, expected, event.transient_sequence);
    }
  }

  // 6. 不持久化；会话模式下推送给当前 Thread 的 SSE 订阅者。
  //    发布出去的事件带**完整代际标记**：消费侧（SSE 客户端）即使收到跨代的乱序到达，
  //    也能按 (Invocation, Attempt, Ownership, leaseEpoch) 判定它是否属于当前展示代际。
  if (invocation.threadId && invocation.turnId) {
    const generation = {
      invocationId: params.invocationId,
      attemptId: params.authority.attemptId,
      ownershipId: params.authority.ownershipId,
      leaseEpoch: params.authority.leaseEpoch,
    };
    for (const event of params.events) {
      publishThreadTransientEvent({
        transientId: event.transient_id,
        threadId: invocation.threadId,
        turnId: invocation.turnId,
        generation,
        type: event.type,
        occurredAt: new Date().toISOString(),
        payload: event.payload,
      });
    }
  }

  return {
    invocationId: params.invocationId,
    acceptedThroughTransientSequence: params.transientSequenceStart + params.events.length - 1,
    persisted: false,
  };
}

/**
 * A11：transient 通道的当前代际复核。
 *
 * 与持久入口共用同一份代际定义（当前 active Owner + 该 Ownership 的唯一 Session），
 * 但**只读**：transient 是展示性高频通道，不能为此在每次 delta 上取行锁——
 * 代际的权威变更（接管、收口）始终由持久路径在同一事务内完成，这里只需要在读取时
 * 确认"请求声明的代际仍是当前代际"。任何读不到/不一致都 fail closed（不发布）。
 */
async function requireCurrentTransientGeneration(
  params: IngressTransientBatchParams,
): Promise<void> {
  const owner = await getActiveExecutionOwnership({
    tenantId: params.tenantId,
    invocationId: params.invocationId,
  });
  // epoch 逐字符复核：先要求线上形态是**规范十进制字符串**，再与持久代际的十进制写法精确比较。
  // 不经 Number —— A11：`2^53` 以上会静默丢精度，一旦"比较相等"就再也分不出两代。
  if (!isDecimalLeaseEpoch(params.authority.leaseEpoch)) {
    throw new IngressAuthorityMismatchError(params.invocationId);
  }
  if (
    !owner ||
    owner.id !== params.authority.ownershipId ||
    owner.attemptId !== params.authority.attemptId ||
    String(owner.leaseEpoch) !== params.authority.leaseEpoch
  ) {
    throw new IngressAuthorityMismatchError(params.invocationId);
  }
  const session = await getRuntimeSessionBindingByOwnership(params.tenantId, owner.id);
  if (
    !session ||
    session.id !== params.authority.sessionBindingId ||
    session.invocationId !== params.invocationId ||
    session.attemptId !== owner.attemptId ||
    session.leaseEpoch !== owner.leaseEpoch ||
    session.runtimeRevisionId !== params.authority.runtimeRevisionId
  ) {
    throw new IngressAuthorityMismatchError(params.invocationId);
  }
}

/** Transient sequence 不连续错误（route 层映射 409 EVENT_SEQUENCE_GAP）。 */
export class TransientSequenceGapError extends Error {
  constructor(
    public readonly invocationId: string,
    public readonly expectedSequence: number,
    public readonly actualSequence: number,
  ) {
    super(
      `Transient sequence 空洞：invocation ${invocationId} 期望 ${expectedSequence}，实际 ${actualSequence}`,
    );
    this.name = "TransientSequenceGapError";
  }
}
