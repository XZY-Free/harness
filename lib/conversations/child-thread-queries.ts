/**
 * Child Thread / Delegate 仓储（S09-C01 + S09-C02）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （ThreadRelation 表）、
 * （Invocation）、行 504（InvocationCommand 表）
 * - docs/architecture/conversations.md §9（Delegate 语义、状态机）、§16（取消）、§18（预算）
 * - docs/architecture/capability-and-collaboration-api.md §4（delegateChildThread 契约）、（结果投影）、（取消协议）
 * - docs/architecture/conversations.md /W02
 *
 * 职责：
 * - delegateChildThread：事务内创建子 Thread + 父子 delegate 关系 + ChildThread Item + 三条 Event
 * （子 thread.created + 父 child_thread.created + 父 item.created），含 policy 校验。
 * - getChildThreadRelation / getRelationsByParentInvocation / getRelationsByParentThread：查询。
 * - getChildThreadResult：读取 relation 终态结果（resultItemId/resultRef/resultHash）。
 * - requestChildThreadCancellation：relation_state active → cancel_requested + 写父 Thread 事件
 * + 入队 cancel InvocationCommand（携带 relation_id 与 reason_code）。
 * - finalizeChildThreadCancellation：cancel_requested → cancelled + 父子流 child_thread.cancelled Event。
 * - projectChildThreadResult：子 Thread 终态 → 父 Thread child_thread Item 投影 result + 回填 relation。
 * - handleChildThreadTerminal：子 Thread 终态协调器（按 completed/failed/cancelled 分派）。
 * - recordChildThreadBudgetUsage / getChildThreadBudgetUsage / assertChildThreadBudgetNotExhausted：预算用量。
 *
 * 关键约束（§9 行 380-417、§16 行 580-595；12 文档 §4）：
 * - 只有 executionState=running 的父 Invocation 可以委派（queued/waiting_user/终态一律拒）。
 * - target_agent_id 必须在父 Agent delegationPolicyJson.allowedTargets 中。
 * - 委派深度 + 1 <= delegationPolicyJson.maxDepth（root parent 的 maxDepth 整条链共享）。
 * - budgetPolicyJson 必须为非负值；负值或非法 → ChildBudgetExceededError。
 * - contextTransferPolicyJson 必拒集合：Credential、隐藏思维链（contextPolicy=sensitive）、
 * 未授权本地路径；尝试列入 include 列表 → ChildContextNotAllowedError。
 * - 取消请求 ≠ 已取消：relation_state active → cancel_requested → cancelled，
 * 终态由 Runtime/应用服务在执行确认后落库（§9 行 412-417）。
 * - 父 Turn 只得到一个 child_thread Item 和结构化摘要，不复制子会话全文（12 文档 行 263）。
 * - 完成投影幂等：子 Runtime 不能直接回写父 Thread；投影由平台根据子 Thread 终态生成。
 * - unknown_effect 核对责任：子任务已产生 unknown effect 时不伪造无副作用取消（§16 行 333、12 文档 行 294）。
 * - parent 与 child 不能相同；UNIQUE(parent_thread_id, child_thread_id, relation_type)。
 * - delegate 的 child Thread 创建、relation、父 child_thread.created Event
 * 必须由应用服务原子协调，Runtime 不能直写（行 240）。
 */
import { createHash, randomUUID } from "node:crypto";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import {
 ChildBudgetExceededError,
 ChildContextNotAllowedError,
 ChildInvocationNotTerminalError,
 ChildThreadAlreadyTerminalError,
 ChildThreadBudgetExhaustedError,
 ChildThreadCancellationFinalizeError,
 ChildThreadResultProjectionError,
 DelegationDepthExceededError,
 DelegationNotAllowedError,
 ParentInvocationNotActiveError,
 ThreadNotFoundError,
} from "@/lib/conversations/errors";
import {
 allocateEventSequences,
 allocateItemSequence,
 computeEventPayloadHash,
 insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import type {
 InvocationCommand,
 Thread,
 ThreadEvent,
 ThreadEventActorType,
 ThreadItem,
 ThreadRelation,
} from "@/lib/persistence/schema/conversation";
import {
 invocationCommandTable,
 threadEventTable,
 threadItemTable,
 threadRelationTable,
 threadTable,
} from "@/lib/persistence/schema/conversation";
import {
 INVOCATION_TERMINAL_STATES,
 type InvocationExecutionState,
 invocationTable,
} from "@/lib/persistence/schema/runtime";
import { and, asc, desc, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** delegate Child Thread 的 budget policy 形状。 */
export interface DelegationBudgetPolicy {
 /** 最大 token 数；非负。 */
 maxTokens?: number;
 /** 最大墙钟时长（毫秒）；非负。 */
 maxWallClockMs?: number;
 /** 最大成本（计费单位）；非负。 */
 maxCost?: number;
 /** 最大 Tool 调用次数；非负（S09-C07 新增）。 */
 maxToolCalls?: number;
 /** 最大孙辈 Thread 数量；非负（S09-C07 新增）。 */
 maxChildCount?: number;
 /** 最大 sandbox 执行时长（秒）；非负（S09-C07 新增）。 */
 maxSandboxSeconds?: number;
 /** 最大 Artifact 字节数；非负（S09-C07 新增）。 */
 maxArtifactBytes?: number;
}

/** delegate Child Thread 的 context transfer policy 形状。 */
export interface ContextTransferPolicy {
 /** 必转 Item id 列表（user_message/artifacts 等）。 */
 includeItemIds?: string[];
 /** 必拒 Item id 列表（Credential/sensitive 等）。 */
 excludeItemIds?: string[];
 /** 转移模式：minimal / full / selective。 */
 mode?: "minimal" | "full" | "selective";
}

// ─── S09-C02 类型定义 ───────────────────────────────────────

/**
 * 子 Thread 运行时预算用量累积（12 文档 行 245 budget_used）。
 * 存储于 ThreadRelation.budgetUsedJson。
 */
export interface ChildThreadBudgetUsage {
 /** 累积 token 用量。 */
 tokens?: number;
 /** 累积成本（计费单位）。 */
 cost?: number;
 /** 累积 Tool 调用次数。 */
 toolCalls?: number;
 /** 累积墙钟时长（毫秒）。 */
 wallClockMs?: number;
 /**
 * 子 Thread 是否存在未确认副作用（05 文档 §16 行 333）。
 * finalizeChildThreadCancellation 接受此标记，true 时不伪造无副作用取消。
 */
 unknownEffect?: boolean;
 /** 累积孙辈 Thread 数量（S09-C07 新增）。 */
 childCount?: number;
 /** 累积 sandbox 执行时长（秒）（S09-C07 新增）。 */
 sandboxSeconds?: number;
 /** 累积 Artifact 字节数（S09-C07 新增）。 */
 artifactBytes?: number;
}

/**
 * 父 Thread 中 child_thread Item 的 contentJson 结构（12 文档 行 263）。
 * 父 Turn 只得到一个 child_thread Item 和结构化摘要，不复制子会话全文。
 */
export interface ChildThreadItemContent {
 /** 关联 ThreadRelation id。 */
 relationId: string;
 /** 子 Thread id。 */
 childThreadId: string;
 /** delegate 目标 Agent id。 */
 targetAgentId: string;
 /** 任务描述引用。 */
 taskPayloadRef: string | null;
 /** 任务描述 hash。 */
 taskPayloadHash: string | null;
 /** 当前 relation_state 镜像（active/cancel_requested/completed/failed/cancelled）。 */
 state: ThreadRelation["relationState"];
 /** 终态结果引用（result:child-thread:{relation_id}:{version}）。 */
 resultRef?: string | null;
 /** 终态结果 hash（sha256: 前缀）。 */
 resultHash?: string | null;
 /** 结构化摘要（来自子 Thread 最终 agent_message Item）。 */
 summary?: string | null;
 /** 子 Thread 关联 Artifact id 列表。 */
 artifactIds?: string[];
 /** 终态时累积预算用量。 */
 budgetUsed?: ChildThreadBudgetUsage | null;
 /** 终态时间戳（ISO 8601 字符串）。 */
 completedAt?: string | null;
 /** 失败错误码（仅 failed 状态）。 */
 errorCode?: string | null;
 /** 失败原因摘要（仅 failed 状态）。 */
 errorSummary?: string | null;
}

/** projectChildThreadResult 入参。 */
export interface ProjectChildThreadResultParams {
 tenantId: string;
 /** delegate ThreadRelation id。 */
 relationId: string;
 /** 触发投影的 actor 类型（默认 system）。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 idempotencyKey?: string;
 correlationId?: string;
 /**
 * 显式传入的子 Thread 最终 Item（可选）。
 * 不传时由本函数自动查询子 Thread 最后一个 completed 状态的 agent_message / job_result Item。
 */
 finalItem?: ThreadItem | null;
 /** 显式传入的结构化摘要（可选；不传时从 finalItem.contentJson 提取 text 字段）。 */
 summary?: string | null;
 /** 显式传入的 Artifact id 列表（可选）。 */
 artifactIds?: string[];
}

/** projectChildThreadResult 返回结果。 */
export interface ProjectChildThreadResultResult {
 relation: ThreadRelation;
 /** 更新后的父 Thread child_thread Item。 */
 item: ThreadItem;
 /** 父 Thread 的 child_thread.completed Event。 */
 completedEvent: ThreadEvent;
 /** 计算得到的结果引用。 */
 resultRef: string;
 /** 计算得到的结果 hash。 */
 resultHash: string;
}

/** finalizeChildThreadCancellation 入参。 */
export interface FinalizeCancellationParams {
 tenantId: string;
 /** delegate ThreadRelation id。 */
 relationId: string;
 /**
 * 子 Thread 是否存在未确认副作用（05 文档 §16 行 333）。
 * true 时在 child_thread.cancelled Event payload 中显式标记 unknown_effect=true，
 * 不删除已有 result 投影，保留核对责任。
 * false 时校验子 Invocation 必须已进入终态（cancelled/failed/completed/lost）。
 */
 unknownEffect: boolean;
 /** 取消原因码（PARENT_NO_LONGER_NEEDS_RESULT / PARENT_CANCELLED / BUDGET_EXHAUSTED）。 */
 reasonCode?: string;
 /** 触发事件的 actor 类型（默认 system）。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 idempotencyKey?: string;
 correlationId?: string;
}

/** finalizeChildThreadCancellation 返回结果。 */
export interface FinalizeCancellationResult {
 relation: ThreadRelation;
 /** 父 Thread 的 child_thread.cancelled Event。 */
 parentCancelledEvent: ThreadEvent;
 /** 子 Thread 的 child_thread.cancelled Event（payload from_parent=true）。 */
 childCancelledEvent: ThreadEvent;
}

/** handleChildThreadTerminal 入参。 */
export interface HandleChildThreadTerminalParams {
 tenantId: string;
 /** 子 Thread id（用于查找 delegate ThreadRelation）。 */
 childThreadId: string;
 /** 子 Thread 终态（completed/failed/cancelled）。 */
 terminalState: "completed" | "failed" | "cancelled";
 /** 子 Thread 是否存在未确认副作用（仅 cancelled 状态使用）。 */
 unknownEffect?: boolean;
 /** 取消原因码（仅 cancelled 状态使用）。 */
 reasonCode?: string;
 /** 触发事件的 actor 类型（默认 system）。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 idempotencyKey?: string;
 correlationId?: string;
}

/** handleChildThreadTerminal 返回结果。 */
export interface HandleChildThreadTerminalResult {
 /** 处理方式：completed → projectChildThreadResult；cancelled → finalizeChildThreadCancellation；failed → projectChildThreadResult（标记 failure）；skipped → 子 Thread 非 delegate 或 relation 已终态。 */
 action: "completed" | "cancelled" | "failed" | "skipped";
 relation: ThreadRelation;
 /** projectChildThreadResult 返回（action=completed/failed 时非空）。 */
 projection?: ProjectChildThreadResultResult;
 /** finalizeChildThreadCancellation 返回（action=cancelled 时非空）。 */
 cancellation?: FinalizeCancellationResult;
}

/** recordChildThreadBudgetUsage 入参。 */
export interface RecordChildThreadBudgetUsageParams {
 tenantId: string;
 /** delegate ThreadRelation id。 */
 relationId: string;
 /** 增量用量（与现有 budgetUsedJson 累积）。 */
 delta: ChildThreadBudgetUsage;
}

/** 单 relation 预算超限字段类型。 */
export type ChildBudgetExceededField =
 | "tokens"
 | "cost"
 | "tool_calls"
 | "wall_clock_ms"
 | "child_count"
 | "sandbox_seconds"
 | "artifact_bytes";

/** recordChildThreadBudgetUsage 返回结果。 */
export interface RecordChildThreadBudgetUsageResult {
 relation: ThreadRelation;
 /** 累积后的预算用量。 */
 budgetUsed: ChildThreadBudgetUsage;
 /** 是否已超过 budgetPolicyJson 上限。 */
 exhausted: boolean;
 /** 超限字段（exhausted=true 时非空）。 */
 exceededField?: ChildBudgetExceededField;
}

/** delegateChildThread 入参。 */
export interface DelegateChildThreadParams {
 tenantId: string;
 /** 父 Thread 必须 active 且 owner 匹配。 */
 parentThreadId: string;
 /** 操作者 userIdentityId（必须等于父 Thread.ownerUserId）。 */
 ownerUserId: string;
 /** 父 Invocation id；必须属于父 Thread 且 executionState=running。 */
 parentInvocationId: string;
 /** 目标 Agent id；必须在父 Agent delegationPolicyJson.allowedTargets 中。 */
 targetAgentId: string;
 /** 任务描述引用（外部 artifact ref / 内部 payload hash 引用）；可空。 */
 taskPayloadRef?: string | null;
 /** 任务描述 hash（sha256: 前缀）；可空。 */
 taskPayloadHash?: string | null;
 /** 上下文转移策略 JSON；不传则采用 minimal 模式。 */
 contextTransferPolicyJson?: ContextTransferPolicy | null;
 /** 预算策略 JSON；不传则不设上限（继承父）。 */
 budgetPolicyJson?: DelegationBudgetPolicy | null;
 /** 子 Thread 标题；不传则继承父 Thread 标题。 */
 title?: string | null;
 /** 触发事件的 actor 类型（默认 user）。 */
 actorType?: ThreadEventActorType;
 actorId?: string;
 idempotencyKey?: string;
 correlationId?: string;
}

/** delegateChildThread 返回结果。 */
export interface DelegateChildThreadResult {
 /** 新建的子 Thread。 */
 thread: Thread;
 /** Delegate 关系记录（relation_type=delegate, state=active）。 */
 relation: ThreadRelation;
 /** 子 Thread 的 thread.created Event。 */
 childCreatedEvent: ThreadEvent;
 /** 父 Thread 流中的 child_thread.created Event。 */
 parentChildThreadCreatedEvent: ThreadEvent;
 /** 父 Thread 中的 child_thread Item（S09-C02：父 Turn 只得到一个 child_thread Item）。 */
 childThreadItem: ThreadItem;
 /** 父 Thread 流中的 item.created Event（item_type=child_thread）。 */
 itemCreatedEvent: ThreadEvent;
}

/** 默认委派深度上限（delegationPolicyJson.maxDepth 缺失时使用）。 */
const DEFAULT_MAX_DELEGATION_DEPTH = 2;

/**
 * 事务内 Delegate Child Thread：创建子 Thread + delegate 关系 + 两条 Event。
 *
 * 流程：
 * 1. SELECT FOR UPDATE 父 Thread（校验 active + owner）
 * 2. 校验父 Invocation 存在、属于父 Thread、executionState=running
 * 3. 校验目标 Agent 存在、同租户、lifecycle=enabled
 * 4. 读取父 Agent + currentRevision → delegationPolicyJson
 * 5. 校验 allowedTargets 包含 targetAgentId
 * 6. 计算当前委派深度（递归向上查 delegate 关系），校验 depth+1 <= maxDepth
 * 7. 校验 budgetPolicyJson（非负）
 * 8. 校验 contextTransferPolicyJson（必拒集合）
 * 9. INSERT 子 Thread（lifecycleState=active, primaryAgentId=targetAgentId）
 * 10. INSERT 子 Thread 的 thread.created Event（sequence=1, payload delegate_child=true）
 * 11. allocateEventSequences(父) → INSERT 父 Thread 的 child_thread.created Event
 * 12. INSERT ThreadRelation（relation_type=delegate, state=active, sourceInvocationId, targetAgentId, policy）
 * 13. UPDATE 父 Thread.lastActivityAt
 *
 * 隐藏式 404：父 Thread 跨租户/不存在 → ThreadNotFoundError。
 */
export async function delegateChildThread(
 params: DelegateChildThreadParams,
): Promise<DelegateChildThreadResult> {
 const childThreadId = randomUUID();
 const childCreatedEventId = randomUUID();
 const relationId = randomUUID();
 const now = new Date();
 const actorType: ThreadEventActorType = params.actorType ?? "user";

 // ─── 事务外预校验：父 Invocation + 目标 Agent + delegationPolicy（避免长事务持锁） ───
 const [parentInvocation] = await db
 .select()
 .from(invocationTable)
 .where(
 and(
 eq(invocationTable.tenantId, params.tenantId),
 eq(invocationTable.id, params.parentInvocationId),
 ),
 )
 .limit(1);

 if (!parentInvocation) {
 // 隐藏式 404：不暴露父 Invocation 存在性，统一抛 ThreadNotFoundError 由 Route 层映射
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 if (parentInvocation.threadId !== params.parentThreadId) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 if (parentInvocation.executionState !== "running") {
 throw new ParentInvocationNotActiveError(
 params.parentInvocationId,
 parentInvocation.executionState,
 );
 }

 const targetAgent = await getAgentById(params.tenantId, params.targetAgentId);
 if (!targetAgent || targetAgent.lifecycleState !== "enabled") {
 throw new DelegationNotAllowedError("<unknown>", params.targetAgentId);
 }

 // 读取父 Agent + currentRevision 以获取 delegationPolicyJson
 const parentThread = await db
 .select()
 .from(threadTable)
 .where(
 and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.parentThreadId)),
 )
 .limit(1);
 if (!parentThread[0]) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 const parentAgent = await getAgentById(params.tenantId, parentThread[0].primaryAgentId);
 if (!parentAgent) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 const parentRevision = parentAgent.currentRevisionId
 ? await getRevisionById(parentAgent.currentRevisionId)
 : null;
 const delegationPolicy = (parentRevision?.delegationPolicyJson ?? {}) as {
 allowedTargets?: string[];
 maxDepth?: number;
 };
 const allowedTargets = delegationPolicy.allowedTargets ?? [];
 if (!allowedTargets.includes(params.targetAgentId)) {
 throw new DelegationNotAllowedError(parentAgent.id, params.targetAgentId);
 }

 // 计算当前委派深度（递归向上查 delegate 关系；root depth=0，子 depth=parent.depth+1）
 const currentDepth = await computeDelegationDepth(params.parentThreadId);
 const maxDepth = delegationPolicy.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
 if (currentDepth + 1 > maxDepth) {
 throw new DelegationDepthExceededError(params.parentThreadId, currentDepth + 1, maxDepth);
 }

 // 校验 budgetPolicyJson（非负）
 if (params.budgetPolicyJson) {
 validateBudgetPolicy(params.parentThreadId, params.budgetPolicyJson);
 }

 // 校验 contextTransferPolicyJson（必拒集合；DB 查询父 Thread 当前 Items）
 if (params.contextTransferPolicyJson) {
 await validateContextTransferPolicy(
 params.tenantId,
 params.parentThreadId,
 params.contextTransferPolicyJson,
 );
 }

 // ─── 事务：写子 Thread + Event + 父 Event + Relation + ChildThread Item ───
 const {
 parentEvent: parentChildThreadCreatedEvent,
 childThreadItemId,
 itemCreatedEventId,
 } = await db.transaction(async (tx) => {
 // 1. SELECT FOR UPDATE 父 Thread（校验 active + owner）
 const [parent] = await tx
 .select()
 .from(threadTable)
 .where(
 and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.parentThreadId)),
 )
 .for("update")
 .limit(1);

 if (!parent) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 if (parent.ownerUserId !== params.ownerUserId) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }
 if (parent.lifecycleState !== "active") {
 throw new ThreadNotFoundError(params.parentThreadId);
 }

 // 2. 创建子 Thread（新 id，ownerUserId 相同，primaryAgentId=targetAgentId，独立 Workspace）
 const childTitle = params.title ?? parent.title ?? null;
 await tx.insert(threadTable).values({
 id: childThreadId,
 tenantId: params.tenantId,
 ownerUserId: parent.ownerUserId,
 primaryAgentId: params.targetAgentId,
 title: childTitle,
 defaultWorkspaceId: null, // child 获得独立 Workspace（§9 行 60-66）
 defaultModelRef: parent.defaultModelRef,
 defaultEnvironmentDefinitionId: parent.defaultEnvironmentDefinitionId,
 lifecycleState: "active",
 lastActivityAt: now,
 lastTurnSequence: 0,
 lastItemSequence: 0,
 lastEventSequence: 1, // thread.created 占 sequence=1
 pendingQueueVersionNo: 1,
 versionNo: 1,
 createdAt: now,
 updatedAt: now,
 });

 // 3. 写子 Thread 的 thread.created Event（payload 标记 delegate_child=true）
 await tx.insert(threadEventTable).values({
 id: childCreatedEventId,
 threadId: childThreadId,
 eventSequence: 1,
 eventType: "thread.created",
 schemaVersion: 1,
 turnId: null,
 itemId: null,
 invocationId: null,
 actorType,
 actorId: params.actorId ?? params.ownerUserId,
 payloadJson: {
 // 投影上下文（thread_list_projection 需要 tenant_id/owner_user_id 创建行）
 tenant_id: params.tenantId,
 owner_user_id: parent.ownerUserId,
 primary_agent_id: params.targetAgentId,
 title: childTitle,
 default_workspace_id: null,
 default_model_ref: parent.defaultModelRef,
 // Delegate 标记：本 Thread 是 delegate 子 Thread
 delegate_child: true,
 parent_thread_id: params.parentThreadId,
 parent_invocation_id: params.parentInvocationId,
 },
 idempotencyKey: params.idempotencyKey ?? null,
 occurredAt: now,
 ingestedAt: now,
 });

 // 4. 在父 Thread 的事件流中写 child_thread.created Event
 // 先锁定父 Thread 行原子分配 sequence（allocateEventSequences 内部 SELECT FOR UPDATE）
 const parentEventSeq = await allocateEventSequences(tx, params.parentThreadId, 1);
 const parentEvent = await insertThreadEvent(tx, params.parentThreadId, parentEventSeq, {
 eventType: "child_thread.created",
 invocationId: params.parentInvocationId,
 actorType,
 actorId: params.actorId ?? params.ownerUserId,
 payload: {
 // required_refs（§契约）：invocation_id 标识委派源
 turn_id: null,
 item_id: null,
 invocation_id: params.parentInvocationId,
 child_thread_id: childThreadId,
 parent_thread_id: params.parentThreadId,
 relation_type: "delegate",
 target_agent_id: params.targetAgentId,
 task_payload_ref: params.taskPayloadRef ?? null,
 task_payload_hash: params.taskPayloadHash ?? null,
 context_transfer_policy: params.contextTransferPolicyJson ?? null,
 budget_policy: params.budgetPolicyJson ?? null,
 },
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });

 // 5. 更新父 Thread 的 lastActivityAt（lastEventSequence 已在 allocateEventSequences 内更新）
 await tx
 .update(threadTable)
 .set({
 lastActivityAt: now,
 updatedAt: now,
 })
 .where(eq(threadTable.id, params.parentThreadId));

 // 6. 创建 ThreadRelation（relation_type=delegate, parent=源, child=新, state=active）
 // 直接在事务内 INSERT，跳过 createThreadRelation helper（该 helper 用 db 而非 tx）
 // itemId 在第 7 步创建 ChildThread Item 后回填
 const childThreadItemId = randomUUID();
 await tx.insert(threadRelationTable).values({
 id: relationId,
 parentThreadId: params.parentThreadId,
 childThreadId: childThreadId,
 relationType: "delegate",
 sourceTurnId: null, // delegate 不强制 sourceTurnId
 sourceItemId: null,
 sourceInvocationId: params.parentInvocationId,
 targetAgentId: params.targetAgentId,
 taskPayloadRef: params.taskPayloadRef ?? null,
 taskPayloadHash: params.taskPayloadHash ?? null,
 contextTransferPolicyJson: (params.contextTransferPolicyJson ?? null) as Record<
 string,
 unknown
 > | null,
 budgetPolicyJson: (params.budgetPolicyJson ?? null) as Record<string, unknown> | null,
 budgetUsedJson: null, // S09-C02：累积用量初始为空，由 recordChildThreadBudgetUsage 增量更新
 relationState: "active", // 事务完成即 active
 itemId: childThreadItemId, // S09-C02：同事务回填 ChildThread Item id
 resultItemId: null,
 resultRef: null,
 resultHash: null,
 createdAt: now,
 completedAt: null,
 });

 // 7. 创建父 Thread 中的 child_thread Item（S09-C02：父 Turn 只得到一个 child_thread Item）
 // itemState=pending（终态由 projectChildThreadResult 推进到 completed/failed/cancelled）
 // contentJson 含 relation_id / child_thread_id / target_agent_id / state=active
 const itemSequence = await allocateItemSequence(tx, params.parentThreadId);
 const childThreadItemContent: ChildThreadItemContent = {
 relationId,
 childThreadId,
 targetAgentId: params.targetAgentId,
 taskPayloadRef: params.taskPayloadRef ?? null,
 taskPayloadHash: params.taskPayloadHash ?? null,
 state: "active",
 };
 const childThreadItemHash = computeEventPayloadHash(
 childThreadItemContent as unknown as Record<string, unknown>,
 );
 await tx.insert(threadItemTable).values({
 id: childThreadItemId,
 threadId: params.parentThreadId,
 // delegate ChildThread Item 绑定父 Invocation 所属 Turn（schema notNull）；
 // 父 Invocation 为 Job 触发时退化为空字符串占位（无对应 Turn）。
 turnId: parentInvocation.turnId ?? "",
 itemSequence,
 itemType: "child_thread",
 itemState: "pending",
 authorType: actorType === "user" ? "user" : "system",
 authorId: params.actorId ?? params.ownerUserId ?? null,
 contentJson: childThreadItemContent as unknown as Record<string, unknown>,
 contentHash: childThreadItemHash,
 contextPolicy: "include", // 父 Turn 可见
 invocationId: params.parentInvocationId,
 supersededByItemId: null,
 createdAt: now,
 updatedAt: now,
 });

 // 8. 写父 Thread 的 item.created Event（payload 含 item_type=child_thread）
 // idempotencyKey 不传：避免与 child_thread.created Event 在同 Thread 内
 // UNIQUE(threadId, idempotencyKey) 冲突（同一 delegate 操作多条 Event 共享
 // correlationId 用于关联，idempotencyKey 仅 child_thread.created 持有）。
 const itemCreatedEventSeq = await allocateEventSequences(tx, params.parentThreadId, 1);
 const itemCreatedEvent = await insertThreadEvent(
 tx,
 params.parentThreadId,
 itemCreatedEventSeq,
 {
 eventType: "item.created",
 itemId: childThreadItemId,
 invocationId: params.parentInvocationId,
 actorType,
 actorId: params.actorId ?? params.ownerUserId,
 payload: {
 item_type: "child_thread",
 item_sequence: itemSequence,
 item_state: "pending",
 author_type: actorType === "user" ? "user" : "system",
 item_summary: `delegate → ${params.targetAgentId}`,
 relation_id: relationId,
 child_thread_id: childThreadId,
 target_agent_id: params.targetAgentId,
 parent_thread_id: params.parentThreadId,
 invocation_id: params.parentInvocationId,
 },
 correlationId: params.correlationId,
 },
 );

 return {
 parentEvent,
 childThreadItemId,
 itemCreatedEventId: itemCreatedEvent.id,
 };
 });

 // 事务外回读
 const [childThread] = await db
 .select()
 .from(threadTable)
 .where(eq(threadTable.id, childThreadId))
 .limit(1);
 if (!childThread) {
 throw new Error(`delegateChildThread: 子 Thread 行未找到（id=${childThreadId}）`);
 }

 const [relation] = await db
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, relationId))
 .limit(1);
 if (!relation) {
 throw new Error(`delegateChildThread: ThreadRelation 行未找到（id=${relationId}）`);
 }

 const [childCreatedEvent] = await db
 .select()
 .from(threadEventTable)
 .where(eq(threadEventTable.id, childCreatedEventId))
 .limit(1);
 if (!childCreatedEvent) {
 throw new Error(
 `delegateChildThread: 子 thread.created Event 行未找到（id=${childCreatedEventId}）`,
 );
 }

 const [childThreadItem] = await db
 .select()
 .from(threadItemTable)
 .where(eq(threadItemTable.id, childThreadItemId))
 .limit(1);
 if (!childThreadItem) {
 throw new Error(`delegateChildThread: ChildThread Item 行未找到（id=${childThreadItemId}）`);
 }

 const [itemCreatedEvent] = await db
 .select()
 .from(threadEventTable)
 .where(eq(threadEventTable.id, itemCreatedEventId))
 .limit(1);
 if (!itemCreatedEvent) {
 throw new Error(`delegateChildThread: item.created Event 行未找到（id=${itemCreatedEventId}）`);
 }

 return {
 thread: childThread,
 relation,
 childCreatedEvent,
 parentChildThreadCreatedEvent,
 childThreadItem,
 itemCreatedEvent,
 };
}

/**
 * 计算指定 Thread 的当前委派深度。
 * - root Thread（无 delegate 关系作为 child）depth=0
 * - 第 N 级 delegate 子 Thread depth=N
 *
 * 通过递归向上查询 ThreadRelation.relationType=delegate 链实现。
 * 防环：visited Set 拒绝重复访问。
 */
export async function computeDelegationDepth(threadId: string): Promise<number> {
 let depth = 0;
 let currentThreadId = threadId;
 const visited = new Set<string>();
 while (currentThreadId && !visited.has(currentThreadId)) {
 visited.add(currentThreadId);
 const [parentRel] = await db
 .select()
 .from(threadRelationTable)
 .where(
 and(
 eq(threadRelationTable.childThreadId, currentThreadId),
 eq(threadRelationTable.relationType, "delegate"),
 ),
 )
 .limit(1);
 if (!parentRel) break;
 depth += 1;
 currentThreadId = parentRel.parentThreadId;
 }
 return depth;
}

/**
 * 校验 budgetPolicyJson：所有数值字段必须为非负数。
 * @throws ChildBudgetExceededError 任一字段为负或非法
 */
function validateBudgetPolicy(parentThreadId: string, policy: DelegationBudgetPolicy): void {
 if (policy.maxTokens !== undefined && policy.maxTokens < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxTokens 不能为负数",
 );
 }
 if (policy.maxWallClockMs !== undefined && policy.maxWallClockMs < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxWallClockMs 不能为负数",
 );
 }
 if (policy.maxCost !== undefined && policy.maxCost < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxCost 不能为负数",
 );
 }
 if (policy.maxToolCalls !== undefined && policy.maxToolCalls < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxToolCalls 不能为负数",
 );
 }
 if (policy.maxChildCount !== undefined && policy.maxChildCount < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxChildCount 不能为负数",
 );
 }
 if (policy.maxSandboxSeconds !== undefined && policy.maxSandboxSeconds < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxSandboxSeconds 不能为负数",
 );
 }
 if (policy.maxArtifactBytes !== undefined && policy.maxArtifactBytes < 0) {
 throw new ChildBudgetExceededError(
 parentThreadId,
 policy as Record<string, unknown>,
 "maxArtifactBytes 不能为负数",
 );
 }
}

/**
 * 校验 contextTransferPolicyJson：必拒集合不能列入 includeItemIds。
 * 必拒条件（§16 行 580-585）：
 * - itemType=credential（员工凭据）
 * - contextPolicy=sensitive（隐藏思维链）
 * - contentJson 中含未授权本地路径（路径前缀 file:///var/secrets 等）
 *
 * @throws ChildContextNotAllowedError includeItemIds 含必拒 Item
 */
async function validateContextTransferPolicy(
 tenantId: string,
 parentThreadId: string,
 policy: ContextTransferPolicy,
): Promise<void> {
 if (!policy.includeItemIds || policy.includeItemIds.length === 0) return;

 const deniedItemIds: string[] = [];
 const deniedReasons: string[] = [];

 for (const itemId of policy.includeItemIds) {
 const [item] = await db
 .select()
 .from(threadItemTable)
 .where(and(eq(threadItemTable.threadId, parentThreadId), eq(threadItemTable.id, itemId)))
 .limit(1);

 if (!item) continue; // 不存在的 Item 不在必拒集合中，由后续投影器忽略
 // 必拒条件 1：contextPolicy=sensitive（隐藏思维链）
 if (item.contextPolicy === "sensitive") {
 deniedItemIds.push(itemId);
 deniedReasons.push(`Item ${itemId} contextPolicy=sensitive，属隐藏思维链必拒集合`);
 continue;
 }
 // 必拒条件 2：contentJson 中含未授权本地路径（简化：检测 file:///var/secrets 前缀）
 const contentStr = JSON.stringify(item.contentJson ?? {});
 if (contentStr.includes("file:///var/secrets") || contentStr.includes("file:///etc/secrets")) {
 deniedItemIds.push(itemId);
 deniedReasons.push(`Item ${itemId} contentJson 含未授权本地 secrets 路径`);
 }
 }

 if (deniedItemIds.length > 0) {
 throw new ChildContextNotAllowedError(parentThreadId, deniedItemIds, deniedReasons.join("; "));
 }
}

// ─── 查询函数 ───────────────────────────────────────────────

/** 按 id 获取 delegate ThreadRelation。不存在返回 null。 */
export async function getChildThreadRelation(relationId: string): Promise<ThreadRelation | null> {
 const [row] = await db
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, relationId))
 .limit(1);
 return row ?? null;
}

/**
 * 列出某父 Invocation 的所有 delegate 关系（跨租户隔离由 parent Invocation 的 tenantId 保证）。
 */
export async function getRelationsByParentInvocation(
 tenantId: string,
 parentInvocationId: string,
): Promise<ThreadRelation[]> {
 return db
 .select()
 .from(threadRelationTable)
 .where(
 and(
 eq(threadRelationTable.sourceInvocationId, parentInvocationId),
 eq(threadRelationTable.relationType, "delegate"),
 ),
 )
 .orderBy(asc(threadRelationTable.createdAt));
}

/**
 * 列出某父 Thread 的所有 delegate 关系（按 createdAt 升序）。
 */
export async function getDelegateRelationsByParentThread(
 tenantId: string,
 parentThreadId: string,
): Promise<ThreadRelation[]> {
 return db
 .select()
 .from(threadRelationTable)
 .where(
 and(
 eq(threadRelationTable.parentThreadId, parentThreadId),
 eq(threadRelationTable.relationType, "delegate"),
 ),
 )
 .orderBy(asc(threadRelationTable.createdAt));
}

/**
 * 读取 delegate Child Thread 的结果（resultItemId/resultRef/resultHash）。
 * 仅 completed 状态的 relation 才有结果；其他状态返回 null。
 *
 * @returns relation 终态时返回 { resultItem, resultRef, resultHash }；非终态返回 null。
 */
export async function getChildThreadResult(relationId: string): Promise<{
 relation: ThreadRelation;
 resultItem: ThreadItem | null;
} | null> {
 const relation = await getChildThreadRelation(relationId);
 if (!relation) return null;
 if (relation.relationState !== "completed") {
 return { relation, resultItem: null };
 }
 if (!relation.resultItemId) {
 return { relation, resultItem: null };
 }
 const [item] = await db
 .select()
 .from(threadItemTable)
 .where(eq(threadItemTable.id, relation.resultItemId))
 .limit(1);
 return { relation, resultItem: item ?? null };
}

// ─── 取消请求 ─────────────────────────────────────────────

/** requestChildThreadCancellation 返回结果。 */
export interface RequestCancellationResult {
 relation: ThreadRelation;
 /** 父 Thread 的 child_thread.cancel_requested Event；幂等命中时为 null。 */
 cancelRequestedEvent: ThreadEvent | null;
 /**
 * 入队的 cancel InvocationCommand 行（S09-C02）。
 * 幂等命中（relation 已是 cancel_requested）时为 null。
 * commandState=queued，由 Runtime dispatch 后转为 dispatched/acknowledged/failed。
 */
 cancelCommand: InvocationCommand | null;
 /** 是否真正发起了取消请求（false = 幂等命中已是 cancel_requested）。 */
 initiated: boolean;
}

/**
 * 请求取消 delegate Child Thread（relation_state active → cancel_requested）。
 *
 * 流程：
 * 1. SELECT FOR UPDATE 父 Thread（锁定事件流）
 * 2. SELECT relation，校验存在 + 属于该父 Thread
 * 3. 校验 relation_state ∈ {active, cancel_requested}：
 * - active → cancel_requested（initiated=true）
 * - cancel_requested → 幂等返回（initiated=false）
 * - 终态（completed/failed/cancelled）→ ChildThreadAlreadyTerminalError
 * 4. UPDATE relation_state=cancel_requested
 * 5. 查询子 Thread 当前 active Invocation（running/waiting_user）作为 cancel command 目标
 * 6. INSERT InvocationCommand（commandType=cancel，commandPayloadJson={relation_id, reason_code}）
 * 7. allocateEventSequences(父) → INSERT child_thread.cancel_requested Event
 *
 * 注意（§9 行 412-417）：取消请求 ≠ 已取消。本函数仅发起请求 + 入队 cancel command；
 * relation_state 由 active → cancel_requested → cancelled 的最终落库由
 * Runtime/应用服务在执行确认后调用 finalizeChildThreadCancellation 完成。
 */
export async function requestChildThreadCancellation(params: {
 tenantId: string;
 parentThreadId: string;
 relationId: string;
 reason?: string;
 /**
 * 取消原因码（12 文档 行 282）：
 * - PARENT_NO_LONGER_NEEDS_RESULT：父 Agent 不再需要结果
 * - PARENT_CANCELLED：父 Invocation 被取消
 * - BUDGET_EXHAUSTED：预算耗尽
 */
 reasonCode?: string;
 actorType?: ThreadEventActorType;
 actorId?: string;
 idempotencyKey?: string;
 correlationId?: string;
}): Promise<RequestCancellationResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "user";
 const now = new Date();

 const result = await db.transaction(async (tx) => {
 // 1. SELECT FOR UPDATE 父 Thread
 const [parent] = await tx
 .select()
 .from(threadTable)
 .where(
 and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, params.parentThreadId)),
 )
 .for("update")
 .limit(1);
 if (!parent) {
 throw new ThreadNotFoundError(params.parentThreadId);
 }

 // 2. SELECT relation（锁定行）
 const [relation] = await tx
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, params.relationId))
 .for("update")
 .limit(1);
 if (!relation) {
 throw new ThreadNotFoundError(params.relationId);
 }
 if (relation.parentThreadId !== params.parentThreadId) {
 throw new ThreadNotFoundError(params.relationId);
 }

 // 3. 校验 relation_state
 const terminalStates: ThreadRelation["relationState"][] = ["completed", "failed", "cancelled"];
 if (terminalStates.includes(relation.relationState)) {
 throw new ChildThreadAlreadyTerminalError(
 params.relationId,
 relation.childThreadId,
 relation.relationState,
 );
 }

 // 幂等：已是 cancel_requested → 直接返回（不重复写 Event / 不重复入队 cancel command）
 if (relation.relationState === "cancel_requested") {
 return { relation, cancelRequestedEvent: null, cancelCommand: null, initiated: false };
 }

 // 4. UPDATE relation_state=cancel_requested
 await tx
 .update(threadRelationTable)
 .set({ relationState: "cancel_requested" })
 .where(eq(threadRelationTable.id, params.relationId));

 // 5. 查询子 Thread 当前 active Invocation（running/waiting_user）作为 cancel command 目标
 // 若子 Invocation 已终态（completed/failed/cancelled/lost），cancel command 目标为空，
 // 由 finalizeChildThreadCancellation 直接推进 relation 到 cancelled。
 const [childInvocation] = await tx
 .select()
 .from(invocationTable)
 .where(
 and(
 eq(invocationTable.tenantId, params.tenantId),
 eq(invocationTable.threadId, relation.childThreadId),
 ),
 )
 .orderBy(desc(invocationTable.invocationSequence))
 .limit(1);

 let cancelCommandId: string | null = null;
 if (childInvocation && !INVOCATION_TERMINAL_STATES.includes(childInvocation.executionState)) {
 // 6. INSERT InvocationCommand（commandType=cancel）
 cancelCommandId = randomUUID();
 const commandPayload = {
 relation_id: params.relationId,
 child_thread_id: relation.childThreadId,
 parent_thread_id: params.parentThreadId,
 reason: params.reason ?? null,
 reason_code: params.reasonCode ?? null,
 };
 const commandPayloadHash = computeEventPayloadHash(commandPayload);
 await tx.insert(invocationCommandTable).values({
 id: cancelCommandId,
 invocationId: childInvocation.id,
 threadId: relation.childThreadId, // cancel command 入队到子 Thread 流
 turnId: childInvocation.turnId ?? null,
 commandType: "cancel",
 commandPayloadJson: commandPayload,
 commandPayloadHash,
 commandState: "queued",
 runtimeExecutionRef: null,
 idempotencyKey: params.idempotencyKey ?? null,
 errorCode: null,
 errorMessage: null,
 dispatchedAt: null,
 acknowledgedAt: null,
 failedAt: null,
 });
 }

 // 7. 写父 Thread 的 child_thread.cancel_requested Event
 const parentEventSeq = await allocateEventSequences(tx, params.parentThreadId, 1);
 const cancelEvent = await insertThreadEvent(tx, params.parentThreadId, parentEventSeq, {
 eventType: "child_thread.cancel_requested",
 invocationId: relation.sourceInvocationId ?? undefined,
 actorType,
 actorId: params.actorId ?? undefined,
 payload: {
 relation_id: params.relationId,
 child_thread_id: relation.childThreadId,
 parent_thread_id: params.parentThreadId,
 reason: params.reason ?? null,
 reason_code: params.reasonCode ?? null,
 command_id: cancelCommandId,
 },
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });

 // 8. 更新父 Thread.lastActivityAt
 await tx
 .update(threadTable)
 .set({ lastActivityAt: now, updatedAt: now })
 .where(eq(threadTable.id, params.parentThreadId));

 return {
 relation: { ...relation, relationState: "cancel_requested" as const },
 cancelRequestedEvent: cancelEvent,
 cancelCommandId,
 initiated: true,
 };
 });

 // 事务外回读 cancel command 行（若有）
 let cancelCommand: InvocationCommand | null = null;
 if (result.cancelCommandId) {
 const [cmd] = await db
 .select()
 .from(invocationCommandTable)
 .where(eq(invocationCommandTable.id, result.cancelCommandId))
 .limit(1);
 cancelCommand = cmd ?? null;
 }

 return {
 relation: result.relation,
 cancelRequestedEvent: result.cancelRequestedEvent,
 cancelCommand,
 initiated: result.initiated,
 };
}

// ─── S09-C02 子 Thread 结果投影 ───────────────────────────

/**
 * 子 Thread 终态 → 父 Thread child_thread Item 投影 result（12 文档 行 263）。
 *
 * 事实源：
 * - 05 文档 §9 行 412-417：子 Runtime 不能直接回写父 Thread；投影由平台根据子 Thread 终态生成。
 * - 12 文档 行 263：父 Turn 只得到一个 child_thread Item 和结构化摘要，不复制子会话全文。
 * - 12 文档 行 294：取消协议；relation_state 由 active/cancel_requested → completed。
 *
 * 流程：
 * 1. 事务外预查询子 Thread 最终 agent_message / job_result Item（若 finalItem 未传）
 * 2. 事务内 SELECT FOR UPDATE 父 Thread（锁定事件流）
 * 3. SELECT FOR UPDATE relation（锁定行）
 * 4. 校验 relation 存在 + 跨租户隔离 + relation_state ∈ {active, cancel_requested}
 * （cancel_requested 也允许投影：取消请求后子 Thread 可能仍正常完成）
 * 5. 校验 relation.itemId 非空（delegateChildThread 必须已回填）
 * 6. 校验子 Thread 当前 active Invocation 已终态（completed/failed/cancelled/lost）
 * （这是 result 投影的前置条件；running/waiting_user 拒绝）
 * 7. 计算 result_hash = computeEventPayloadHash(finalItem.contentJson)
 * 8. 构造 result_ref = `result:child-thread:{relation.id}:1`
 * 9. UPDATE 父 child_thread Item: itemState=completed, contentJson 加 result 字段
 * 10. UPDATE relation: resultItemId, resultRef, resultHash, completedAt, relationState=completed
 * 11. allocateEventSequences(父) → INSERT child_thread.completed Event
 *
 * 幂等：relation 已 completed → 返回当前状态（不重复写 Event）。
 *
 * @throws ChildThreadResultProjectionError relation 不存在/状态非终态/无最终 Item/itemId 为空
 * @throws ChildInvocationNotTerminalError 子 Invocation 未终态（running/waiting_user）
 * @throws ChildThreadAlreadyTerminalError relation 已 failed/cancelled（不可恢复到 completed）
 */
export async function projectChildThreadResult(
 params: ProjectChildThreadResultParams,
): Promise<ProjectChildThreadResultResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";
 const now = new Date();

 // ─── 事务外预查询子 Thread 最终 Item（若未传） ───
 let finalItem: ThreadItem | null = params.finalItem ?? null;
 if (!finalItem) {
 // 先查 relation 以拿到 childThreadId
 const relation = await getChildThreadRelation(params.relationId);
 if (!relation) {
 throw new ChildThreadResultProjectionError(params.relationId, "relation 不存在");
 }
 finalItem = await findLatestCompletedChildItem(relation.childThreadId);
 }

 const result = await db.transaction(async (tx) => {
 // 2. SELECT FOR UPDATE 父 Thread（锁定事件流）
 const [relation] = await tx
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, params.relationId))
 .for("update")
 .limit(1);
 if (!relation) {
 throw new ChildThreadResultProjectionError(params.relationId, "relation 不存在");
 }

 const [parent] = await tx
 .select()
 .from(threadTable)
 .where(
 and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, relation.parentThreadId)),
 )
 .for("update")
 .limit(1);
 if (!parent) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 `父 Thread ${relation.parentThreadId} 跨租户不可见`,
 );
 }

 // 4. 校验 relation_state
 if (relation.relationState === "completed") {
 // 幂等返回：child_thread.completed Event 已写过，由调用方决定如何回读
 return { relation, idempotent: true as const, item: null, completedEvent: null };
 }
 if (relation.relationState === "failed" || relation.relationState === "cancelled") {
 throw new ChildThreadAlreadyTerminalError(
 params.relationId,
 relation.childThreadId,
 relation.relationState,
 );
 }
 // active / cancel_requested 允许投影

 // 5. 校验 relation.itemId 非空
 if (!relation.itemId) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "relation.itemId 为空（delegateChildThread 未回填 ChildThread Item）",
 );
 }

 // 6. 校验子 Thread 当前 active Invocation 已终态
 const [childInvocation] = await tx
 .select()
 .from(invocationTable)
 .where(eq(invocationTable.threadId, relation.childThreadId))
 .orderBy(desc(invocationTable.invocationSequence))
 .limit(1);
 if (childInvocation && !INVOCATION_TERMINAL_STATES.includes(childInvocation.executionState)) {
 throw new ChildInvocationNotTerminalError(childInvocation.id, childInvocation.executionState);
 }

 // 7. 计算 result_hash
 if (!finalItem) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "子 Thread 无 completed 状态的 agent_message / job_result Item 可投影",
 );
 }
 const finalContentJson = (finalItem.contentJson ?? {}) as Record<string, unknown>;
 const resultHash = computeEventPayloadHash(finalContentJson);
 const resultRef = `result:child-thread:${relation.id}:1`;

 // 8. 提取 summary（若未传则从 finalItem.contentJson.text 提取）
 const summary =
 params.summary ??
 (typeof finalContentJson.text === "string"
 ? finalContentJson.text
 : typeof finalContentJson.summary === "string"
 ? finalContentJson.summary
 : null);

 // 9. UPDATE 父 child_thread Item: itemState=completed, contentJson 加 result 字段
 const childThreadItemContent: ChildThreadItemContent = {
 relationId: relation.id,
 childThreadId: relation.childThreadId,
 targetAgentId: relation.targetAgentId ?? "",
 taskPayloadRef: relation.taskPayloadRef,
 taskPayloadHash: relation.taskPayloadHash,
 state: "completed",
 resultRef,
 resultHash,
 summary,
 artifactIds: params.artifactIds ?? [],
 completedAt: now.toISOString(),
 };
 const childThreadItemHash = computeEventPayloadHash(
 childThreadItemContent as unknown as Record<string, unknown>,
 );
 await tx
 .update(threadItemTable)
 .set({
 itemState: "completed",
 contentJson: childThreadItemContent as unknown as Record<string, unknown>,
 contentHash: childThreadItemHash,
 updatedAt: now,
 })
 .where(eq(threadItemTable.id, relation.itemId));

 // 10. UPDATE relation: resultItemId, resultRef, resultHash, completedAt, relationState=completed
 await tx
 .update(threadRelationTable)
 .set({
 relationState: "completed",
 resultItemId: finalItem.id,
 resultRef,
 resultHash,
 completedAt: now,
 })
 .where(eq(threadRelationTable.id, params.relationId));

 // 11. allocateEventSequences(父) → INSERT child_thread.completed Event
 const parentEventSeq = await allocateEventSequences(tx, relation.parentThreadId, 1);
 const completedEvent = await insertThreadEvent(tx, relation.parentThreadId, parentEventSeq, {
 eventType: "child_thread.completed",
 itemId: relation.itemId,
 invocationId: relation.sourceInvocationId ?? undefined,
 actorType,
 actorId: params.actorId,
 payload: {
 relation_id: relation.id,
 child_thread_id: relation.childThreadId,
 parent_thread_id: relation.parentThreadId,
 result_item_id: finalItem.id,
 result_ref: resultRef,
 result_hash: resultHash,
 summary,
 artifact_ids: params.artifactIds ?? [],
 },
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });

 // 12. 更新父 Thread.lastActivityAt
 await tx
 .update(threadTable)
 .set({ lastActivityAt: now, updatedAt: now })
 .where(eq(threadTable.id, relation.parentThreadId));

 return {
 relation: {
 ...relation,
 relationState: "completed" as const,
 resultItemId: finalItem.id,
 resultRef,
 resultHash,
 completedAt: now,
 },
 idempotent: false as const,
 item: null, // 事务外回读
 completedEvent,
 };
 });

 // 幂等命中：直接回读现有状态
 if (result.idempotent) {
 if (!result.relation.itemId) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "幂等命中但 relation.itemId 为空",
 );
 }
 const [item] = await db
 .select()
 .from(threadItemTable)
 .where(eq(threadItemTable.id, result.relation.itemId))
 .limit(1);
 if (!item) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "幂等回读 ChildThread Item 失败",
 );
 }
 return {
 relation: result.relation,
 item,
 completedEvent: null as unknown as ThreadEvent, // 幂等命中不返回新 Event
 resultRef: result.relation.resultRef ?? "",
 resultHash: result.relation.resultHash ?? "",
 };
 }

 // 事务外回读 item（result.relation.itemId 已在事务内校验非空）
 const itemIdForRead = result.relation.itemId;
 if (!itemIdForRead) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "事务外回读时 relation.itemId 为空",
 );
 }
 const [item] = await db
 .select()
 .from(threadItemTable)
 .where(eq(threadItemTable.id, itemIdForRead))
 .limit(1);
 if (!item) {
 throw new ChildThreadResultProjectionError(
 params.relationId,
 "事务外回读 ChildThread Item 失败",
 );
 }

 return {
 relation: result.relation,
 item,
 completedEvent: result.completedEvent,
 resultRef: result.relation.resultRef ?? "",
 resultHash: result.relation.resultHash ?? "",
 };
}

/**
 * 查询子 Thread 最后一个 completed 状态的 agent_message / job_result Item。
 * 不存在返回 null。
 */
async function findLatestCompletedChildItem(childThreadId: string): Promise<ThreadItem | null> {
 const [row] = await db
 .select()
 .from(threadItemTable)
 .where(
 and(eq(threadItemTable.threadId, childThreadId), eq(threadItemTable.itemState, "completed")),
 )
 .orderBy(desc(threadItemTable.itemSequence))
 .limit(1);
 // 仅接受 agent_message / job_result 类型（其它类型如 user_message 不算最终结果）
 if (!row) return null;
 if (row.itemType !== "agent_message" && row.itemType !== "job_result") return null;
 return row;
}

// ─── S09-C02 取消终态落库 ─────────────────────────────────

/**
 * finalize Child Thread 取消终态落库（05 文档 §16 行 322-333；12 文档 行 294）。
 *
 * 事实源：
 * - 05 文档 §9 行 412-417：取消请求 ≠ 已取消；最终 cancelled 由 Runtime/应用服务在执行确认后落库。
 * - 05 文档 §16 行 333：子任务已产生 unknown effect 时不伪造无副作用取消。
 * - 12 文档 行 294：父子流分别写 child_thread.cancelled Event；子流 payload from_parent=true。
 *
 * 流程：
 * 1. 事务内 SELECT FOR UPDATE 父 Thread（锁定事件流）
 * 2. SELECT FOR UPDATE relation（锁定行）
 * 3. 校验 relation 存在 + 跨租户隔离 + relation_state ∈ {active, cancel_requested}
 * （允许 active → cancelled：应对 race condition，例如子 Thread 自行失败但父尚未发起 cancel）
 * 4. 若 unknownEffect=false：校验子 Thread 当前 active Invocation 已终态
 * （running/waiting_user 不能直接 finalize，调用方必须先请求 cancel）
 * 5. UPDATE relation: relationState=cancelled, completedAt
 * 6. 写父 Thread 的 child_thread.cancelled Event（payload unknown_effect 标记）
 * 7. 写子 Thread 的 child_thread.cancelled Event（payload from_parent=true）
 *
 * 幂等：relation 已 cancelled → 幂等返回（不重复写 Event）。
 *
 * @throws ChildThreadCancellationFinalizeError relation 不在可取消状态/子 Invocation 未终态
 * @throws ChildThreadAlreadyTerminalError relation 已 completed/failed（不可恢复到 cancelled）
 */
export async function finalizeChildThreadCancellation(
 params: FinalizeCancellationParams,
): Promise<FinalizeCancellationResult> {
 const actorType: ThreadEventActorType = params.actorType ?? "system";
 const now = new Date();

 const result = await db.transaction(async (tx) => {
 // 1. SELECT FOR UPDATE 父 Thread
 const [relation] = await tx
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, params.relationId))
 .for("update")
 .limit(1);
 if (!relation) {
 throw new ChildThreadCancellationFinalizeError(params.relationId, "relation 不存在");
 }

 const [parent] = await tx
 .select()
 .from(threadTable)
 .where(
 and(eq(threadTable.tenantId, params.tenantId), eq(threadTable.id, relation.parentThreadId)),
 )
 .for("update")
 .limit(1);
 if (!parent) {
 throw new ChildThreadCancellationFinalizeError(
 params.relationId,
 `父 Thread ${relation.parentThreadId} 跨租户不可见`,
 );
 }

 // 3. 校验 relation_state
 if (relation.relationState === "cancelled") {
 // 幂等返回：child_thread.cancelled Event 已写过
 return { relation, idempotent: true as const, parentEvent: null, childEvent: null };
 }
 if (relation.relationState === "completed" || relation.relationState === "failed") {
 throw new ChildThreadAlreadyTerminalError(
 params.relationId,
 relation.childThreadId,
 relation.relationState,
 );
 }
 // active / cancel_requested 允许 finalize

 // 4. 若 unknownEffect=false：校验子 Thread 当前 active Invocation 已终态
 if (!params.unknownEffect) {
 const [childInvocation] = await tx
 .select()
 .from(invocationTable)
 .where(eq(invocationTable.threadId, relation.childThreadId))
 .orderBy(desc(invocationTable.invocationSequence))
 .limit(1);
 if (childInvocation && !INVOCATION_TERMINAL_STATES.includes(childInvocation.executionState)) {
 throw new ChildInvocationNotTerminalError(
 childInvocation.id,
 childInvocation.executionState,
 );
 }
 }

 // 5. UPDATE relation: relationState=cancelled, completedAt
 await tx
 .update(threadRelationTable)
 .set({
 relationState: "cancelled",
 completedAt: now,
 })
 .where(eq(threadRelationTable.id, params.relationId));

 // 6. 写父 Thread 的 child_thread.cancelled Event
 const parentEventSeq = await allocateEventSequences(tx, relation.parentThreadId, 1);
 const parentEvent = await insertThreadEvent(tx, relation.parentThreadId, parentEventSeq, {
 eventType: "child_thread.cancelled",
 itemId: relation.itemId ?? undefined,
 invocationId: relation.sourceInvocationId ?? undefined,
 actorType,
 actorId: params.actorId,
 payload: {
 relation_id: relation.id,
 child_thread_id: relation.childThreadId,
 parent_thread_id: relation.parentThreadId,
 unknown_effect: params.unknownEffect,
 reason_code: params.reasonCode ?? null,
 },
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });

 // 7. 写子 Thread 的 child_thread.cancelled Event（from_parent=true）
 // 子 Thread 也需要锁定事件流
 const [child] = await tx
 .select()
 .from(threadTable)
 .where(eq(threadTable.id, relation.childThreadId))
 .for("update")
 .limit(1);
 if (!child) {
 throw new ChildThreadCancellationFinalizeError(
 params.relationId,
 `子 Thread ${relation.childThreadId} 不存在`,
 );
 }
 const childEventSeq = await allocateEventSequences(tx, relation.childThreadId, 1);
 const childEvent = await insertThreadEvent(tx, relation.childThreadId, childEventSeq, {
 eventType: "child_thread.cancelled",
 // 子流取消事件不绑定特定 Item / Invocation
 actorType,
 actorId: params.actorId,
 payload: {
 relation_id: relation.id,
 child_thread_id: relation.childThreadId,
 parent_thread_id: relation.parentThreadId,
 from_parent: true,
 unknown_effect: params.unknownEffect,
 reason_code: params.reasonCode ?? null,
 },
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });

 // 8. 更新父子 Thread.lastActivityAt
 const nowDate = now;
 await tx
 .update(threadTable)
 .set({ lastActivityAt: nowDate, updatedAt: nowDate })
 .where(eq(threadTable.id, relation.parentThreadId));
 await tx
 .update(threadTable)
 .set({ lastActivityAt: nowDate, updatedAt: nowDate })
 .where(eq(threadTable.id, relation.childThreadId));

 return {
 relation: { ...relation, relationState: "cancelled" as const, completedAt: now },
 idempotent: false as const,
 parentEvent,
 childEvent,
 };
 });

 if (result.idempotent) {
 // 幂等返回，不返回新 Event
 return {
 relation: result.relation,
 parentCancelledEvent: null as unknown as ThreadEvent,
 childCancelledEvent: null as unknown as ThreadEvent,
 };
 }

 return {
 relation: result.relation,
 parentCancelledEvent: result.parentEvent,
 childCancelledEvent: result.childEvent,
 };
}

// ─── S09-C02 子 Thread 终态协调器 ─────────────────────────

/**
 * 子 Thread 终态协调器：根据子 Thread 终态分派到 projectChildThreadResult 或 finalizeChildThreadCancellation。
 *
 * 事实源：12 文档 行 263、行 294。
 *
 * 流程：
 * 1. 查询 ThreadRelation where childThreadId + relationType=delegate（取第一个）
 * 2. 若不存在 → action="skipped"（子 Thread 非 delegate）
 * 3. 若 relation 已终态（completed/failed/cancelled）→ action="skipped"（幂等）
 * 4. 按 terminalState 分派：
 * - completed → projectChildThreadResult
 * - failed → projectChildThreadResult（在 summary 中标记 failure；itemState 仍 completed
 * 以保持 child_thread Item 状态机一致，failure 信息从 errorCode/errorSummary 提取）
 * - cancelled → finalizeChildThreadCancellation(unknownEffect, reasonCode)
 *
 * 注意：调用方应在 Runtime 确认子 Invocation 进入终态后调用本协调器。
 */
export async function handleChildThreadTerminal(
 params: HandleChildThreadTerminalParams,
): Promise<HandleChildThreadTerminalResult> {
 // 1. 查询 ThreadRelation where childThreadId
 const [relation] = await db
 .select()
 .from(threadRelationTable)
 .where(
 and(
 eq(threadRelationTable.childThreadId, params.childThreadId),
 eq(threadRelationTable.relationType, "delegate"),
 ),
 )
 .limit(1);

 if (!relation) {
 return {
 action: "skipped",
 relation: null as unknown as ThreadRelation,
 };
 }

 // 3. relation 已终态 → 幂等 skipped
 if (
 relation.relationState === "completed" ||
 relation.relationState === "failed" ||
 relation.relationState === "cancelled"
 ) {
 return { action: "skipped", relation };
 }

 // 4. 按 terminalState 分派
 if (params.terminalState === "completed") {
 const projection = await projectChildThreadResult({
 tenantId: params.tenantId,
 relationId: relation.id,
 actorType: params.actorType,
 actorId: params.actorId,
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });
 return { action: "completed", relation: projection.relation, projection };
 }

 if (params.terminalState === "failed") {
 // failed：仍调用 projectChildThreadResult，但通过 summary 传递 failure 信息
 // 也可考虑独立 path：将 itemState 标记 failed；当前简化为 completed + failure summary
 const projection = await projectChildThreadResult({
 tenantId: params.tenantId,
 relationId: relation.id,
 actorType: params.actorType,
 actorId: params.actorId,
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 summary: `[child thread failed] ${params.reasonCode ?? "unknown"}`,
 });
 // 单独更新 relation_state 为 failed（与 completed 区分）
 await db
 .update(threadRelationTable)
 .set({ relationState: "failed" })
 .where(eq(threadRelationTable.id, relation.id));
 const [updated] = await db
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, relation.id))
 .limit(1);
 return {
 action: "failed",
 relation: updated ?? projection.relation,
 projection,
 };
 }

 // cancelled
 const cancellation = await finalizeChildThreadCancellation({
 tenantId: params.tenantId,
 relationId: relation.id,
 unknownEffect: params.unknownEffect ?? false,
 reasonCode: params.reasonCode,
 actorType: params.actorType,
 actorId: params.actorId,
 idempotencyKey: params.idempotencyKey,
 correlationId: params.correlationId,
 });
 return { action: "cancelled", relation: cancellation.relation, cancellation };
}

// ─── S09-C02 预算用量投影 ─────────────────────────────────

/**
 * 累积子 Thread 预算用量到 budgetUsedJson（12 文档 行 245 budget_used）。
 *
 * 事实源：
 * - 05 文档 §18 行 352-362：Child Thread 共享父任务总预算；耗尽由应用服务发出 cancel command。
 * - 12 文档 行 245：budget_used 形状 { tokens, cost, tool_calls, wall_clock_ms, unknown_effect }。
 *
 * 流程：
 * 1. SELECT FOR UPDATE relation（锁定行，避免并发累积丢失更新）
 * 2. 读取现有 budgetUsedJson，与 delta 累积（数值字段相加，unknownEffect 取或）
 * 3. UPDATE relation.budgetUsedJson
 * 4. 比对 budgetPolicyJson 上限：
 * - maxTokens vs tokens
 * - maxCost vs cost
 * - maxWallClockMs vs wallClockMs
 * 若超限返回 exhausted=true + exceededField
 *
 * @throws ThreadNotFoundError relation 不存在
 */
export async function recordChildThreadBudgetUsage(
 params: RecordChildThreadBudgetUsageParams,
): Promise<RecordChildThreadBudgetUsageResult> {
 return db.transaction(async (tx) => {
 const [relation] = await tx
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, params.relationId))
 .for("update")
 .limit(1);
 if (!relation) {
 throw new ThreadNotFoundError(params.relationId);
 }

 // 累积现有用量 + delta
 const current = (relation.budgetUsedJson ?? {}) as Partial<ChildThreadBudgetUsage>;
 const budgetUsed: ChildThreadBudgetUsage = {
 tokens: (current.tokens ?? 0) + (params.delta.tokens ?? 0),
 cost: (current.cost ?? 0) + (params.delta.cost ?? 0),
 toolCalls: (current.toolCalls ?? 0) + (params.delta.toolCalls ?? 0),
 wallClockMs: (current.wallClockMs ?? 0) + (params.delta.wallClockMs ?? 0),
 unknownEffect: Boolean(current.unknownEffect) || Boolean(params.delta.unknownEffect),
 childCount: (current.childCount ?? 0) + (params.delta.childCount ?? 0),
 sandboxSeconds: (current.sandboxSeconds ?? 0) + (params.delta.sandboxSeconds ?? 0),
 artifactBytes: (current.artifactBytes ?? 0) + (params.delta.artifactBytes ?? 0),
 };

 await tx
 .update(threadRelationTable)
 .set({ budgetUsedJson: budgetUsed as unknown as Record<string, unknown> })
 .where(eq(threadRelationTable.id, params.relationId));

 // 比对 budgetPolicyJson 上限（按字段优先级：tokens → cost → tool_calls → wall_clock_ms →
 // child_count → sandbox_seconds → artifact_bytes）
 const policy = (relation.budgetPolicyJson ?? {}) as Partial<DelegationBudgetPolicy>;
 let exhausted = false;
 let exceededField: ChildBudgetExceededField | undefined;

 if (
 policy.maxTokens !== undefined &&
 policy.maxTokens >= 0 &&
 (budgetUsed.tokens ?? 0) > policy.maxTokens
 ) {
 exhausted = true;
 exceededField = "tokens";
 } else if (
 policy.maxCost !== undefined &&
 policy.maxCost >= 0 &&
 (budgetUsed.cost ?? 0) > policy.maxCost
 ) {
 exhausted = true;
 exceededField = "cost";
 } else if (
 policy.maxToolCalls !== undefined &&
 policy.maxToolCalls >= 0 &&
 (budgetUsed.toolCalls ?? 0) > policy.maxToolCalls
 ) {
 exhausted = true;
 exceededField = "tool_calls";
 } else if (
 policy.maxWallClockMs !== undefined &&
 policy.maxWallClockMs >= 0 &&
 (budgetUsed.wallClockMs ?? 0) > policy.maxWallClockMs
 ) {
 exhausted = true;
 exceededField = "wall_clock_ms";
 } else if (
 policy.maxChildCount !== undefined &&
 policy.maxChildCount >= 0 &&
 (budgetUsed.childCount ?? 0) > policy.maxChildCount
 ) {
 exhausted = true;
 exceededField = "child_count";
 } else if (
 policy.maxSandboxSeconds !== undefined &&
 policy.maxSandboxSeconds >= 0 &&
 (budgetUsed.sandboxSeconds ?? 0) > policy.maxSandboxSeconds
 ) {
 exhausted = true;
 exceededField = "sandbox_seconds";
 } else if (
 policy.maxArtifactBytes !== undefined &&
 policy.maxArtifactBytes >= 0 &&
 (budgetUsed.artifactBytes ?? 0) > policy.maxArtifactBytes
 ) {
 exhausted = true;
 exceededField = "artifact_bytes";
 }

 const [updatedRelation] = await tx
 .select()
 .from(threadRelationTable)
 .where(eq(threadRelationTable.id, params.relationId))
 .limit(1);

 return {
 relation: updatedRelation ?? { ...relation, budgetUsedJson: budgetUsed },
 budgetUsed,
 exhausted,
 exceededField,
 };
 });
}

/**
 * 读取子 Thread 当前累积预算用量。不存在 relation 或未累积返回 null/默认值。
 */
export async function getChildThreadBudgetUsage(
 relationId: string,
): Promise<ChildThreadBudgetUsage | null> {
 const relation = await getChildThreadRelation(relationId);
 if (!relation) return null;
 return (relation.budgetUsedJson ?? null) as ChildThreadBudgetUsage | null;
}

/**
 * 校验子 Thread 预算是否已超限（不写入；用于 Runtime 执行前 gate 检查）。
 *
 * @throws ChildThreadBudgetExhaustedError 已超限
 * @throws ThreadNotFoundError relation 不存在
 */
export async function assertChildThreadBudgetNotExhausted(relationId: string): Promise<void> {
 const relation = await getChildThreadRelation(relationId);
 if (!relation) {
 throw new ThreadNotFoundError(relationId);
 }
 const policy = (relation.budgetPolicyJson ?? {}) as Partial<DelegationBudgetPolicy>;
 const used = (relation.budgetUsedJson ?? {}) as Partial<ChildThreadBudgetUsage>;

 if (
 policy.maxTokens !== undefined &&
 policy.maxTokens >= 0 &&
 (used.tokens ?? 0) > policy.maxTokens
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "tokens",
 );
 }
 if (policy.maxCost !== undefined && policy.maxCost >= 0 && (used.cost ?? 0) > policy.maxCost) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "cost",
 );
 }
 if (
 policy.maxToolCalls !== undefined &&
 policy.maxToolCalls >= 0 &&
 (used.toolCalls ?? 0) > policy.maxToolCalls
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "tool_calls",
 );
 }
 if (
 policy.maxWallClockMs !== undefined &&
 policy.maxWallClockMs >= 0 &&
 (used.wallClockMs ?? 0) > policy.maxWallClockMs
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "wall_clock_ms",
 );
 }
 if (
 policy.maxChildCount !== undefined &&
 policy.maxChildCount >= 0 &&
 (used.childCount ?? 0) > policy.maxChildCount
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "child_count",
 );
 }
 if (
 policy.maxSandboxSeconds !== undefined &&
 policy.maxSandboxSeconds >= 0 &&
 (used.sandboxSeconds ?? 0) > policy.maxSandboxSeconds
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "sandbox_seconds",
 );
 }
 if (
 policy.maxArtifactBytes !== undefined &&
 policy.maxArtifactBytes >= 0 &&
 (used.artifactBytes ?? 0) > policy.maxArtifactBytes
 ) {
 throw new ChildThreadBudgetExhaustedError(
 relationId,
 policy as Record<string, unknown>,
 used as Record<string, unknown>,
 "artifact_bytes",
 );
 }
}
