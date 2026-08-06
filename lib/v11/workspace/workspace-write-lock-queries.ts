/**
 * V11 Workspace 写锁仓储（S09-C07）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §13（并发 Workspace）、
 * §17（调度与资源可靠性——Workspace 写锁）
 * - ../v11-agentkit-platform/10-core-data-model.md （WorkspaceBinding 不可变）、（Event 只 INSERT）、§9（事务边界）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md 、S09-C07
 *
 * 职责：
 * - acquireWorkspaceWriteLock：Desktop 同路径写锁获取；已持锁抛 WorkspaceWriteLockConflictError（§13 禁止后完成者覆盖）。
 * - releaseWorkspaceWriteLock：正常释放（持锁 Invocation 主动释放或 Turn 完成）。
 * - revokeWorkspaceWriteLocksForInvocation：Invocation lost 时强制 revoke（S09-C06 markInvocationLost 调用）。
 * - reapExpiredWorkspaceWriteLocks：后台清理过期 acquired 锁（expires_at 已过）。
 * - getWorkspaceWriteLock / getActiveLockByPath / getLocksByInvocation：查询辅助。
 *
 * 关键约束：
 * - 同一 WorkspaceBinding + 同一路径指纹同时只能有一个 acquired 锁（应用层 SELECT FOR UPDATE 保证）。
 * - 写锁状态变化通过 workspace_write_lock.acquired/released/revoked/conflict ThreadEvent 记录（）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 同事务内写锁状态 + ThreadEvent（）。
 * - ThreadEvent sequence 通过锁定 thread.last_event_sequence 原子递增（）。
 */
import { randomUUID } from "node:crypto";
import {
 WorkspaceWriteLockConflictError,
 WorkspaceWriteLockNotFoundError,
 WorkspaceWriteLockStateError,
} from "@/lib/conversations/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import type { WorkspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { and, asc, eq, isNotNull, lt } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** acquireWorkspaceWriteLock 入参。 */
export interface AcquireWorkspaceWriteLockParams {
 tenantId: string;
 /** 所属 WorkspaceBinding。 */
 workspaceBindingId: string;
 /** 所属 Thread（用于写 ThreadEvent）。 */
 threadId: string;
 /** 持锁 Invocation。 */
 holderInvocationId: string;
 /** 持锁 ThreadRelation（可选；delegate Child Thread 持锁时填）。 */
 holderRelationId?: string;
 /** 锁定的路径引用（受管引用，不暴露绝对路径）。 */
 pathRef: string;
 /** 路径指纹（sha256: 前缀；用于 UNIQUE 校验）。 */
 pathFingerprint: string;
 /** 过期时间（null 表示随 Invocation 生命周期释放）。 */
 expiresAt?: Date | null;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/** acquireWorkspaceWriteLock 返回结果。 */
export interface AcquireWorkspaceWriteLockResult {
 lock: WorkspaceWriteLock;
 /** workspace_write_lock.acquired 事件（若写 ThreadEvent 成功）。 */
 acquiredEvent: unknown | null;
}

/**
 * 获取 Desktop 同路径写锁（§13 行 268 禁止后完成者覆盖）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE 锁定同 WorkspaceBinding + pathFingerprint 的活跃锁行。
 * 2. 若存在 acquired 锁：
 * - 若持锁者就是当前 Invocation，幂等返回（不重复 INSERT）。
 * - 否则抛 WorkspaceWriteLockConflictError（不静默覆盖、不等待）。
 * 3. 若存在 released/expired/revoked 历史行，新建一行 acquired（不修改历史行，Event 只 INSERT）。
 * 4. 若不存在任何行，INSERT 新 acquired 行。
 * 5. 事务内写 workspace_write_lock.acquired ThreadEvent。
 *
 * @throws WorkspaceWriteLockConflictError 已有活跃锁且持锁者非当前 Invocation
 */
export async function acquireWorkspaceWriteLock(
 params: AcquireWorkspaceWriteLockParams,
): Promise<AcquireWorkspaceWriteLockResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 // 1. 查询同 binding + path 的所有锁行（FOR UPDATE 防并发）
 const existing = await tx
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, params.tenantId),
 eq(workspaceWriteLock.workspaceBindingId, params.workspaceBindingId),
 eq(workspaceWriteLock.pathFingerprint, params.pathFingerprint),
 ),
 )
 .for("update");

 // 2. 检查是否有 acquired 状态的锁
 const activeLock = existing.find((l) => l.lockState === "acquired");
 if (activeLock) {
 if (activeLock.holderInvocationId === params.holderInvocationId) {
 // 幂等：同 Invocation 重复 acquire 返回现有锁
 return { lock: activeLock, acquiredEvent: null };
 }
 throw new WorkspaceWriteLockConflictError(
 params.workspaceBindingId,
 params.pathFingerprint,
 activeLock.holderInvocationId,
 );
 }

 // 3. INSERT 新 acquired 行（不修改历史 released/expired/revoked 行）
 const now = new Date();
 const lockId = randomUUID();
 await tx.insert(workspaceWriteLock).values({
 id: lockId,
 tenantId: params.tenantId,
 workspaceBindingId: params.workspaceBindingId,
 holderInvocationId: params.holderInvocationId,
 holderRelationId: params.holderRelationId ?? null,
 pathRef: params.pathRef,
 pathFingerprint: params.pathFingerprint,
 lockState: "acquired",
 acquiredAt: now,
 expiresAt: params.expiresAt ?? null,
 releasedAt: null,
 releaseReasonCode: null,
 versionNo: randomUUID(),
 createdAt: now,
 updatedAt: now,
 });

 const [lock] = await tx
 .select()
 .from(workspaceWriteLock)
 .where(eq(workspaceWriteLock.id, lockId))
 .limit(1);
 if (!lock) {
 throw new Error(`acquireWorkspaceWriteLock: 锁行未找到（id=${lockId}）`);
 }

 // 4. 写 workspace_write_lock.acquired ThreadEvent
 const seq = await allocateEventSequences(tx, params.threadId, 1);
 const acquiredEvent = await insertThreadEvent(tx, params.threadId, seq, {
 eventType: "workspace_write_lock.acquired",
 invocationId: params.holderInvocationId,
 actorType,
 actorId: params.actorId,
 payload: {
 workspace_binding_id: params.workspaceBindingId,
 holder_invocation_id: params.holderInvocationId,
 holder_relation_id: params.holderRelationId ?? null,
 path_fingerprint: params.pathFingerprint,
 lock_id: lockId,
 expires_at: params.expiresAt ? params.expiresAt.toISOString() : null,
 },
 correlationId: params.correlationId,
 });

 return { lock, acquiredEvent };
 });
}

/** releaseWorkspaceWriteLock 入参。 */
export interface ReleaseWorkspaceWriteLockParams {
 tenantId: string;
 lockId: string;
 /** 释放原因码（如 turn_completed/expired/invocation_lost）。 */
 releaseReasonCode: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/**
 * 正常释放写锁（持锁 Invocation 主动释放或 Turn 完成）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE 锁行。
 * 2. 校验 lockState == acquired（否则抛 WorkspaceWriteLockStateError）。
 * 3. 更新 lockState → released + releasedAt + releaseReasonCode。
 * 4. 通过 lock.workspaceBindingId 反查 Thread（写 ThreadEvent 需要 threadId）。
 * 5. 写 workspace_write_lock.released ThreadEvent。
 *
 * @throws WorkspaceWriteLockNotFoundError 锁不存在或跨租户不可见
 * @throws WorkspaceWriteLockStateError 锁已非 acquired 状态
 */
export async function releaseWorkspaceWriteLock(
 params: ReleaseWorkspaceWriteLockParams,
): Promise<WorkspaceWriteLock> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const [lock] = await tx
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, params.tenantId),
 eq(workspaceWriteLock.id, params.lockId),
 ),
 )
 .for("update")
 .limit(1);

 if (!lock) {
 throw new WorkspaceWriteLockNotFoundError(params.lockId);
 }

 if (lock.lockState !== "acquired") {
 throw new WorkspaceWriteLockStateError(params.lockId, lock.lockState, "acquired");
 }

 const now = new Date();
 await tx
 .update(workspaceWriteLock)
 .set({
 lockState: "released",
 releasedAt: now,
 releaseReasonCode: params.releaseReasonCode,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceWriteLock.id, params.lockId));

 const [updated] = await tx
 .select()
 .from(workspaceWriteLock)
 .where(eq(workspaceWriteLock.id, params.lockId))
 .limit(1);

 // 写 workspace_write_lock.released ThreadEvent（通过 holderInvocationId 反查 threadId）
 await writeLockEventForInvocation(
 tx,
 params.tenantId,
 lock.holderInvocationId,
 "workspace_write_lock.released",
 actorType,
 params.actorId,
 {
 workspace_binding_id: lock.workspaceBindingId,
 path_fingerprint: lock.pathFingerprint,
 lock_id: lock.id,
 release_reason_code: params.releaseReasonCode,
 },
 params.correlationId,
 );

 return updated ?? lock;
 });
}

/** revokeWorkspaceWriteLocksForInvocation 入参。 */
export interface RevokeWorkspaceWriteLocksForInvocationParams {
 tenantId: string;
 /** 失联的 Invocation id。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/**
 * Invocation lost 时强制 revoke 所有该 Invocation 持有的活跃写锁（S09-C06 markInvocationLost 调用）。
 *
 * 流程：
 * 1. 事务内查询 invocationId 持有的所有 acquired 锁。
 * 2. 逐个更新 lockState → revoked + releasedAt + releaseReasonCode=invocation_lost。
 * 3. 逐个写 workspace_write_lock.revoked ThreadEvent。
 *
 * 返回被 revoke 的锁列表（可能为空）。
 */
export async function revokeWorkspaceWriteLocksForInvocation(
 params: RevokeWorkspaceWriteLocksForInvocationParams,
): Promise<WorkspaceWriteLock[]> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const locks = await tx
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, params.tenantId),
 eq(workspaceWriteLock.holderInvocationId, params.invocationId),
 eq(workspaceWriteLock.lockState, "acquired"),
 ),
 )
 .for("update");

 if (locks.length === 0) {
 return [];
 }

 const now = new Date();
 const revoked: WorkspaceWriteLock[] = [];
 for (const lock of locks) {
 await tx
 .update(workspaceWriteLock)
 .set({
 lockState: "revoked",
 releasedAt: now,
 releaseReasonCode: "invocation_lost",
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceWriteLock.id, lock.id));

 const [updated] = await tx
 .select()
 .from(workspaceWriteLock)
 .where(eq(workspaceWriteLock.id, lock.id))
 .limit(1);
 if (updated) {
 revoked.push(updated);
 }

 await writeLockEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_write_lock.revoked",
 actorType,
 params.actorId,
 {
 workspace_binding_id: lock.workspaceBindingId,
 path_fingerprint: lock.pathFingerprint,
 lock_id: lock.id,
 release_reason_code: "invocation_lost",
 },
 params.correlationId,
 );
 }

 return revoked;
 });
}

/** reapExpiredWorkspaceWriteLocks 入参。 */
export interface ReapExpiredWorkspaceWriteLocksParams {
 tenantId: string;
 /** 清理基准时间（默认 now）。 */
 before?: Date;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
}

/**
 * 后台清理过期 acquired 锁（expires_at 已过）。
 *
 * 流程：
 * 1. 事务内查询 acquired + expires_at < before 的锁。
 * 2. 逐个更新 lockState → expired + releasedAt + releaseReasonCode=expired。
 * 3. 逐个写 workspace_write_lock.released ThreadEvent（releaseReasonCode=expired）。
 *
 * @returns 被 reap 的锁列表（可能为空）
 */
export async function reapExpiredWorkspaceWriteLocks(
 params: ReapExpiredWorkspaceWriteLocksParams,
): Promise<WorkspaceWriteLock[]> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";
 const before = params.before ?? new Date();

 return db.transaction(async (tx) => {
 const locks = await tx
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, params.tenantId),
 eq(workspaceWriteLock.lockState, "acquired"),
 isNotNull(workspaceWriteLock.expiresAt),
 lt(workspaceWriteLock.expiresAt, before),
 ),
 )
 .for("update");

 if (locks.length === 0) {
 return [];
 }

 const now = new Date();
 const expired: WorkspaceWriteLock[] = [];
 for (const lock of locks) {
 await tx
 .update(workspaceWriteLock)
 .set({
 lockState: "expired",
 releasedAt: now,
 releaseReasonCode: "expired",
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceWriteLock.id, lock.id));

 const [updated] = await tx
 .select()
 .from(workspaceWriteLock)
 .where(eq(workspaceWriteLock.id, lock.id))
 .limit(1);
 if (updated) {
 expired.push(updated);
 }

 await writeLockEventForInvocation(
 tx,
 params.tenantId,
 lock.holderInvocationId,
 "workspace_write_lock.released",
 actorType,
 params.actorId,
 {
 workspace_binding_id: lock.workspaceBindingId,
 path_fingerprint: lock.pathFingerprint,
 lock_id: lock.id,
 release_reason_code: "expired",
 },
 undefined,
 );
 }

 return expired;
 });
}

/**
 * 查询指定锁（跨租户隔离）。
 * 不存在返回 null（不抛错；用于查询场景）。
 */
export async function getWorkspaceWriteLock(
 tenantId: string,
 lockId: string,
): Promise<WorkspaceWriteLock | null> {
 const [lock] = await db
 .select()
 .from(workspaceWriteLock)
 .where(and(eq(workspaceWriteLock.tenantId, tenantId), eq(workspaceWriteLock.id, lockId)))
 .limit(1);
 return lock ?? null;
}

/**
 * 查询指定 binding + path 的活跃锁（acquired 状态）。
 * 不存在返回 null。
 */
export async function getActiveLockByPath(
 tenantId: string,
 workspaceBindingId: string,
 pathFingerprint: string,
): Promise<WorkspaceWriteLock | null> {
 const [lock] = await db
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, tenantId),
 eq(workspaceWriteLock.workspaceBindingId, workspaceBindingId),
 eq(workspaceWriteLock.pathFingerprint, pathFingerprint),
 eq(workspaceWriteLock.lockState, "acquired"),
 ),
 )
 .limit(1);
 return lock ?? null;
}

/**
 * 查询指定 Invocation 持有的所有活跃锁。
 */
export async function getActiveLocksByInvocation(
 tenantId: string,
 invocationId: string,
): Promise<WorkspaceWriteLock[]> {
 return db
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, tenantId),
 eq(workspaceWriteLock.holderInvocationId, invocationId),
 eq(workspaceWriteLock.lockState, "acquired"),
 ),
 )
 .orderBy(asc(workspaceWriteLock.acquiredAt));
}

/**
 * 查询指定 binding 下所有活跃锁（用于并发场景诊断）。
 */
export async function getActiveLocksByBinding(
 tenantId: string,
 workspaceBindingId: string,
): Promise<WorkspaceWriteLock[]> {
 return db
 .select()
 .from(workspaceWriteLock)
 .where(
 and(
 eq(workspaceWriteLock.tenantId, tenantId),
 eq(workspaceWriteLock.workspaceBindingId, workspaceBindingId),
 eq(workspaceWriteLock.lockState, "acquired"),
 ),
 )
 .orderBy(asc(workspaceWriteLock.acquiredAt));
}

// ─── 内部辅助：通过 invocationId 反查 threadId 并写 ThreadEvent ──

async function writeLockEventForInvocation(
 tx: Tx,
 tenantId: string,
 invocationId: string,
 eventType: string,
 actorType: ThreadEventActorType,
 actorId: string | undefined,
 payload: Record<string, unknown>,
 correlationId: string | undefined,
): Promise<void> {
 // 通过 invocationId 反查 invocationTable.threadId（跨租户隔离）
 const [invocation] = await tx
 .select({ threadId: invocationTable.threadId })
 .from(invocationTable)
 .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
 .limit(1);

 if (!invocation?.threadId) {
 // Job 模式（threadId=null）不写 ThreadEvent，与 S09-C06 Job 模式语义一致
 return;
 }

 const seq = await allocateEventSequences(tx, invocation.threadId, 1);
 await insertThreadEvent(tx, invocation.threadId, seq, {
 eventType,
 invocationId,
 actorType,
 actorId,
 payload,
 correlationId,
 });
}
