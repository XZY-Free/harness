/**
 * V11 Workspace Overlay 仓储（S09-C07）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/05-continuity-collaboration-and-reliability.md §13（并发 Workspace）、
 * §13 行 264-273（Cloud/Git worktree 隔离 + 合并冲突显式回传父 Agent）
 * - ../v11-agentkit-platform/10-core-data-model.md （Event 只 INSERT）、§9（事务边界）
 * - ../v11-agentkit-platform-development-plan/09-collaboration-jobs-and-recovery.md 、S09-C07
 *
 * 职责：
 * - createWorkspaceOverlay：为子 ThreadRelation 创建独立 Overlay（git_worktree/cloud_overlay）。
 * - mergeWorkspaceOverlay：合并 Overlay 到父 WorkspaceBinding（成功 → merged）。
 * - reportWorkspaceMergeConflict：报告合并冲突（Overlay → conflict；写 workspace_merge_conflict 行；显式回传父 Agent）。
 * - resolveWorkspaceMergeConflict：父 Agent 显式解决冲突（手动合并 hash）。
 * - abandonWorkspaceOverlay：父 Agent 放弃整个 Overlay（Overlay → discarded）。
 * - 查询辅助：getOverlay / getOverlaysByRelation / getOverlaysByBinding / getMergeConflictsByOverlay。
 *
 * 关键约束：
 * - 同一父 Binding + 同一 ThreadRelation 同时只能有一个 Overlay（UNIQUE 约束）。
 * - 合并冲突显式回传：禁止后完成者覆盖（§13 行 268）。
 * - Overlay 状态变化通过 workspace_overlay.created/merged/merge_conflict/discarded ThreadEvent 记录（）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - 同事务内 Overlay 状态 + MergeConflict 行 + ThreadEvent（）。
 * - ThreadEvent sequence 通过锁定 thread.last_event_sequence 原子递增（）。
 */
import { randomUUID } from "node:crypto";
import {
 WorkspaceOverlayMergeConflictError,
 WorkspaceOverlayNotFoundError,
 WorkspaceOverlayStateError,
} from "@/lib/conversations/errors";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import type { ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/runtime";
import type {
 WorkspaceMergeConflict,
 WorkspaceMergeConflictState,
 WorkspaceOverlay,
 WorkspaceOverlayType,
} from "@/lib/persistence/schema/workspace-lock";
import { workspaceMergeConflict, workspaceOverlay } from "@/lib/persistence/schema/workspace-lock";
import { and, asc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** createWorkspaceOverlay 入参。 */
export interface CreateWorkspaceOverlayParams {
 tenantId: string;
 /** 父 WorkspaceBinding。 */
 parentWorkspaceBindingId: string;
 /** 关联 ThreadRelation。 */
 relationId: string;
 /** Overlay 类型。 */
 overlayType: WorkspaceOverlayType;
 /** Overlay 独立位置引用。 */
 overlayLocationRef: string;
 /** Overlay 位置指纹。 */
 overlayFingerprint: string;
 /** 基线 revision 引用。 */
 baseRevisionRef?: string;
 /** 父 Agent 给子任务的任务描述（冲突时回传用）。 */
 taskDescription?: string;
 /** 持锁 Invocation（用于写 ThreadEvent）。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/** createWorkspaceOverlay 返回结果。 */
export interface CreateWorkspaceOverlayResult {
 overlay: WorkspaceOverlay;
 /** workspace_overlay.created 事件。 */
 createdEvent: unknown | null;
}

/**
 * 为子 ThreadRelation 创建独立 Overlay（§13 行 264-266）。
 *
 * 流程：
 * 1. INSERT Overlay 行（active 状态）。
 * 2. 写 workspace_overlay.created ThreadEvent。
 *
 * UNIQUE(parent_binding, relation) 保证同一关系不重复创建；冲突时 DB 抛错。
 */
export async function createWorkspaceOverlay(
 params: CreateWorkspaceOverlayParams,
): Promise<CreateWorkspaceOverlayResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const now = new Date();
 const overlayId = randomUUID();
 await tx.insert(workspaceOverlay).values({
 id: overlayId,
 tenantId: params.tenantId,
 parentWorkspaceBindingId: params.parentWorkspaceBindingId,
 relationId: params.relationId,
 overlayType: params.overlayType,
 overlayLocationRef: params.overlayLocationRef,
 overlayFingerprint: params.overlayFingerprint,
 baseRevisionRef: params.baseRevisionRef ?? null,
 overlayState: "active",
 taskDescription: params.taskDescription ?? null,
 mergedRevisionRef: null,
 mergedAt: null,
 discardedAt: null,
 versionNo: randomUUID(),
 createdAt: now,
 updatedAt: now,
 });

 const [overlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, overlayId))
 .limit(1);
 if (!overlay) {
 throw new Error(`createWorkspaceOverlay: Overlay 行未找到（id=${overlayId}）`);
 }

 const createdEvent = await writeOverlayEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_overlay.created",
 actorType,
 params.actorId,
 {
 overlay_id: overlayId,
 parent_workspace_binding_id: params.parentWorkspaceBindingId,
 relation_id: params.relationId,
 overlay_type: params.overlayType,
 overlay_fingerprint: params.overlayFingerprint,
 base_revision_ref: params.baseRevisionRef ?? null,
 },
 params.correlationId,
 );

 return { overlay, createdEvent };
 });
}

/** mergeWorkspaceOverlay 入参。 */
export interface MergeWorkspaceOverlayParams {
 tenantId: string;
 overlayId: string;
 /** 合并完成的 revision 引用。 */
 mergedRevisionRef: string;
 /** 持锁 Invocation（用于写 ThreadEvent）。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/**
 * 合并 Overlay 到父 WorkspaceBinding（成功 → merged）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE Overlay 行。
 * 2. 校验 overlayState == active（conflict/discarded/merged 抛 WorkspaceOverlayStateError）。
 * 3. 更新 overlayState → merged + mergedRevisionRef + mergedAt。
 * 4. 写 workspace_overlay.merged ThreadEvent。
 *
 * @throws WorkspaceOverlayNotFoundError Overlay 不存在或跨租户不可见
 * @throws WorkspaceOverlayStateError Overlay 不在 active 状态
 */
export async function mergeWorkspaceOverlay(
 params: MergeWorkspaceOverlayParams,
): Promise<WorkspaceOverlay> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const [overlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(
 and(
 eq(workspaceOverlay.tenantId, params.tenantId),
 eq(workspaceOverlay.id, params.overlayId),
 ),
 )
 .for("update")
 .limit(1);

 if (!overlay) {
 throw new WorkspaceOverlayNotFoundError(params.overlayId);
 }

 if (overlay.overlayState !== "active") {
 throw new WorkspaceOverlayStateError(params.overlayId, overlay.overlayState, "active");
 }

 const now = new Date();
 await tx
 .update(workspaceOverlay)
 .set({
 overlayState: "merged",
 mergedRevisionRef: params.mergedRevisionRef,
 mergedAt: now,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceOverlay.id, params.overlayId));

 const [updated] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, params.overlayId))
 .limit(1);

 await writeOverlayEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_overlay.merged",
 actorType,
 params.actorId,
 {
 overlay_id: params.overlayId,
 parent_workspace_binding_id: overlay.parentWorkspaceBindingId,
 relation_id: overlay.relationId,
 merged_revision_ref: params.mergedRevisionRef,
 },
 params.correlationId,
 );

 return updated ?? overlay;
 });
}

/** reportWorkspaceMergeConflict 入参。 */
export interface ReportWorkspaceMergeConflictParams {
 tenantId: string;
 overlayId: string;
 /** 冲突路径列表（每条冲突一个 path + hashes）。 */
 conflicts: Array<{
 conflictPathRef: string;
 pathFingerprint: string;
 beforeHash?: string;
 oursHash?: string;
 theirsHash?: string;
 conflictDetailsJson?: Record<string, unknown>;
 }>;
 /** 持锁 Invocation（用于写 ThreadEvent）。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/** reportWorkspaceMergeConflict 返回结果。 */
export interface ReportWorkspaceMergeConflictResult {
 overlay: WorkspaceOverlay;
 /** 创建的冲突记录列表。 */
 conflicts: WorkspaceMergeConflict[];
}

/**
 * 报告合并冲突（§13 行 268 禁止后完成者覆盖）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE Overlay 行。
 * 2. 校验 overlayState == active（已 conflict/discarded/merged 抛错）。
 * 3. INSERT 多条 workspace_merge_conflict 行（reported 状态）。
 * 4. 更新 overlayState → conflict。
 * 5. 写 workspace_overlay.merge_conflict ThreadEvent（payload 含冲突摘要）。
 * 6. 不抛错——返回结果由调用方决定（如父 Agent 收到冲突后 resolve 或 abandon）。
 *
 * 调用方在 Overlay 已 conflict 后尝试 merge 时应抛 WorkspaceOverlayMergeConflictError。
 *
 * @throws WorkspaceOverlayStateError Overlay 不在 active 状态
 */
export async function reportWorkspaceMergeConflict(
 params: ReportWorkspaceMergeConflictParams,
): Promise<ReportWorkspaceMergeConflictResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 if (params.conflicts.length === 0) {
 throw new Error("reportWorkspaceMergeConflict: conflicts 列表不能为空");
 }

 return db.transaction(async (tx) => {
 const [overlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(
 and(
 eq(workspaceOverlay.tenantId, params.tenantId),
 eq(workspaceOverlay.id, params.overlayId),
 ),
 )
 .for("update")
 .limit(1);

 if (!overlay) {
 throw new WorkspaceOverlayNotFoundError(params.overlayId);
 }

 if (overlay.overlayState !== "active") {
 throw new WorkspaceOverlayStateError(params.overlayId, overlay.overlayState, "active");
 }

 // 1. INSERT 多条冲突记录
 const now = new Date();
 const createdConflicts: WorkspaceMergeConflict[] = [];
 for (const c of params.conflicts) {
 const conflictId = randomUUID();
 await tx.insert(workspaceMergeConflict).values({
 id: conflictId,
 tenantId: params.tenantId,
 overlayId: params.overlayId,
 conflictPathRef: c.conflictPathRef,
 pathFingerprint: c.pathFingerprint,
 beforeHash: c.beforeHash ?? null,
 oursHash: c.oursHash ?? null,
 theirsHash: c.theirsHash ?? null,
 conflictState: "reported",
 conflictDetailsJson: c.conflictDetailsJson ?? null,
 resolutionSummary: null,
 reportedAt: now,
 resolvedAt: null,
 versionNo: randomUUID(),
 createdAt: now,
 updatedAt: now,
 });
 const [created] = await tx
 .select()
 .from(workspaceMergeConflict)
 .where(eq(workspaceMergeConflict.id, conflictId))
 .limit(1);
 if (created) {
 createdConflicts.push(created);
 }
 }

 // 2. 更新 Overlay → conflict
 await tx
 .update(workspaceOverlay)
 .set({
 overlayState: "conflict",
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceOverlay.id, params.overlayId));

 const [updatedOverlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, params.overlayId))
 .limit(1);

 // 3. 写 workspace_overlay.merge_conflict ThreadEvent
 await writeOverlayEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_overlay.merge_conflict",
 actorType,
 params.actorId,
 {
 overlay_id: params.overlayId,
 parent_workspace_binding_id: overlay.parentWorkspaceBindingId,
 relation_id: overlay.relationId,
 conflict_count: createdConflicts.length,
 conflict_paths: createdConflicts.map((c) => c.conflictPathRef),
 },
 params.correlationId,
 );

 return { overlay: updatedOverlay ?? overlay, conflicts: createdConflicts };
 });
}

/** resolveWorkspaceMergeConflict 入参。 */
export interface ResolveWorkspaceMergeConflictParams {
 tenantId: string;
 overlayId: string;
 /** 父 Agent 的解决方案摘要（如手动合并后的 hash、选择一边的标识）。 */
 resolutionSummary: string;
 /** 合并完成后的 revision 引用（若有；用于将 Overlay 转 merged）。 */
 mergedRevisionRef?: string;
 /** 持锁 Invocation（用于写 ThreadEvent）。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/**
 * 父 Agent 显式解决冲突（手动合并 hash 或选择一边）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE Overlay 行。
 * 2. 校验 overlayState == conflict（active/merged/discarded 抛错）。
 * 3. 更新所有 reported 状态的 conflict 行 → resolved + resolutionSummary + resolvedAt。
 * 4. 若提供 mergedRevisionRef，更新 Overlay → merged + mergedRevisionRef + mergedAt；否则保持 conflict 等后续 merge。
 * 5. 写 workspace_overlay.merged ThreadEvent（若转 merged）。
 *
 * @throws WorkspaceOverlayStateError Overlay 不在 conflict 状态
 */
export async function resolveWorkspaceMergeConflict(
 params: ResolveWorkspaceMergeConflictParams,
): Promise<WorkspaceOverlay> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const [overlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(
 and(
 eq(workspaceOverlay.tenantId, params.tenantId),
 eq(workspaceOverlay.id, params.overlayId),
 ),
 )
 .for("update")
 .limit(1);

 if (!overlay) {
 throw new WorkspaceOverlayNotFoundError(params.overlayId);
 }

 if (overlay.overlayState !== "conflict") {
 throw new WorkspaceOverlayStateError(params.overlayId, overlay.overlayState, "conflict");
 }

 // 1. 更新所有 reported 状态的 conflict 行 → resolved
 const now = new Date();
 await tx
 .update(workspaceMergeConflict)
 .set({
 conflictState: "resolved",
 resolutionSummary: params.resolutionSummary,
 resolvedAt: now,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(
 and(
 eq(workspaceMergeConflict.tenantId, params.tenantId),
 eq(workspaceMergeConflict.overlayId, params.overlayId),
 eq(workspaceMergeConflict.conflictState, "reported"),
 ),
 );

 // 2. 若提供 mergedRevisionRef，转 merged
 if (params.mergedRevisionRef) {
 await tx
 .update(workspaceOverlay)
 .set({
 overlayState: "merged",
 mergedRevisionRef: params.mergedRevisionRef,
 mergedAt: now,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceOverlay.id, params.overlayId));

 const [updated] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, params.overlayId))
 .limit(1);

 await writeOverlayEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_overlay.merged",
 actorType,
 params.actorId,
 {
 overlay_id: params.overlayId,
 parent_workspace_binding_id: overlay.parentWorkspaceBindingId,
 relation_id: overlay.relationId,
 merged_revision_ref: params.mergedRevisionRef,
 resolution_summary: params.resolutionSummary,
 },
 params.correlationId,
 );

 return updated ?? overlay;
 }

 // 否则保持 conflict 状态（仅 conflict 行 resolved，等后续手动 merge）
 const [updated] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, params.overlayId))
 .limit(1);
 return updated ?? overlay;
 });
}

/** abandonWorkspaceOverlay 入参。 */
export interface AbandonWorkspaceOverlayParams {
 tenantId: string;
 overlayId: string;
 /** 持锁 Invocation（用于写 ThreadEvent）。 */
 invocationId: string;
 /** 触发事件的 actor 类型。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 correlationId?: string;
}

/**
 * 父 Agent 放弃整个 Overlay（不合并；Overlay → discarded）。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE Overlay 行。
 * 2. 校验 overlayState ∈ {active, conflict}（merged/discarded 抛错）。
 * 3. 若有 reported 状态的 conflict 行，更新为 abandoned。
 * 4. 更新 Overlay → discarded + discardedAt。
 * 5. 写 workspace_overlay.discarded ThreadEvent。
 */
export async function abandonWorkspaceOverlay(
 params: AbandonWorkspaceOverlayParams,
): Promise<WorkspaceOverlay> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";

 return db.transaction(async (tx) => {
 const [overlay] = await tx
 .select()
 .from(workspaceOverlay)
 .where(
 and(
 eq(workspaceOverlay.tenantId, params.tenantId),
 eq(workspaceOverlay.id, params.overlayId),
 ),
 )
 .for("update")
 .limit(1);

 if (!overlay) {
 throw new WorkspaceOverlayNotFoundError(params.overlayId);
 }

 if (overlay.overlayState !== "active" && overlay.overlayState !== "conflict") {
 throw new WorkspaceOverlayStateError(
 params.overlayId,
 overlay.overlayState,
 "active|conflict",
 );
 }

 const now = new Date();

 // 若有 reported 状态的 conflict 行，更新为 abandoned
 await tx
 .update(workspaceMergeConflict)
 .set({
 conflictState: "abandoned",
 resolvedAt: now,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(
 and(
 eq(workspaceMergeConflict.tenantId, params.tenantId),
 eq(workspaceMergeConflict.overlayId, params.overlayId),
 eq(workspaceMergeConflict.conflictState, "reported"),
 ),
 );

 await tx
 .update(workspaceOverlay)
 .set({
 overlayState: "discarded",
 discardedAt: now,
 versionNo: randomUUID(),
 updatedAt: now,
 })
 .where(eq(workspaceOverlay.id, params.overlayId));

 const [updated] = await tx
 .select()
 .from(workspaceOverlay)
 .where(eq(workspaceOverlay.id, params.overlayId))
 .limit(1);

 await writeOverlayEventForInvocation(
 tx,
 params.tenantId,
 params.invocationId,
 "workspace_overlay.discarded",
 actorType,
 params.actorId,
 {
 overlay_id: params.overlayId,
 parent_workspace_binding_id: overlay.parentWorkspaceBindingId,
 relation_id: overlay.relationId,
 },
 params.correlationId,
 );

 return updated ?? overlay;
 });
}

// ─── 查询辅助 ──────────────────────────────────────────────

/** 查询指定 Overlay（跨租户隔离）。不存在返回 null。 */
export async function getWorkspaceOverlay(
 tenantId: string,
 overlayId: string,
): Promise<WorkspaceOverlay | null> {
 const [overlay] = await db
 .select()
 .from(workspaceOverlay)
 .where(and(eq(workspaceOverlay.tenantId, tenantId), eq(workspaceOverlay.id, overlayId)))
 .limit(1);
 return overlay ?? null;
}

/** 查询指定 ThreadRelation 的所有 Overlay。 */
export async function getOverlaysByRelation(
 tenantId: string,
 relationId: string,
): Promise<WorkspaceOverlay[]> {
 return db
 .select()
 .from(workspaceOverlay)
 .where(
 and(eq(workspaceOverlay.tenantId, tenantId), eq(workspaceOverlay.relationId, relationId)),
 )
 .orderBy(asc(workspaceOverlay.createdAt));
}

/** 查询指定父 WorkspaceBinding 的所有 Overlay。 */
export async function getOverlaysByBinding(
 tenantId: string,
 parentWorkspaceBindingId: string,
): Promise<WorkspaceOverlay[]> {
 return db
 .select()
 .from(workspaceOverlay)
 .where(
 and(
 eq(workspaceOverlay.tenantId, tenantId),
 eq(workspaceOverlay.parentWorkspaceBindingId, parentWorkspaceBindingId),
 ),
 )
 .orderBy(asc(workspaceOverlay.createdAt));
}

/** 查询指定 Overlay 的所有 MergeConflict（按 conflictState 过滤；不传则全部）。 */
export async function getMergeConflictsByOverlay(
 tenantId: string,
 overlayId: string,
 conflictState?: WorkspaceMergeConflictState,
): Promise<WorkspaceMergeConflict[]> {
 const conditions = [
 eq(workspaceMergeConflict.tenantId, tenantId),
 eq(workspaceMergeConflict.overlayId, overlayId),
 ];
 if (conflictState) {
 conditions.push(eq(workspaceMergeConflict.conflictState, conflictState));
 }
 return db
 .select()
 .from(workspaceMergeConflict)
 .where(and(...conditions))
 .orderBy(asc(workspaceMergeConflict.reportedAt));
}

// ─── 内部辅助：通过 invocationId 反查 threadId 并写 ThreadEvent ──

async function writeOverlayEventForInvocation(
 tx: Tx,
 tenantId: string,
 invocationId: string,
 eventType: string,
 actorType: ThreadEventActorType,
 actorId: string | undefined,
 payload: Record<string, unknown>,
 correlationId: string | undefined,
): Promise<unknown | null> {
 // 通过 invocationId 反查 invocationTable.threadId（跨租户隔离）
 const [invocation] = await tx
 .select({ threadId: invocationTable.threadId })
 .from(invocationTable)
 .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
 .limit(1);

 if (!invocation?.threadId) {
 // Job 模式（threadId=null）不写 ThreadEvent
 return null;
 }

 const seq = await allocateEventSequences(tx, invocation.threadId, 1);
 return insertThreadEvent(tx, invocation.threadId, seq, {
 eventType,
 invocationId,
 actorType,
 actorId,
 payload,
 correlationId,
 });
}
