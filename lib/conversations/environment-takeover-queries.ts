import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import { type ThreadEventActorType, threadTable } from "@/lib/persistence/schema/conversation";
/**
 * 多设备 ownership 与接管（S10-W07）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md
 * S10-W07：
 * 「页面显示当前 Environment owner、在线状态、租约和接管条件」
 * 「Web 发起的本地任务在指定 Desktop 离线时进入等待，不静默迁移到 Cloud」
 * 「接管前核对未完成 ToolCall/Effect；重复连接不能并发执行同一需要写锁的本地操作」
 *
 * 职责：
 * - getTakeoverConditions：聚合查询当前 active Invocation 的接管前置条件
 * （未完成 ToolCall 数量 / unknown_effect 数量 / 活跃写锁数量 / owner 心跳是否陈旧）。
 * - performTakeover：事务内执行接管——SELECT FOR UPDATE ownership → 校验仍 active →
 * markLost ownership + revoke 写锁 + markLost Lease + 写 environment.takeover_executed Event。
 * - isDeviceHeartbeatStale：纯函数判断 device.lastActiveAt 是否超过心跳阈值。
 *
 * 接管规则（can_takeover）：
 * - 必须存在 active ownership（否则无需接管）。
 * - 不能有 unknown_effect（必须先 reconcile 核对）。
 * - 不能有活跃写锁（必须先释放或由系统 revoke）。
 * - 不能有未完成 ToolCall（proposed/paused/running；必须等终态或取消）。
 * - owner 心跳必须陈旧（超过阈值）；owner 在线时不允许接管。
 *
 * 不变量：
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 事务原子：performTakeover 全部在单个事务内完成。
 * - 不静默迁移：接管只释放旧 owner 的资源，不创建新 Lease/Ownership；
 * 新 Invocation 创建时由调度器 acquireExecutionOwnership 获取新 epoch。
 */
import { type EnvironmentLease, environmentLeaseTable } from "@/lib/persistence/schema/environment";
import {
 type ExecutionOwnership,
 type ExecutionOwnershipState,
 executionOwnershipTable,
} from "@/lib/persistence/schema/runtime";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import type { ToolCallState } from "@/lib/persistence/schema/tool-call";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { listEffectRecordsByInvocation } from "@/lib/capability/effect-queries";
import { listToolCallsByInvocation } from "@/lib/capability/tool-call-queries";
import { getActiveLocksByInvocation } from "@/lib/workspace/workspace-write-lock-queries";
import { and, eq } from "drizzle-orm";

// ─── 常量 ──────────────────────────────────────────────────

/**
 * Desktop 设备心跳超时阈值（毫秒）。
 *
 * 与 lib/desktop-bridge/bridge-server.ts heartbeatTimeoutMs=90000 对齐。
 * device.lastActiveAt 或 ownership.lastHeartbeatAt 超过此阈值视为离线。
 */
export const DEVICE_HEARTBEAT_TIMEOUT_MS = 90_000 as const;

/** 接管前不允许存在的 ToolCall 状态。 */
const TAKEOVER_BLOCKING_TOOL_CALL_STATES: readonly ToolCallState[] = [
 "proposed",
 "paused",
 "running",
];

// ─── 错误类型 ──────────────────────────────────────────────

/** 接管前置条件不满足（存在未完成 ToolCall/Effect 或写锁，或 owner 仍在线）。 */
export class TakeoverConditionsNotMetError extends Error {
 public readonly conditions: TakeoverConditions;

 constructor(conditions: TakeoverConditions) {
 super(`接管条件不满足：${conditions.blocking_reasons.join("；") || "未知原因"}`);
 this.name = "TakeoverConditionsNotMetError";
 this.conditions = conditions;
 }
}

/** 当前无活跃 ownership，无需接管。 */
export class NoActiveOwnershipError extends Error {
 public readonly threadId: string;

 constructor(threadId: string) {
 super(`Thread ${threadId} 当前无活跃 ExecutionOwnership，无需接管`);
 this.name = "NoActiveOwnershipError";
 this.threadId = threadId;
 }
}

// ─── 纯函数 ────────────────────────────────────────────────

/**
 * 判断 device 心跳是否陈旧（超过阈值视为离线）。
 *
 * @param device Device 行（含 lastActiveAt）
 * @param now 当前时间（默认 new Date()）
 * @returns true 表示心跳陈旧（设备可能离线）；device 为 null 或 lastActiveAt 为 null 时返回 true
 */
export function isDeviceHeartbeatStale(
 device: { lastActiveAt: Date | null } | null,
 now: Date = new Date(),
): boolean {
 if (!device || !device.lastActiveAt) return true;
 return now.getTime() - device.lastActiveAt.getTime() > DEVICE_HEARTBEAT_TIMEOUT_MS;
}

// ─── 查询入参/出参 ─────────────────────────────────────────

/** 查询接管条件入参。 */
export interface GetTakeoverConditionsInput {
 readonly tenantId: string;
 readonly threadId: string;
 /** 当前 active Invocation id；null 表示无活跃 Invocation（返回空条件）。 */
 readonly activeInvocationId: string | null;
 /** 当前 active ExecutionOwnership；null 表示无活跃 ownership。 */
 readonly activeOwnership: ExecutionOwnership | null;
 /** 当前 Desktop Lease（如有）；用于回退判断 owner 设备心跳。 */
 readonly activeLease: EnvironmentLease | null;
}

/** 接管条件聚合视图。 */
export interface TakeoverConditions {
 /** 是否允许接管。 */
 readonly can_takeover: boolean;
 /** 阻塞原因列表（中文，前端直接展示）。 */
 readonly blocking_reasons: readonly string[];
 /** 未完成 ToolCall 数量（proposed/paused/running）。 */
 readonly pending_tool_calls: number;
 /** unknown_effect 状态的 EffectRecord 数量。 */
 readonly unknown_effects: number;
 /** 该 Invocation 持有的活跃写锁数量。 */
 readonly active_write_locks: number;
 /** owner 心跳是否陈旧（超过阈值）。 */
 readonly owner_heartbeat_stale: boolean;
 /** 当前 owner 设备 id（如有）。 */
 readonly owner_device_id: string | null;
 /** 当前 ownership id（如有）。 */
 readonly ownership_id: string | null;
}

/** 空 conditions（无活跃 ownership 时返回）。 */
export const EMPTY_CONDITIONS: TakeoverConditions = {
 can_takeover: false,
 blocking_reasons: [],
 pending_tool_calls: 0,
 unknown_effects: 0,
 active_write_locks: 0,
 owner_heartbeat_stale: false,
 owner_device_id: null,
 ownership_id: null,
};

// ─── 查询实现 ──────────────────────────────────────────────

/**
 * 聚合查询 Thread 当前 active Invocation 的接管条件。
 *
 * 步骤：
 * 1. 无 activeInvocationId 或无 activeOwnership → 返回 EMPTY_CONDITIONS。
 * 2. 并行查询 ToolCall / EffectRecord / 活跃写锁。
 * 3. 按 ownership.lastHeartbeatAt 推导 owner 心跳是否陈旧。
 * 4. 推导 can_takeover（所有阻塞项为 0 + owner 心跳陈旧）。
 */
export async function getTakeoverConditions(
 input: GetTakeoverConditionsInput,
 options?: { readonly now?: Date },
): Promise<TakeoverConditions> {
 const { tenantId, activeInvocationId, activeOwnership, activeLease } = input;
 const now = options?.now ?? new Date();

 if (!activeInvocationId || !activeOwnership) {
 return EMPTY_CONDITIONS;
 }

 // 并行查询 ToolCall / Effect / 写锁
 const [toolCalls, effects, writeLocks] = await Promise.all([
 listToolCallsByInvocation({ tenantId, invocationId: activeInvocationId }),
 listEffectRecordsByInvocation(tenantId, activeInvocationId),
 getActiveLocksByInvocation(tenantId, activeInvocationId),
 ]);

 const pendingToolCalls = toolCalls.filter((tc) =>
 // DB 行的 callState 类型为 string，需显式断言为 ToolCallState。
 TAKEOVER_BLOCKING_TOOL_CALL_STATES.includes(tc.callState as ToolCallState),
 ).length;
 const unknownEffects = effects.filter((e) => e.effectState === "unknown_effect").length;
 const activeWriteLocks = writeLocks.length;

 // owner 心跳：优先用 ownership.lastHeartbeatAt，否则回退到 lease.deviceId 的 device.lastActiveAt
 let ownerHeartbeatStale = false;
 const ownerDeviceId = activeOwnership.deviceId ?? activeLease?.deviceId ?? null;
 if (ownerDeviceId) {
 if (activeOwnership.lastHeartbeatAt) {
 ownerHeartbeatStale =
 now.getTime() - activeOwnership.lastHeartbeatAt.getTime() > DEVICE_HEARTBEAT_TIMEOUT_MS;
 } else {
 // 无心跳记录，视为陈旧（acquiredAt 很久以前或从未心跳）
 ownerHeartbeatStale = true;
 }
 } else {
 // 无 deviceId（Cloud/Remote/Sandbox 无需接管）
 ownerHeartbeatStale = false;
 }

 const blockingReasons: string[] = [];
 if (pendingToolCalls > 0) {
 blockingReasons.push(`有 ${pendingToolCalls} 个未完成 ToolCall`);
 }
 if (unknownEffects > 0) {
 blockingReasons.push(`有 ${unknownEffects} 个 unknown_effect 待核对`);
 }
 if (activeWriteLocks > 0) {
 blockingReasons.push(`有 ${activeWriteLocks} 个活跃写锁未释放`);
 }
 if (!ownerHeartbeatStale) {
 blockingReasons.push("owner 心跳未超时，设备可能仍在线");
 }

 const canTakeover =
 pendingToolCalls === 0 && unknownEffects === 0 && activeWriteLocks === 0 && ownerHeartbeatStale;

 return {
 can_takeover: canTakeover,
 blocking_reasons: blockingReasons,
 pending_tool_calls: pendingToolCalls,
 unknown_effects: unknownEffects,
 active_write_locks: activeWriteLocks,
 owner_heartbeat_stale: ownerHeartbeatStale,
 owner_device_id: ownerDeviceId,
 ownership_id: activeOwnership.id,
 };
}

// ─── 执行接管 ──────────────────────────────────────────────

/** 执行接管入参。 */
export interface PerformTakeoverInput {
 readonly tenantId: string;
 readonly threadId: string;
 /** 当前 active Invocation id。 */
 readonly activeInvocationId: string;
 /** 当前 active ExecutionOwnership id（用于事务内校验仍 active）。 */
 readonly activeOwnershipId: string;
 /** 触发接管的员工 id（用于审计）。 */
 readonly actorUserId: string;
 /** Idempotency-Key（用于事件去重）。 */
 readonly idempotencyKey: string;
 /** 关联 Lease id（如有，同时标记 lost）。 */
 readonly activeLeaseId: string | null;
 /** 接管原因代码（如 "user_takeover" / "device_heartbeat_timeout"）。 */
 readonly reasonCode: string;
 /** 关联 id（可选）。 */
 readonly correlationId?: string;
}

/** 执行接管结果。 */
export interface PerformTakeoverResult {
 /** 被标记 lost 的 ownership id。 */
 readonly ownership_id: string;
 /** 被标记 lost 的 lease id（如有）。 */
 readonly lease_id: string | null;
 /** 被 revoke 的写锁 id 列表。 */
 readonly revoked_lock_ids: readonly string[];
 /** 写入的 environment.takeover_executed Event id。 */
 readonly event_id: string;
 /** 接管时的 ownership leaseEpoch（用于审计）。 */
 readonly previous_lease_epoch: number;
}

/**
 * 事务内执行接管。
 *
 * 步骤：
 * 1. SELECT FOR UPDATE ownership 行（防止并发接管）。
 * 2. 校验 ownership 仍 active（否则抛 NoActiveOwnershipError）。
 * 3. 校验 Invocation 属于该 Thread + 锁定 Thread 行。
 * 4. markLost ownership（active → lost）。
 * 5. 查询并 revoke 残余活跃写锁（防御性，理论上 conditions 已为 0）。
 * 6. markLost Lease（如提供 activeLeaseId）。
 * 7. allocateEventSequences(1) + insertThreadEvent("environment.takeover_executed")。
 *
 * 不变量：
 * - 不创建新 Lease/Ownership（新 Invocation 创建时由调度器 acquire）。
 * - 事务原子：任何步骤失败全部回滚。
 * - 接管 Event 写入 Thread 时间线，员工可见。
 */
export async function performTakeover(input: PerformTakeoverInput): Promise<PerformTakeoverResult> {
 return db.transaction(async (tx) => {
 // 1. SELECT FOR UPDATE ownership
 const [ownershipRow] = await tx
 .select()
 .from(executionOwnershipTable)
 .where(
 and(
 eq(executionOwnershipTable.id, input.activeOwnershipId),
 eq(executionOwnershipTable.invocationId, input.activeInvocationId),
 ),
 )
 .for("update")
 .limit(1);

 if (!ownershipRow || ownershipRow.ownershipState !== "active") {
 throw new NoActiveOwnershipError(input.threadId);
 }

 const previousLeaseEpoch = ownershipRow.leaseEpoch;

 // 2. 校验 Invocation 属于该 Thread（防跨 Thread 误用 ownership id）
 const [invocationRow] = await tx
 .select({ threadId: invocationTable.threadId })
 .from(invocationTable)
 .where(
 and(
 eq(invocationTable.tenantId, input.tenantId),
 eq(invocationTable.id, input.activeInvocationId),
 ),
 )
 .limit(1);

 if (!invocationRow?.threadId || invocationRow.threadId !== input.threadId) {
 throw new Error(
 `performTakeover: Invocation ${input.activeInvocationId} 不属于 Thread ${input.threadId}`,
 );
 }

 // 3. 锁定 Thread 行（allocateEventSequences 内部会再次 SELECT FOR UPDATE，
 // 但提前锁定可保证在此点之前 Thread 不会被并发修改）
 const [threadRow] = await tx
 .select({ id: threadTable.id })
 .from(threadTable)
 .where(and(eq(threadTable.tenantId, input.tenantId), eq(threadTable.id, input.threadId)))
 .for("update")
 .limit(1);
 if (!threadRow) {
 throw new Error(`performTakeover: Thread ${input.threadId} 不存在`);
 }

 // 4. markLost ownership（事务内直接 update）
 const lostResult = await tx
 .update(executionOwnershipTable)
 .set({ ownershipState: "lost" as ExecutionOwnershipState })
 .where(
 and(
 eq(executionOwnershipTable.id, input.activeOwnershipId),
 eq(executionOwnershipTable.ownershipState, "active"),
 ),
 );
 if (lostResult[0].affectedRows === 0) {
 throw new NoActiveOwnershipError(input.threadId);
 }

 // 5. 查询并 revoke 残余活跃写锁
 const locksToRevoke = await tx
 .select({ id: workspaceWriteLock.id })
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, input.tenantId),
 eq(workspaceWriteLock.holderInvocationId, input.activeInvocationId),
 eq(workspaceWriteLock.lockState, "acquired"),
 ),
 );
 const revokedLockIds: string[] = [];
 const now = new Date();
 for (const lock of locksToRevoke) {
 await tx
 .update(workspaceWriteLock)
 .set({
 lockState: "revoked",
 releasedAt: now,
 releaseReasonCode: "invocation_lost",
 versionNo: crypto.randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceWriteLock.id, lock.id));
 revokedLockIds.push(lock.id);
 }

 // 6. markLost Lease（如提供）
 let leaseLost = false;
 if (input.activeLeaseId) {
 const leaseResult = await tx
 .update(environmentLeaseTable)
 .set({ leaseState: "lost", updatedAt: now })
 .where(
 and(
 eq(environmentLeaseTable.tenantId, input.tenantId),
 eq(environmentLeaseTable.id, input.activeLeaseId),
 ),
 );
 leaseLost = leaseResult[0].affectedRows > 0;
 }

 // 7. 写入 environment.takeover_executed Event
 const eventSeq = await allocateEventSequences(tx, input.threadId, 1);
 const event = await insertThreadEvent(tx, input.threadId, eventSeq, {
 eventType: "environment.takeover_executed",
 invocationId: input.activeInvocationId,
 actorType: "user" as ThreadEventActorType,
 actorId: input.actorUserId,
 payload: {
 previous_ownership_id: input.activeOwnershipId,
 previous_lease_epoch: previousLeaseEpoch,
 previous_lease_id: input.activeLeaseId,
 lease_marked_lost: leaseLost,
 revoked_lock_ids: revokedLockIds,
 reason_code: input.reasonCode,
 },
 idempotencyKey: input.idempotencyKey,
 correlationId: input.correlationId,
 });

 return {
 ownership_id: input.activeOwnershipId,
 lease_id: input.activeLeaseId,
 revoked_lock_ids: revokedLockIds,
 event_id: event.id,
 previous_lease_epoch: previousLeaseEpoch,
 };
 });
}
