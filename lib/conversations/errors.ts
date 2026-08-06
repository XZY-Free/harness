/**
 * V11 会话域共享错误类。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §5、§9、
 * ../v11-agentkit-platform/11-api-and-event-boundaries.md 。
 *
 * Route 层根据 error 实例映射 HTTP 状态码和稳定 error_code。
 */
import type {
 PendingInputState,
 ThreadLifecycleState,
 ThreadRelationType,
 TurnState,
} from "@/lib/persistence/schema/conversation";

/** Thread 不存在或跨租户不可见（映射 404 RESOURCE_NOT_FOUND，不泄露存在）。 */
export class ThreadNotFoundError extends Error {
 constructor(public readonly threadId: string) {
 super(`Thread 不存在或不可见：${threadId}`);
 this.name = "ThreadNotFoundError";
 }
}

/** Thread lifecycle 不允许新 Turn（archived/deleted）。映射 409 THREAD_NOT_ACCEPTING_TURNS。 */
export class ThreadNotAcceptingTurnsError extends Error {
 constructor(
 public readonly threadId: string,
 public readonly lifecycleState: ThreadLifecycleState,
 ) {
 super(`Thread ${threadId} 状态为 ${lifecycleState}，不允许新 Turn`);
 this.name = "ThreadNotAcceptingTurnsError";
 }
}

/** Thread 乐观锁冲突。映射 412 ETAG_MISMATCH。 */
export class ThreadVersionConflictError extends Error {
 constructor(
 public readonly threadId: string,
 public readonly expected: number,
 public readonly actual: number,
 ) {
 super(`Thread ${threadId} 版本冲突：期望 ${expected}，实际 ${actual}`);
 this.name = "ThreadVersionConflictError";
 }
}

/** Turn 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND。 */
export class TurnNotFoundError extends Error {
 constructor(public readonly turnId: string) {
 super(`Turn 不存在或不可见：${turnId}`);
 this.name = "TurnNotFoundError";
 }
}

/** Turn 状态转换非法。映射 409 TURN_STATE_CONFLICT。 */
export class TurnStateConflictError extends Error {
 constructor(
 public readonly turnId: string,
 public readonly currentState: TurnState,
 public readonly attemptedAction: string,
 ) {
 super(`Turn ${turnId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
 this.name = "TurnStateConflictError";
 }
}

/** ThreadItem 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND。 */
export class ThreadItemNotFoundError extends Error {
 constructor(public readonly itemId: string) {
 super(`ThreadItem 不存在或不可见：${itemId}`);
 this.name = "ThreadItemNotFoundError";
 }
}

/** supersede 链将形成环。映射 409 ITEM_SUPERSEDE_CYCLE。 */
export class ItemSupersedeCycleError extends Error {
 constructor(
 public readonly itemId: string,
 public readonly supersededByItemId: string,
 ) {
 super(`Item ${itemId} 的 supersede 链将形成环（指向 ${supersededByItemId}）`);
 this.name = "ItemSupersedeCycleError";
 }
}

/** Goal 已有 active 状态，不能新建。映射 409 GOAL_ALREADY_ACTIVE。 */
export class GoalAlreadyActiveError extends Error {
 constructor(public readonly threadId: string) {
 super(`Thread ${threadId} 已有 active Goal`);
 this.name = "GoalAlreadyActiveError";
 }
}

/** ThreadRelation 已存在（同 parent/child/type）。映射 409 RELATION_CONFLICT。 */
export class ThreadRelationConflictError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly childThreadId: string,
 public readonly relationType: ThreadRelationType,
 ) {
 super(`ThreadRelation 已存在：${parentThreadId} → ${childThreadId} (${relationType})`);
 this.name = "ThreadRelationConflictError";
 }
}

/**
 * SSE 游标过期：Last-Event-ID 早于最早可用 sequence。
 *
 * 事实源：§11 行 330、§14 行 42。
 * 映射 409 EVENT_CURSOR_EXPIRED，携带最早可用 sequence，客户端重新读取 Item 快照后续订。
 */
export class EventCursorExpiredError extends Error {
 constructor(
 public readonly streamId: string,
 public readonly requestedSequence: number,
 public readonly earliestAvailableSequence: number,
 ) {
 super(
 `Event 游标过期：stream ${streamId} 请求 sequence ${requestedSequence} 早于最早可用 ${earliestAvailableSequence}`,
 );
 this.name = "EventCursorExpiredError";
 }
}

/**
 * Event sequence 出现空洞：消费流时检测到 sequence 不连续。
 *
 * 事实源：§14 规则 4、§8 错误码表 EVENT_SEQUENCE_GAP。
 * 映射 409 EVENT_SEQUENCE_GAP，停止该流并等待，不猜测丢失事件。
 */
export class EventSequenceGapError extends Error {
 constructor(
 public readonly streamId: string,
 public readonly expectedSequence: number,
 public readonly actualSequence: number,
 ) {
 super(
 `Event sequence 空洞：stream ${streamId} 期望 ${expectedSequence}，实际 ${actualSequence}`,
 );
 this.name = "EventSequenceGapError";
 }
}

/**
 * 投影失败：Schema 不支持、payload hash 冲突或投影约束失败。
 *
 * 事实源：§14 规则 5。
 * 写入 event_delivery_failure 表，按指数退避重试，超限进入 quarantined。
 */
export class ProjectionFailureError extends Error {
 constructor(
 public readonly consumerName: string,
 public readonly eventId: string,
 public readonly failureClass: string,
 public readonly cause?: unknown,
 ) {
 super(
 `投影失败：consumer=${consumerName} event=${eventId} class=${failureClass}${cause instanceof Error ? ` cause=${cause.message}` : ""}`,
 );
 this.name = "ProjectionFailureError";
 }
}

/**
 * PendingInput 不存在或跨租户不可见。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md 、
 * ../v11-agentkit-platform/11-api-and-event-boundaries.md -3.10。
 * 映射 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。
 */
export class PendingInputNotFoundError extends Error {
 constructor(public readonly pendingInputId: string) {
 super(`PendingInput 不存在或不可见：${pendingInputId}`);
 this.name = "PendingInputNotFoundError";
 }
}

/**
 * PendingInput 非 pending 状态（admitted/removed），不可编辑/删除/重排。
 *
 * 事实源：行 339（admitted 输入不可编辑/删除）。
 * 映射 409 BUSINESS_CONSTRAINT_VIOLATION。
 */
export class PendingInputNotPendingError extends Error {
 constructor(
 public readonly pendingInputId: string,
 public readonly currentState: PendingInputState,
 public readonly attemptedAction: string,
 ) {
 super(`PendingInput ${pendingInputId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
 this.name = "PendingInputNotPendingError";
 }
}

/**
 * PendingInput 重排冲突：ordered_ids 集合与当前 pending 集合不一致
 * （不完整或包含非 pending id）。
 *
 * 事实源：、../v11-agentkit-platform/11-api-and-event-boundaries.md 。
 * 映射 409 BUSINESS_CONSTRAINT_VIOLATION。
 */
export class PendingInputReorderConflictError extends Error {
 constructor(
 public readonly threadId: string,
 public readonly reason: "incomplete" | "extra",
 public readonly expectedIds: string[],
 public readonly actualIds: string[],
 ) {
 super(
 `Thread ${threadId} 重排冲突：${reason}（期望 ${expectedIds.length} 个，实际 ${actualIds.length} 个）`,
 );
 this.name = "PendingInputReorderConflictError";
 }
}

/**
 * PendingInput 资源乐观锁冲突（资源 ETag 不匹配）。
 *
 * 事实源：（If-Match 头）、（412 ETAG_MISMATCH）。
 * 映射 412 ETAG_MISMATCH。
 */
export class PendingInputVersionConflictError extends Error {
 constructor(
 public readonly pendingInputId: string,
 public readonly expected: number,
 public readonly actual: number,
 ) {
 super(`PendingInput ${pendingInputId} 版本冲突：期望 ${expected}，实际 ${actual}`);
 this.name = "PendingInputVersionConflictError";
 }
}

/**
 * Steer 调用于 waiting_user Turn（必须解析对应 UserActionRequest）。
 *
 * 事实源：../v11-agentkit-platform/02-agent-thread-and-runtime.md 行 366
 * "waiting_user 必须解析对应 UserActionRequest，不能用 Steer 绕过"。
 * 映射 409 TURN_REQUIRES_USER_ACTION。
 */
export class TurnRequiresUserActionError extends Error {
 constructor(
 public readonly turnId: string,
 public readonly currentState: TurnState,
 ) {
 super(`Turn ${turnId} 状态为 ${currentState}，需解析对应 UserActionRequest，不能用 Steer 绕过`);
 this.name = "TurnRequiresUserActionError";
 }
}

/**
 * Fork 源 Turn 不属于源 Thread（from_turn_id 不属于 parent_thread_id）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md （ThreadRelation.source_turn_id）。
 * 映射 409 BUSINESS_CONSTRAINT_VIOLATION。
 */
export class ForkSourceTurnMismatchError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly sourceTurnId: string,
 ) {
 super(`Turn ${sourceTurnId} 不属于源 Thread ${parentThreadId}`);
 this.name = "ForkSourceTurnMismatchError";
 }
}

// ─── S09-C01 Child Thread / Delegate 错误 ──────────────────

/**
 * 父 Invocation 非 running 状态不能委派（05 文档 §9 行 380-385）。
 *
 * 只有 running 状态的父 Invocation 可以创建 delegate Child Thread；
 * queued/waiting_user/终态 Invocation 都不允许委派。
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class ParentInvocationNotActiveError extends Error {
 constructor(
 public readonly parentInvocationId: string,
 public readonly currentState: string,
 ) {
 super(
 `父 Invocation ${parentInvocationId} 状态为 ${currentState}，不允许 delegate（仅 running 可委派）`,
 );
 this.name = "ParentInvocationNotActiveError";
 }
}

/**
 * delegationPolicyJson 不允许向该 target_agent_id 委派（05 文档 §9 行 386-389）。
 *
 * delegationPolicyJson.allowedTargets 未包含目标 agentId；或 delegationPolicyJson.maxDepth
 * 限制下当前深度不能再委派（与 DelegationDepthExceededError 区分：本错误针对 allowedTargets）。
 * 映射 403 DELEGATION_NOT_ALLOWED。
 */
export class DelegationNotAllowedError extends Error {
 constructor(
 public readonly parentAgentId: string,
 public readonly targetAgentId: string,
 ) {
 super(`Agent ${parentAgentId} 的 delegationPolicy 不允许向 Agent ${targetAgentId} 委派`);
 this.name = "DelegationNotAllowedError";
 }
}

/**
 * 委派深度超限（05 文档 §9 行 386-389；12 文档 §4 行 280-285）。
 *
 * 当前委派链深度 + 1 超过 delegationPolicyJson.maxDepth；root parent 的 maxDepth
 * 整条链共享，子链继承约束。
 * 映射 409 DELEGATION_DEPTH_EXCEEDED。
 */
export class DelegationDepthExceededError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly currentDepth: number,
 public readonly maxDepth: number,
 ) {
 super(`委派深度超限：parent=${parentThreadId} 当前深度=${currentDepth}，最大允许=${maxDepth}`);
 this.name = "DelegationDepthExceededError";
 }
}

/**
 * 子 Thread 预算超限（05 文档 §9 行 398-402；§16 行 590-595）。
 *
 * budgetPolicyJson 定义 token / wall_clock / cost 上限；创建时校验已超限或为负值。
 * 注意：本错误用于「创建时即拒绝」，运行时预算耗尽由 Runtime 发出 cancel 命令处理。
 * 映射 409 CHILD_BUDGET_EXCEEDED。
 */
export class ChildBudgetExceededError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly budgetPolicy: Record<string, unknown>,
 public readonly reason: string,
 ) {
 super(
 `Child Thread 预算策略校验失败：parent=${parentThreadId} reason=${reason} budget=${JSON.stringify(budgetPolicy)}`,
 );
 this.name = "ChildBudgetExceededError";
 }
}

/**
 * contextTransferPolicyJson 拒绝转移某些 Item（05 文档 §9 行 390-397；§16 行 580-585）。
 *
 * 必拒集合：Credential、隐藏思维链、未授权本地路径。
 * 必转集合：user_message、artifacts（policy=include）。
 * 应用服务尝试显式列入必拒集合时抛本错误。
 * 映射 409 CHILD_CONTEXT_NOT_ALLOWED。
 */
export class ChildContextNotAllowedError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly deniedItemIds: string[],
 public readonly reason: string,
 ) {
 super(
 `Child Thread 上下文转移策略拒绝：parent=${parentThreadId} reason=${reason} itemIds=${deniedItemIds.join(",")}`,
 );
 this.name = "ChildContextNotAllowedError";
 }
}

/**
 * 子 Thread 已处于终态（completed/failed/cancelled），不能再取消（05 文档 §9 行 412-417）。
 *
 * 取消请求仅对 active/cancel_requested 状态的 relation 有效；
 * 终态 relation_state 不可恢复。
 * 映射 409 CHILD_THREAD_ALREADY_TERMINAL。
 */
export class ChildThreadAlreadyTerminalError extends Error {
 constructor(
 public readonly relationId: string,
 public readonly childThreadId: string,
 public readonly relationState: string,
 ) {
 super(
 `Child Thread 关系 ${relationId}（child=${childThreadId}）已处于终态 ${relationState}，不能取消`,
 );
 this.name = "ChildThreadAlreadyTerminalError";
 }
}

// ─── S09-C02 Child Thread 结果投影、取消终态与预算 ──────────

/**
 * Child Thread 结果投影失败（05 文档 §9 行 412-417；12 文档 行 263）。
 *
 * 触发场景：
 * - relation 不存在或跨租户不可见
 * - relation 状态非终态（active/cancel_requested 才允许投影；creating 拒绝）
 * - 子 Thread 无可读取的最终 Item（agent_message / job_result）
 * - relation.itemId 为空（delegateChildThread 未回填 ChildThread Item）
 * - relation 已 completed（幂等重放除外）
 * 映射 409 CHILD_THREAD_RESULT_PROJECTION_FAILED。
 */
export class ChildThreadResultProjectionError extends Error {
 constructor(
 public readonly relationId: string,
 public readonly reason: string,
 ) {
 super(`Child Thread 结果投影失败：relation=${relationId} reason=${reason}`);
 this.name = "ChildThreadResultProjectionError";
 }
}

/**
 * finalizeChildThreadCancellation 失败（05 文档 §16 行 322-333；12 文档 行 294）。
 *
 * 触发场景：
 * - relation 不在 cancel_requested（active 也允许，应对 race；其他状态拒绝）
 * - 子 Invocation 未进入终态（running/waiting_user 不能直接 finalize）
 * - 存在 unknown_effect 但调用方未显式确认（默认拒绝伪造无副作用取消）
 * 映射 409 CHILD_THREAD_CANCELLATION_FINALIZE_FAILED。
 */
export class ChildThreadCancellationFinalizeError extends Error {
 constructor(
 public readonly relationId: string,
 public readonly reason: string,
 ) {
 super(`Child Thread 取消终态落库失败：relation=${relationId} reason=${reason}`);
 this.name = "ChildThreadCancellationFinalizeError";
 }
}

/**
 * 子 Thread 运行时预算耗尽（05 文档 §16 行 590-595；§18 行 352-362）。
 *
 * 与 ChildBudgetExceededError 区分：
 * - ChildBudgetExceededError 用于「创建时即拒绝」（budgetPolicyJson 负值或非法）
 * - ChildThreadBudgetExhaustedError 用于「运行时累积用量超过上限」
 *
 * 触发场景：
 * - recordChildThreadBudgetUsage 累积后超过 budgetPolicyJson 上限
 * - assertChildThreadBudgetNotExhausted 校验失败
 * 映射 409 CHILD_BUDGET_EXHAUSTED。
 */
export class ChildThreadBudgetExhaustedError extends Error {
 constructor(
 public readonly relationId: string,
 public readonly budgetPolicy: Record<string, unknown>,
 public readonly budgetUsed: Record<string, unknown>,
 public readonly exceededField:
 | "tokens"
 | "cost"
 | "tool_calls"
 | "wall_clock_ms"
 | "child_count"
 | "sandbox_seconds"
 | "artifact_bytes",
 ) {
 super(
 `Child Thread 预算耗尽：relation=${relationId} field=${exceededField} policy=${JSON.stringify(budgetPolicy)} used=${JSON.stringify(budgetUsed)}`,
 );
 this.name = "ChildThreadBudgetExhaustedError";
 }
}

/**
 * 子 Invocation 未终态时尝试投影结果或落库取消（05 文档 §9 行 412-417）。
 *
 * Invocation 必须进入终态（completed/failed/cancelled/lost）后才能触发结果投影
 * 或 finalizeChildThreadCancellation；running/waiting_user 状态不允许。
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class ChildInvocationNotTerminalError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: string,
 ) {
 super(
 `子 Invocation ${invocationId} 状态为 ${currentState}，未进入终态，不能投影结果或落库取消`,
 );
 this.name = "ChildInvocationNotTerminalError";
 }
}

// ─── S09-C03 Handoff 错误 ──────────────────────────────────

/**
 * Handoff 参数校验失败（12 文档 §5 行 296-305）。
 *
 * 触发场景：
 * - 目标 Agent 与当前主 Agent 相同（无需 handoff）
 * - 目标 Agent 不存在、跨租户不可见或 lifecycleState != enabled
 * - 当前 Thread.lifecycleState != active（archived/deleted 不允许 handoff）
 * - 当前 Invocation 非 running 状态（不能转入 waiting_user）
 * - UserActionRequest.purpose != handoff（非 handoff 请求走通用 resolve 路径）
 * - resolution 非 approve/deny（confirmation 类型仅接受这两种）
 * 映射 409 HANDOFF_VALIDATION_FAILED。
 */
export class HandoffValidationError extends Error {
 constructor(
 public readonly reason: string,
 public readonly code?:
 | "SAME_AGENT"
 | "AGENT_NOT_AVAILABLE"
 | "THREAD_NOT_ACTIVE"
 | "INVOCATION_NOT_RUNNING"
 | "PURPOSE_MISMATCH"
 | "RESOLUTION_NOT_ALLOWED",
 ) {
 super(`Handoff 校验失败：${reason}`);
 this.name = "HandoffValidationError";
 }
}

/**
 * Handoff 请求已解析或过期（重复 resolve / resolve 已 expired 的请求）。
 *
 * 复用 UserActionAlreadyResolvedError 语义；本错误专用于 Handoff 上下文。
 * 映射 409 USER_ACTION_ALREADY_RESOLVED。
 */
export class HandoffAlreadyResolvedError extends Error {
 public readonly currentState: string;
 public readonly requestId: string;

 constructor(requestId: string, currentState: string) {
 super(`Handoff 请求 ${requestId} 已解析或过期（currentState=${currentState}）`);
 this.name = "HandoffAlreadyResolvedError";
 this.currentState = currentState;
 this.requestId = requestId;
 }
}

/**
 * Handoff 乐观锁冲突（Thread.versionNo 不匹配）。
 *
 * approve 路径需要 SELECT FOR UPDATE Thread 后校验 versionNo；
 * 并发场景下另一事务已修改 Thread 行（如 settings 更新或另一个 handoff）。
 * 映射 412 ETAG_MISMATCH。
 */
export class HandoffVersionConflictError extends Error {
 constructor(
 public readonly threadId: string,
 public readonly expected: number,
 public readonly actual: number,
 ) {
 super(`Handoff ${threadId} 版本冲突：期望 ${expected}，实际 ${actual}`);
 this.name = "HandoffVersionConflictError";
 }
}

// ─── S09-C07 并发 Workspace 与共享预算错误 ──────────────────

/**
 * Desktop 同路径写锁冲突（05 文档 §13 行 268 禁止后完成者覆盖）。
 *
 * 触发场景：
 * - 两个 Invocation 同时尝试获取同一 WorkspaceBinding + 同一路径指纹的写锁。
 * - 第一个持锁，第二个抛此错误（而非静默覆盖或等待）。
 * - 持锁 Invocation lost 后被强制 revoke，下次 acquire 可成功。
 *
 * 映射 409 WORKSPACE_WRITE_LOCK_CONFLICT。
 */
export class WorkspaceWriteLockConflictError extends Error {
 constructor(
 public readonly workspaceBindingId: string,
 public readonly pathFingerprint: string,
 public readonly holderInvocationId: string,
 ) {
 super(
 `Workspace 写锁冲突：binding=${workspaceBindingId} path=${pathFingerprint} 已被 Invocation ${holderInvocationId} 持有`,
 );
 this.name = "WorkspaceWriteLockConflictError";
 }
}

/**
 * Workspace 写锁不存在或跨租户不可见。
 *
 * 映射 404 RESOURCE_NOT_FOUND（不泄露存在）。
 */
export class WorkspaceWriteLockNotFoundError extends Error {
 constructor(public readonly lockId: string) {
 super(`Workspace 写锁不存在或不可见：${lockId}`);
 this.name = "WorkspaceWriteLockNotFoundError";
 }
}

/**
 * 写锁状态不允许当前操作（如已 released/expired/revoked 时尝试 release）。
 *
 * 映射 409 WORKSPACE_WRITE_LOCK_STATE_CONFLICT。
 */
export class WorkspaceWriteLockStateError extends Error {
 constructor(
 public readonly lockId: string,
 public readonly currentState: string,
 public readonly expectedState: string,
 ) {
 super(`Workspace 写锁 ${lockId} 状态为 ${currentState}，期望 ${expectedState}，不允许当前操作`);
 this.name = "WorkspaceWriteLockStateError";
 }
}

/**
 * Workspace Overlay 合并冲突已报告，等待父 Agent 决策（05 文档 §13 行 268）。
 *
 * 触发场景：
 * - 子 Overlay 修改与父 WorkspaceBinding 同期修改冲突。
 * - 报告冲突后 Overlay 进入 conflict 状态，禁止后完成者覆盖。
 * - 父 Agent 必须显式 resolve（手动合并）或 abandon（放弃 Overlay）。
 *
 * 映射 409 WORKSPACE_OVERLAY_MERGE_CONFLICT。
 */
export class WorkspaceOverlayMergeConflictError extends Error {
 constructor(
 public readonly overlayId: string,
 public readonly conflictIds: string[],
 ) {
 super(
 `Workspace Overlay ${overlayId} 合并冲突：conflicts=${conflictIds.join(",")} 已报告，等待父 Agent 决策`,
 );
 this.name = "WorkspaceOverlayMergeConflictError";
 }
}

/**
 * Workspace Overlay 不存在或跨租户不可见。
 *
 * 映射 404 RESOURCE_NOT_FOUND（不泄露存在）。
 */
export class WorkspaceOverlayNotFoundError extends Error {
 constructor(public readonly overlayId: string) {
 super(`Workspace Overlay 不存在或不可见：${overlayId}`);
 this.name = "WorkspaceOverlayNotFoundError";
 }
}

/**
 * Workspace Overlay 状态不允许当前操作（如 active 状态尝试 merge 时已 conflict）。
 *
 * 映射 409 WORKSPACE_OVERLAY_STATE_CONFLICT。
 */
export class WorkspaceOverlayStateError extends Error {
 constructor(
 public readonly overlayId: string,
 public readonly currentState: string,
 public readonly expectedState: string,
 ) {
 super(
 `Workspace Overlay ${overlayId} 状态为 ${currentState}，期望 ${expectedState}，不允许当前操作`,
 );
 this.name = "WorkspaceOverlayStateError";
 }
}

/**
 * 跨 sibling 共享父任务总预算已耗尽（05 文档 §18 行 352-362）。
 *
 * 触发场景：
 * - 父 Thread 有多个 active delegate ThreadRelation，所有 sibling 共享父任务总预算上限。
 * - sibling A 用了 80% + sibling B 再用 30% → 第二次记录触发本错误（不是单个 relation 超限，是聚合超限）。
 * - 硬上限触发后阻止新行动；正在执行副作用的 ToolCall 先进入 unknown_effect 核对流程，
 * 不能粗暴杀死后当成失败重试（§18 行 358-360）。
 *
 * 映射 422 SHARED_BUDGET_EXHAUSTED。
 */
export class SharedBudgetExhaustedError extends Error {
 constructor(
 public readonly parentThreadId: string,
 public readonly exceededField:
 | "tokens"
 | "cost"
 | "tool_calls"
 | "wall_clock_ms"
 | "child_count"
 | "sandbox_seconds"
 | "artifact_bytes",
 public readonly totalUsed: number,
 public readonly maxLimit: number,
 public readonly contributingRelations: string[],
 ) {
 super(
 `共享父任务总预算耗尽：parent=${parentThreadId} field=${exceededField} used=${totalUsed} > max=${maxLimit} contributors=${contributingRelations.join(",")}`,
 );
 this.name = "SharedBudgetExhaustedError";
 }
}
