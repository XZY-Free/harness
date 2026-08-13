/**
 * Runtime 域共享错误类（S05-C01）。
 *
 * 事实源：docs/architecture/persistence.md -、、
 * docs/architecture/api-and-events.md 。
 *
 * Route 层根据 error 实例映射 HTTP 状态码和稳定 error_code。
 */
import type {
 ExecutionOwnershipState,
 InvocationAttemptState,
 InvocationExecutionState,
} from "@/lib/persistence/schema/runtime";

/** Invocation 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。 */
export class InvocationNotFoundError extends Error {
 constructor(public readonly invocationId: string) {
 super(`Invocation 不存在或不可见：${invocationId}`);
 this.name = "InvocationNotFoundError";
 }
}

/** Invocation 状态转换非法。映射 409 INVOCATION_STATE_CONFLICT。 */
export class InvocationStateConflictError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: InvocationExecutionState | "queued",
 public readonly attemptedAction: string,
 ) {
 super(`Invocation ${invocationId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
 this.name = "InvocationStateConflictError";
 }
}

/** ExecutionBinding 已存在（同一 Invocation 只能有一条不可变绑定）。映射 409 BINDING_ALREADY_EXISTS。 */
export class ExecutionBindingAlreadyExistsError extends Error {
 constructor(public readonly invocationId: string) {
 super(`Invocation ${invocationId} 已存在 ExecutionBinding（不可变，1:1）`);
 this.name = "ExecutionBindingAlreadyExistsError";
 }
}

/** ExecutionBinding 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND。 */
export class ExecutionBindingNotFoundError extends Error {
 constructor(public readonly invocationId: string) {
 super(`ExecutionBinding 不存在或不可见：${invocationId}`);
 this.name = "ExecutionBindingNotFoundError";
 }
}

/** InvocationAttempt 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND。 */
export class InvocationAttemptNotFoundError extends Error {
 constructor(public readonly attemptId: string) {
 super(`InvocationAttempt 不存在或不可见：${attemptId}`);
 this.name = "InvocationAttemptNotFoundError";
 }
}

/** InvocationAttempt 状态转换非法。映射 409 ATTEMPT_STATE_CONFLICT。 */
export class InvocationAttemptStateConflictError extends Error {
 constructor(
 public readonly attemptId: string,
 public readonly currentState: InvocationAttemptState,
 public readonly attemptedAction: string,
 ) {
 super(`InvocationAttempt ${attemptId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
 this.name = "InvocationAttemptStateConflictError";
 }
}

/** ExecutionOwnership 状态转换非法。映射 409 OWNERSHIP_STATE_CONFLICT。 */
export class ExecutionOwnershipStateConflictError extends Error {
 constructor(
 public readonly ownershipId: string,
 public readonly currentState: ExecutionOwnershipState,
 public readonly attemptedAction: string,
 ) {
 super(`ExecutionOwnership ${ownershipId} 状态为 ${currentState}，不允许 ${attemptedAction}`);
 this.name = "ExecutionOwnershipStateConflictError";
 }
}

/**
 * 调度失败：Turn 不在 accepted 状态（无法调度）。
 *
 * 事实源：docs/architecture/agent-control-plane.md §7（Turn 接纳周期）。
 * 映射 409 TURN_STATE_CONFLICT。
 */
export class DispatchTurnStateError extends Error {
 constructor(
 public readonly turnId: string,
 public readonly currentState: string,
 ) {
 super(`Turn ${turnId} 状态为 ${currentState}，无法调度（仅 accepted 可调度）`);
 this.name = "DispatchTurnStateError";
 }
}

/**
 * 调度失败：Thread 没有有效的 DeploymentRoute（无路由可调度）。
 *
 * 事实源：Turn 保持 accepted 等待 Runtime 接入。
 * 此错误仅在显式调度（dispatchInvocationForTurn）但 Route 缺失时抛出。
 * 映射 409 NO_EFFECTIVE_ROUTE。
 */
export class NoEffectiveRouteError extends Error {
 constructor(
 public readonly tenantId: string,
 public readonly agentId: string,
 ) {
 super(`Agent ${agentId} 在租户 ${tenantId} 内无有效 DeploymentRoute`);
 this.name = "NoEffectiveRouteError";
 }
}

// ─── RuntimeSessionBinding 错误（S05-C02） ────────────────

/** RuntimeSessionBinding 不存在或跨租户不可见。映射 404 RESOURCE_NOT_FOUND。 */
export class RuntimeSessionBindingNotFoundError extends Error {
 constructor(public readonly bindingId: string) {
 super(`RuntimeSessionBinding 不存在或不可见：${bindingId}`);
 this.name = "RuntimeSessionBindingNotFoundError";
 }
}

/**
 * RuntimeSessionBinding UNIQUE 冲突。
 *
 * 同 runtimeRevisionId+externalSessionRef 已存在（Runtime 重发同 session_ref）。
 * 映射 409 BUSINESS_CONSTRAINT_VIOLATION；调用方应复用现有 binding。
 */
export class RuntimeSessionBindingConflictError extends Error {
 constructor(
 public readonly runtimeRevisionId: string,
 public readonly externalSessionRef: string,
 ) {
 super(
 `RuntimeSessionBinding 冲突：runtimeRevisionId=${runtimeRevisionId}, externalSessionRef=${externalSessionRef} 已存在`,
 );
 this.name = "RuntimeSessionBindingConflictError";
 }
}

// ─── Runtime HTTP 客户端错误（S05-C02） ───────────────────

/**
 * Runtime HTTP 调用错误。
 *
 * 包含三类：
 * - network：网络不可达 / DNS 失败 / TLS 错误（重试可用）。
 * - http：Runtime 返回非 2xx 状态码（按错误码映射）。
 * - protocol：响应体结构非法（不可重试）。
 */
export class RuntimeHttpClientError extends Error {
 constructor(
 public readonly kind: "network" | "http" | "protocol",
 message: string,
 /** HTTP 状态码（kind=http 时必填）。 */
 public readonly httpStatus?: number,
 /** Runtime 稳定错误码（kind=http 时填，如 IDEMPOTENCY_CONFLICT / RUNTIME_UNAVAILABLE）。 */
 public readonly runtimeErrorCode?: string,
 ) {
 super(message);
 this.name = "RuntimeHttpClientError";
 }
}

// ─── RuntimeEventIngress 错误（S05-C03） ──────────────────

/**
 * 候选事件 payload hash 冲突：相同 producerEventId/producerSequence 但 payloadHash 不同。
 *
 * 事实源：docs/architecture/persistence.md 、§14 规则 4。
 * 不可修复错误，原子终止 Invocation；映射 409 IDEMPOTENCY_CONFLICT。
 */
export class EventPayloadHashConflictError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly producerEventId: string,
 public readonly producerSequence: number,
 public readonly expectedHash: string,
 public readonly actualHash: string,
 ) {
 super(
 `Invocation ${invocationId} 事件 hash 冲突：producerEventId=${producerEventId} producerSequence=${producerSequence} 期望 ${expectedHash} 实际 ${actualHash}`,
 );
 this.name = "EventPayloadHashConflictError";
 }
}

/**
 * Ingress 目标 Invocation 不存在或跨租户不可见。
 *
 * 事实源：docs/architecture/persistence.md 。
 * 映射 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。
 */
export class IngressInvocationNotFoundError extends Error {
 constructor(public readonly invocationId: string) {
 super(`Ingress 目标 Invocation 不存在或不可见：${invocationId}`);
 this.name = "IngressInvocationNotFoundError";
 }
}

/**
 * Ingress 目标 Invocation 已终态，不接受新事件。
 *
 * 事实源：docs/architecture/agent-control-plane.md §6（Invocation 生命周期）、
 * L486-500（终态后不接受新候选事件）。
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class IngressInvocationTerminalError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: string,
 ) {
 super(`Invocation ${invocationId} 已终态（${currentState}），不接受新候选事件`);
 this.name = "IngressInvocationTerminalError";
 }
}

// ─── 命令调度错误（S05-C04） ───────────────────────────────

/**
 * InvocationCommand 不存在或跨租户不可见。
 *
 * 事实源：docs/architecture/persistence.md （InvocationCommand 表）、
 * docs/architecture/agent-control-plane.md -3.10。
 * 映射 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。
 */
export class CommandNotFoundError extends Error {
 constructor(public readonly commandId: string) {
 super(`InvocationCommand 不存在或不可见：${commandId}`);
 this.name = "CommandNotFoundError";
 }
}

/**
 * InvocationCommand 已被调度（commandState 非 queued），不可重复调度。
 *
 * 事实源：行 504、-3.10。
 * commandState 转换不可逆：queued → dispatched → acknowledged/failed。
 * 映射 409 BUSINESS_CONSTRAINT_VIOLATION。
 */
export class CommandAlreadyDispatchedError extends Error {
 constructor(
 public readonly commandId: string,
 public readonly currentCommandState: string,
 ) {
 super(`InvocationCommand ${commandId} 状态为 ${currentCommandState}，已调度不可重复调度`);
 this.name = "CommandAlreadyDispatchedError";
 }
}

/**
 * InvocationCommand 关联的 Invocation 不存在或跨租户不可见。
 *
 * 事实源：（invocationId 可空，queued 后由调度器绑定）。
 * 映射 404 RESOURCE_NOT_FOUND（隐藏式，不泄露存在）。
 */
export class CommandInvocationNotFoundError extends Error {
 constructor(public readonly invocationId: string) {
 super(`InvocationCommand 关联的 Invocation 不存在或不可见：${invocationId}`);
 this.name = "CommandInvocationNotFoundError";
 }
}

/**
 * Resume 命令调度的 Invocation 不在 waiting_user 状态。
 *
 * 事实源：docs/architecture/agent-control-plane.md （Resume）、§6（生命周期）。
 * Resume 只能作用于 waiting_user Invocation；其他状态 → 状态冲突。
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class ResumeInvocationNotWaitingError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: string,
 ) {
 super(`Invocation ${invocationId} 状态为 ${currentState}，Resume 仅可作用于 waiting_user 状态`);
 this.name = "ResumeInvocationNotWaitingError";
 }
}

// ─── 恢复与重调度错误（S09-C06） ───────────────────────────

/**
 * Invocation 已终态，不能标记 lost 或重调度。
 *
 * 事实源：docs/architecture/persistence.md （终态不可恢复）、§13（Worker 失联恢复）。
 * 已 completed/failed/cancelled/lost 的 Invocation 不能再标记 lost 或创建新 Attempt。
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class InvocationAlreadyTerminalError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: InvocationExecutionState,
 public readonly attemptedAction: string,
 ) {
 super(`Invocation ${invocationId} 已终态（${currentState}），不允许 ${attemptedAction}`);
 this.name = "InvocationAlreadyTerminalError";
 }
}

/**
 * 重调度不允许：Invocation 状态不在允许重调度的集合内。
 *
 * 事实源：docs/architecture/persistence.md §13（Worker 失联恢复：仅 running/waiting_user/queued
 * 的非终态 Invocation 可重调度）；（lost 为终态不可恢复）。
 *
 * 允许重调度的状态：queued / running / waiting_user（心跳超时但未标记 lost）。
 * 不允许重调度的状态：completed / failed / cancelled / lost（终态）。
 *
 * 映射 409 INVOCATION_STATE_CONFLICT。
 */
export class RedispatchNotAllowedError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly currentState: InvocationExecutionState,
 ) {
 super(
 `Invocation ${invocationId} 状态为 ${currentState}，不允许重调度（仅 queued/running/waiting_user 可重调度）`,
 );
 this.name = "RedispatchNotAllowedError";
 }
}
