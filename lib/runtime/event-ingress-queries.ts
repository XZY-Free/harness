/**
 * V11 RuntimeEventIngress 仓储（S05-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md （RuntimeEventIngress L486-500）、（事务边界）
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §6（Invocation 生命周期）、§8（Item 投影）
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §4（Runtime Protocol API）
 * - ../v11-agentkit-platform-development-plan/05-runtime-dispatch-and-attempt.md S05-C03
 *
 * 职责：
 * - ingressEventBatch：接收 Runtime 回传候选事件批次，去重 + 序列校验 + 映射到平台状态。
 * - getIngressByProducerEventId / getIngressByProducerSequence / getIngressByInvocation：查询。
 *
 * 关键约束：
 * - UNIQUE(invocationId, producerEventId) + UNIQUE(invocationId, producerSequence) 双幂等键。
 * - 相同 producerEventId/producerSequence 但 payloadHash 不同直接拒绝（hash 冲突，原子终止）。
 * - producerSequence 在整个 Invocation 内连续，不按 Attempt 从 1 重启。
 * - 可重试的 Schema/大小错误不写 ingress 行、不消费序号。
 * - Runtime 不能指定 Thread/Job event sequence、Item id 或直接更新 Item（平台分配）。
 * - 重新分批或部分重放返回原映射，不重复创建 Item/Event。
 * - 正式文本必须在终态前形成 response.completed。
 * - Invocation 终态必须形成公开 Event。
 */
import { randomUUID } from "node:crypto";
import { EventSequenceGapError } from "@/lib/conversations/errors";
import {
 allocateEventSequences,
 allocateItemSequence,
 computeEventPayloadHash,
 insertThreadEvent,
} from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import {
 type ThreadEventActorType,
 type ThreadItem,
 type ThreadItemAuthorType,
 type ThreadItemType,
 threadEventTable,
 threadItemTable,
 threadTable,
 turnTable,
} from "@/lib/persistence/schema/conversation";
import {
 INVOCATION_TERMINAL_STATES,
 type Invocation,
 type RuntimeCandidateEventType,
 type RuntimeEventIngress,
 runtimeEventIngressTable,
} from "@/lib/persistence/schema/runtime";
import {
 EventPayloadHashConflictError,
 IngressInvocationNotFoundError,
 IngressInvocationTerminalError,
} from "@/lib/runtime/errors";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { redactForV11 } from "@/lib/v11/security/unified-redaction";
import { and, asc, eq, gt } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runtime 候选事件输入（来自 Runtime HTTP 请求体）。 */
export interface RuntimeCandidateEvent {
 /** Runtime 稳定事件 id（幂等键 1）。 */
 producer_event_id: string;
 /** Runtime 连续序号（幂等键 2，整个 Invocation 内连续）。 */
 producer_sequence: number;
 /** Runtime Protocol 候选事件类型。 */
 type: string;
 /** payload schema 版本。 */
 schema_version?: number;
 /** 事件发生时间（RFC 3339，仅供诊断，不参与持久化键）。 */
 occurred_at?: string;
 /** 候选负载（结构化、已脱敏）。 */
 payload: Record<string, unknown>;
}

/** ingressEventBatch 入参。 */
export interface IngressEventBatchParams {
 tenantId: string;
 invocationId: string;
 /** 本批次起始 producerSequence（必须等于 events[0].producer_sequence）。 */
 producerSequenceStart: number;
 /** 候选事件列表（按 producer_sequence 升序）。 */
 events: RuntimeCandidateEvent[];
 /** 关联标识（X-Request-Id / traceparent）。 */
 correlationId?: string | null;
}

/** 单个映射事件的结果。 */
export interface MappedEventResult {
 /** Runtime 稳定事件 id。 */
 producerEventId: string;
 /** 平台分配的 ThreadEvent id（mapped 时填；accepted 但未 mapped 时为 null）。 */
 threadEventId: string | null;
 /** 平台分配的 ThreadEvent sequence。 */
 threadSequence: number | null;
 /** 平台分配的 ThreadItem id（无 Item 映射时为 null）。 */
 itemId: string | null;
}

/** ingressEventBatch 返回结果。 */
export interface IngressBatchResult {
 invocationId: string;
 /** 本批次接受到的最大 producerSequence（含）。 */
 acceptedThroughProducerSequence: number;
 /** 每个事件的映射结果（按 producer_sequence 升序）。 */
 mappedEvents: MappedEventResult[];
}

/**
 * 入口：接收 Runtime 候选事件批次。
 *
 * 事务内（）：
 * 1. 查 Invocation（跨租户隔离），不存在 → IngressInvocationNotFoundError。
 * 2. 校验 Invocation 非终态 → IngressInvocationTerminalError。
 * 3. 校验批次非空 + producerSequenceStart 与 events[0] 一致。
 * 4. 锁定 Thread 行（会话模式；Job 模式本阶段不实现）。
 * 5. 对每个事件：
 * - 计算 payloadHash。
 * - 查 UNIQUE(invocationId, producerEventId) 和 UNIQUE(invocationId, producerSequence)。
 * - 已存在且 hash 匹配 → 幂等重放，复用原映射。
 * - 已存在但 hash 不匹配 → EventPayloadHashConflictError（原子终止）。
 * - 不存在 → 加入待处理列表。
 * 6. 校验待处理事件 producerSequence 连续性（producerSequenceStart 开始递增）。
 * 跳过已存在的序号，从最后一个已存在序号 +1 开始连续。
 * 7. 写入新事件 ingress 行（ingressState=accepted）。
 * 8. 按候选类型映射平台状态（创建 Item + 写 ThreadEvent + 更新 Invocation/Turn）。
 * 9. 更新 ingress 行：ingressState=mapped, mappedItemId, mappedThreadEventId, mappedAt。
 * 10. 返回 acceptedThroughProducerSequence + mappedEvents。
 *
 * @throws IngressInvocationNotFoundError Invocation 不存在或跨租户不可见
 * @throws IngressInvocationTerminalError Invocation 已终态
 * @throws EventSequenceGapError producerSequence 不连续（retryable）
 * @throws EventPayloadHashConflictError hash 冲突（不可修复，原子终止）
 */
export async function ingressEventBatch(
 params: IngressEventBatchParams,
): Promise<IngressBatchResult> {
 // 1. 查 Invocation（跨租户隔离）
 const invocation = await getInvocationById(params.tenantId, params.invocationId);
 if (!invocation) {
 throw new IngressInvocationNotFoundError(params.invocationId);
 }

 // 2. 校验非终态
 if (INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) {
 throw new IngressInvocationTerminalError(params.invocationId, invocation.executionState);
 }

 // 3. 校验批次非空
 if (params.events.length === 0) {
 throw new IngressBatchEmptyError(params.invocationId);
 }

 // 4. 校验 producerSequenceStart 与 events[0] 一致
 const firstEvent = params.events[0];
 if (firstEvent && firstEvent.producer_sequence !== params.producerSequenceStart) {
 throw new IngressSequenceStartMismatchError(
 params.invocationId,
 params.producerSequenceStart,
 firstEvent?.producer_sequence ?? 0,
 );
 }

 return await db.transaction(async (tx) => {
 return await processIngressBatch(tx, params, invocation);
 });
}

/** 批次为空错误（route 层映射 400 REQUEST_SCHEMA_INVALID）。 */
export class IngressBatchEmptyError extends Error {
 constructor(public readonly invocationId: string) {
 super(`Ingress 批次为空：invocationId=${invocationId}`);
 this.name = "IngressBatchEmptyError";
 }
}

/** producerSequenceStart 与 events[0].producer_sequence 不匹配（route 层映射 400）。 */
export class IngressSequenceStartMismatchError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly declaredStart: number,
 public readonly firstEventSequence: number,
 ) {
 super(
 `Ingress 序号起点不匹配：invocationId=${invocationId} declared=${declaredStart} firstEvent=${firstEventSequence}`,
 );
 this.name = "IngressSequenceStartMismatchError";
 }
}

/** 未知 candidateType 错误（route 层映射 422 EVENT_SCHEMA_UNSUPPORTED）。 */
export class IngressCandidateTypeUnsupportedError extends Error {
 constructor(
 public readonly invocationId: string,
 public readonly candidateType: string,
 ) {
 super(`Ingress 候选事件类型不支持：invocationId=${invocationId} type=${candidateType}`);
 this.name = "IngressCandidateTypeUnsupportedError";
 }
}

/** 事务内批处理核心逻辑。 */
async function processIngressBatch(
 tx: Tx,
 params: IngressEventBatchParams,
 invocation: Invocation,
): Promise<IngressBatchResult> {
 // 锁定 Thread 行（会话模式）；Job 模式本阶段不实现
 if (!invocation.threadId) {
 throw new IngressInvocationNotFoundError(params.invocationId);
 }
 const [thread] = await tx
 .select({ id: threadTable.id })
 .from(threadTable)
 .where(eq(threadTable.id, invocation.threadId))
 .for("update")
 .limit(1);
 if (!thread) {
 throw new IngressInvocationNotFoundError(params.invocationId);
 }

 const actorType: ThreadEventActorType = "service";
 const correlationId = params.correlationId ?? null;

 // S12-W05：写入前对所有事件 payload 脱敏（防 Secret 落库）
 // redactForV11 组合：禁采字段名 + Secret 正则模式 + 已知明文值（按 invocationId scope）
 const safeEvents: RuntimeCandidateEvent[] = params.events.map((event) => ({
 ...event,
 payload: redactForV11(event.payload, "redacted", {
 scope: params.invocationId,
 }).content as Record<string, unknown>,
 }));

 // 5. 对每个事件：计算 hash + 去重检查 + 构建待处理列表
 const dedupResults: Array<{
 event: RuntimeCandidateEvent;
 hash: string;
 existing: RuntimeEventIngress | null;
 }> = [];

 for (const event of safeEvents) {
 const hash = computeEventPayloadHash(event.payload);

 // 查 UNIQUE(invocationId, producerEventId)
 const [byEventId] = await tx
 .select()
 .from(runtimeEventIngressTable)
 .where(
 and(
 eq(runtimeEventIngressTable.invocationId, params.invocationId),
 eq(runtimeEventIngressTable.producerEventId, event.producer_event_id),
 ),
 )
 .limit(1);

 if (byEventId) {
 // 已存在：检查 hash 是否匹配
 if (byEventId.payloadHash !== hash) {
 throw new EventPayloadHashConflictError(
 params.invocationId,
 event.producer_event_id,
 event.producer_sequence,
 byEventId.payloadHash,
 hash,
 );
 }
 dedupResults.push({ event, hash, existing: byEventId });
 continue;
 }

 // 查 UNIQUE(invocationId, producerSequence)
 const [bySeq] = await tx
 .select()
 .from(runtimeEventIngressTable)
 .where(
 and(
 eq(runtimeEventIngressTable.invocationId, params.invocationId),
 eq(runtimeEventIngressTable.producerSequence, event.producer_sequence),
 ),
 )
 .limit(1);

 if (bySeq) {
 if (bySeq.payloadHash !== hash) {
 throw new EventPayloadHashConflictError(
 params.invocationId,
 event.producer_event_id,
 event.producer_sequence,
 bySeq.payloadHash,
 hash,
 );
 }
 dedupResults.push({ event, hash, existing: bySeq });
 continue;
 }

 dedupResults.push({ event, hash, existing: null });
 }

 // 6. 校验 producerSequence 连续性（整个批次从 producerSequenceStart 开始递增）
 for (let i = 0; i < params.events.length; i++) {
 const event = params.events[i];
 if (!event) continue;
 const expected = params.producerSequenceStart + i;
 if (event.producer_sequence !== expected) {
 throw new EventSequenceGapError(params.invocationId, expected, event.producer_sequence);
 }
 }

 // 7. 写入新事件 ingress 行（ingressState=accepted）
 const newIngressIds: string[] = [];
 for (const result of dedupResults) {
 if (result.existing) continue;
 const ingressId = randomUUID();
 const now = new Date();
 await tx.insert(runtimeEventIngressTable).values({
 id: ingressId,
 invocationId: params.invocationId,
 tenantId: params.tenantId,
 producerEventId: result.event.producer_event_id,
 producerSequence: result.event.producer_sequence,
 candidateType: result.event.type,
 schemaVersion: result.event.schema_version ?? 1,
 payloadHash: result.hash,
 payloadJson: {
 occurred_at: result.event.occurred_at ?? null,
 payload: result.event.payload,
 },
 ingressState: "accepted",
 mappedItemId: null,
 mappedThreadEventId: null,
 mappedJobEventId: null,
 receivedAt: now,
 mappedAt: null,
 rejectedReason: null,
 });
 newIngressIds.push(ingressId);
 }

 // 8. 按候选类型映射平台状态（仅处理新事件）
 const mappedEvents: MappedEventResult[] = [];
 for (let i = 0; i < dedupResults.length; i++) {
 const result = dedupResults[i];
 if (!result) continue;

 if (result.existing) {
 // 幂等重放：复用原映射
 mappedEvents.push({
 producerEventId: result.event.producer_event_id,
 threadEventId: result.existing.mappedThreadEventId,
 threadSequence: await getThreadSequenceForEvent(tx, result.existing.mappedThreadEventId),
 itemId: result.existing.mappedItemId,
 });
 continue;
 }

 // 新事件：映射平台状态
 const mapping = await mapCandidateEvent(tx, {
 tenantId: params.tenantId,
 invocation,
 threadId: invocation.threadId,
 turnId: invocation.turnId ?? null,
 event: result.event,
 hash: result.hash,
 actorType,
 correlationId,
 });

 // 9. 更新 ingress 行：ingressState=mapped + mappedItemId + mappedThreadEventId + mappedAt
 const ingressId = newIngressIds.shift();
 if (ingressId) {
 await tx
 .update(runtimeEventIngressTable)
 .set({
 ingressState: "mapped",
 mappedItemId: mapping.itemId,
 mappedThreadEventId: mapping.threadEventId,
 mappedAt: new Date(),
 })
 .where(eq(runtimeEventIngressTable.id, ingressId));
 }

 mappedEvents.push({
 producerEventId: result.event.producer_event_id,
 threadEventId: mapping.threadEventId,
 threadSequence: mapping.threadSequence,
 itemId: mapping.itemId,
 });
 }

 return {
 invocationId: params.invocationId,
 acceptedThroughProducerSequence: params.producerSequenceStart + params.events.length - 1,
 mappedEvents,
 };
}

/** 查 ThreadEvent 的 eventSequence（用于幂等重放时回填 threadSequence）。 */
async function getThreadSequenceForEvent(
 tx: Tx,
 threadEventId: string | null,
): Promise<number | null> {
 if (!threadEventId) return null;
 const [row] = await tx
 .select({ seq: threadEventTable.eventSequence })
 .from(threadEventTable)
 .where(eq(threadEventTable.id, threadEventId))
 .limit(1);
 return row?.seq ?? null;
}

/** 候选事件映射结果。 */
interface CandidateMappingResult {
 threadEventId: string;
 threadSequence: number;
 itemId: string | null;
}

/**
 * 按候选类型映射平台状态。
 *
 * 映射规则（+ Invocation 生命周期）：
 * - progress.snapshot：创建 user_guidance Item（completed）+ item.created ThreadEvent。
 * - response.completed：创建 agent_message Item（completed）+ item.created + item.completed ThreadEvent
 * + 更新 Invocation.outputItemId + invocation.completed ThreadEvent + Invocation → completed + Turn → completed。
 * - user_action.requested：创建 user_action Item（pending）+ item.created + user_action.requested ThreadEvent
 * + Invocation → waiting_user + Turn → waiting_user。
 * - execution.completed：invocation.completed ThreadEvent + Invocation → completed + Turn → completed。
 * - execution.failed：invocation.failed ThreadEvent + Invocation → failed + Turn → failed。
 * - execution.cancelled：invocation.cancelled ThreadEvent + Invocation → cancelled + Turn → interrupted。
 */
async function mapCandidateEvent(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 hash: string;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 const candidateType = ctx.event.type as RuntimeCandidateEventType;

 // 校验 candidateType 是否支持
 const knownTypes: readonly string[] = [
 "progress.snapshot",
 "response.completed",
 "user_action.requested",
 "execution.completed",
 "execution.failed",
 "execution.cancelled",
 ];
 if (!knownTypes.includes(candidateType)) {
 throw new IngressCandidateTypeUnsupportedError(ctx.invocation.id, ctx.event.type);
 }

 switch (candidateType) {
 case "progress.snapshot":
 return await mapProgressSnapshot(tx, ctx);
 case "response.completed":
 return await mapResponseCompleted(tx, ctx);
 case "user_action.requested":
 return await mapUserActionRequested(tx, ctx);
 case "execution.completed":
 return await mapExecutionCompleted(tx, ctx);
 case "execution.failed":
 return await mapExecutionFailed(tx, ctx);
 case "execution.cancelled":
 return await mapExecutionCancelled(tx, ctx);
 default:
 throw new IngressCandidateTypeUnsupportedError(ctx.invocation.id, ctx.event.type);
 }
}

/** 计算 ThreadItem 内容 hash（复用 event payload hash 算法）。 */
function computeItemContentHash(content: Record<string, unknown>): string {
 return computeEventPayloadHash(content);
}

/** 创建 ThreadItem（事务内，调用方需先分配 itemSequence）。 */
async function createThreadItem(
 tx: Tx,
 params: {
 threadId: string;
 turnId: string;
 itemSequence: number;
 itemType: ThreadItemType;
 itemState: "pending" | "completed";
 authorType: ThreadItemAuthorType;
 authorId: string | null;
 content: Record<string, unknown>;
 invocationId: string;
 },
): Promise<ThreadItem> {
 const id = randomUUID();
 const now = new Date();
 const contentHash = computeItemContentHash(params.content);
 await tx.insert(threadItemTable).values({
 id,
 threadId: params.threadId,
 turnId: params.turnId,
 itemSequence: params.itemSequence,
 itemType: params.itemType,
 itemState: params.itemState,
 authorType: params.authorType,
 authorId: params.authorId,
 contentJson: params.content,
 contentHash,
 contextPolicy: "include",
 invocationId: params.invocationId,
 createdAt: now,
 updatedAt: now,
 });

 const [row] = await tx.select().from(threadItemTable).where(eq(threadItemTable.id, id)).limit(1);
 if (!row) {
 throw new Error(`createThreadItem: ThreadItem 行未找到（id=${id}）`);
 }
 return row;
}

/** progress.snapshot：创建 user_guidance Item + item.created ThreadEvent。 */
async function mapProgressSnapshot(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 const itemSeq = await allocateItemSequence(tx, ctx.threadId);
 const item = await createThreadItem(tx, {
 threadId: ctx.threadId,
 turnId: ctx.turnId,
 itemSequence: itemSeq,
 itemType: "user_guidance",
 itemState: "completed",
 authorType: "agent",
 authorId: null,
 content: {
 kind: "progress.snapshot",
 ...ctx.event.payload,
 },
 invocationId: ctx.invocation.id,
 });

 const eventSeq = await allocateEventSequences(tx, ctx.threadId, 1);
 const event = await insertThreadEvent(tx, ctx.threadId, eventSeq, {
 eventType: "item.created",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 item_type: "user_guidance",
 content_hash: item.contentHash,
 source: "progress.snapshot",
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 return {
 threadEventId: event.id,
 threadSequence: event.eventSequence,
 itemId: item.id,
 };
}

/** response.completed：创建 agent_message Item + item.created + item.completed + invocation.completed + 终态。 */
async function mapResponseCompleted(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 // 1. 创建 agent_message Item（completed）
 const itemSeq = await allocateItemSequence(tx, ctx.threadId);
 const item = await createThreadItem(tx, {
 threadId: ctx.threadId,
 turnId: ctx.turnId,
 itemSequence: itemSeq,
 itemType: "agent_message",
 itemState: "completed",
 authorType: "agent",
 authorId: null,
 content: {
 kind: "response.completed",
 ...ctx.event.payload,
 },
 invocationId: ctx.invocation.id,
 });

 // 2. 分配 3 个 event sequence（item.created + item.completed + invocation.completed）
 const startSeq = await allocateEventSequences(tx, ctx.threadId, 3);
 const itemCreatedSeq = startSeq;
 const itemCompletedSeq = startSeq + 1;
 const invocationCompletedSeq = startSeq + 2;

 // 3. 写 item.created ThreadEvent
 await insertThreadEvent(tx, ctx.threadId, itemCreatedSeq, {
 eventType: "item.created",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 item_type: "agent_message",
 content_hash: item.contentHash,
 source: "response.completed",
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 // 4. 写 item.completed ThreadEvent
 const itemCompletedEvent = await insertThreadEvent(tx, ctx.threadId, itemCompletedSeq, {
 eventType: "item.completed",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 item_type: "agent_message",
 content_hash: item.contentHash,
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 // 5. 更新 Invocation：outputItemId + → completed
 await updateInvocationState(tx, ctx.tenantId, ctx.invocation.id, "completed", {
 outputItemId: item.id,
 });

 // 6. 写 invocation.completed ThreadEvent
 await insertThreadEvent(tx, ctx.threadId, invocationCompletedSeq, {
 eventType: "invocation.completed",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 output_item_id: item.id,
 finish_reason: "response.completed",
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 // 7. CAS 更新 Turn：running → completed（finalItemId 指向 agent_message Item）
 await casUpdateTurn(tx, {
 turnId: ctx.turnId,
 expectedVersionNo: ctx.invocation.versionNo, // 占位，实际从 Turn 行读取
 nextState: "completed",
 finalItemId: item.id,
 adoptedInvocationId: ctx.invocation.id,
 });

 return {
 threadEventId: itemCompletedEvent.id,
 threadSequence: itemCompletedEvent.eventSequence,
 itemId: item.id,
 };
}

/** user_action.requested：创建 user_action Item + item.created + user_action.requested + waiting_user。 */
async function mapUserActionRequested(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 // 1. 创建 user_action Item（pending）
 const itemSeq = await allocateItemSequence(tx, ctx.threadId);
 const item = await createThreadItem(tx, {
 threadId: ctx.threadId,
 turnId: ctx.turnId,
 itemSequence: itemSeq,
 itemType: "user_action",
 itemState: "pending",
 authorType: "agent",
 authorId: null,
 content: {
 kind: "user_action.requested",
 ...ctx.event.payload,
 },
 invocationId: ctx.invocation.id,
 });

 // 2. 分配 2 个 event sequence（item.created + user_action.requested）
 const startSeq = await allocateEventSequences(tx, ctx.threadId, 2);
 const itemCreatedSeq = startSeq;
 const userActionSeq = startSeq + 1;

 // 3. 写 item.created ThreadEvent
 await insertThreadEvent(tx, ctx.threadId, itemCreatedSeq, {
 eventType: "item.created",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 item_type: "user_action",
 content_hash: item.contentHash,
 source: "user_action.requested",
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 // 4. 写 user_action.requested ThreadEvent
 const userActionEvent = await insertThreadEvent(tx, ctx.threadId, userActionSeq, {
 eventType: "user_action.requested",
 turnId: ctx.turnId,
 itemId: item.id,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: ctx.event.payload,
 correlationId: ctx.correlationId ?? undefined,
 });

 // 5. 更新 Invocation：→ waiting_user
 await updateInvocationState(tx, ctx.tenantId, ctx.invocation.id, "waiting_user");

 // 6. CAS 更新 Turn：running → waiting_user
 await casUpdateTurn(tx, {
 turnId: ctx.turnId,
 expectedVersionNo: ctx.invocation.versionNo,
 nextState: "waiting_user",
 activeInvocationId: ctx.invocation.id,
 });

 return {
 threadEventId: userActionEvent.id,
 threadSequence: userActionEvent.eventSequence,
 itemId: item.id,
 };
}

/** execution.completed：invocation.completed ThreadEvent + 终态。 */
async function mapExecutionCompleted(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 // 1. 分配 1 个 event sequence（invocation.completed）
 const seq = await allocateEventSequences(tx, ctx.threadId, 1);
 const event = await insertThreadEvent(tx, ctx.threadId, seq, {
 eventType: "invocation.completed",
 turnId: ctx.turnId,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 finish_reason: "execution.completed",
 ...ctx.event.payload,
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 // 2. 更新 Invocation：→ completed
 await updateInvocationState(tx, ctx.tenantId, ctx.invocation.id, "completed");

 // 3. CAS 更新 Turn：running → completed
 await casUpdateTurn(tx, {
 turnId: ctx.turnId,
 expectedVersionNo: ctx.invocation.versionNo,
 nextState: "completed",
 adoptedInvocationId: ctx.invocation.id,
 });

 return {
 threadEventId: event.id,
 threadSequence: event.eventSequence,
 itemId: null,
 };
}

/** execution.failed：invocation.failed ThreadEvent + 终态。 */
async function mapExecutionFailed(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 const seq = await allocateEventSequences(tx, ctx.threadId, 1);
 const event = await insertThreadEvent(tx, ctx.threadId, seq, {
 eventType: "invocation.failed",
 turnId: ctx.turnId,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 error_code: (ctx.event.payload.error_code as string | undefined) ?? "EXECUTION_FAILED",
 error_summary: (ctx.event.payload.error_summary as string | undefined) ?? null,
 ...ctx.event.payload,
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 await updateInvocationState(tx, ctx.tenantId, ctx.invocation.id, "failed", {
 errorCode: (ctx.event.payload.error_code as string | undefined) ?? "EXECUTION_FAILED",
 errorSummary: (ctx.event.payload.error_summary as string | undefined) ?? null,
 });

 await casUpdateTurn(tx, {
 turnId: ctx.turnId,
 expectedVersionNo: ctx.invocation.versionNo,
 nextState: "failed",
 errorCode: (ctx.event.payload.error_code as string | undefined) ?? "EXECUTION_FAILED",
 });

 return {
 threadEventId: event.id,
 threadSequence: event.eventSequence,
 itemId: null,
 };
}

/** execution.cancelled：invocation.cancelled ThreadEvent + 终态（Turn → interrupted）。 */
async function mapExecutionCancelled(
 tx: Tx,
 ctx: {
 tenantId: string;
 invocation: Invocation;
 threadId: string;
 turnId: string | null;
 event: RuntimeCandidateEvent;
 actorType: ThreadEventActorType;
 correlationId: string | null;
 },
): Promise<CandidateMappingResult> {
 if (!ctx.turnId) {
 throw new IngressInvocationNotFoundError(ctx.invocation.id);
 }

 const seq = await allocateEventSequences(tx, ctx.threadId, 1);
 const event = await insertThreadEvent(tx, ctx.threadId, seq, {
 eventType: "invocation.cancelled",
 turnId: ctx.turnId,
 invocationId: ctx.invocation.id,
 actorType: ctx.actorType,
 payload: {
 cancelled_by: (ctx.event.payload.cancelled_by as string | undefined) ?? "system",
 ...ctx.event.payload,
 },
 correlationId: ctx.correlationId ?? undefined,
 });

 await updateInvocationState(tx, ctx.tenantId, ctx.invocation.id, "cancelled");

 // 默认 Turn → interrupted（员工取消）；管理员取消由调用方另行处理
 await casUpdateTurn(tx, {
 turnId: ctx.turnId,
 expectedVersionNo: ctx.invocation.versionNo,
 nextState: "interrupted",
 });

 return {
 threadEventId: event.id,
 threadSequence: event.eventSequence,
 itemId: null,
 };
}

/**
 * CAS 更新 Turn 状态（事务内）。
 *
 * 与 dispatcher.transitionTurnToQueued 一致：先读当前 Turn 版本号，再 CAS 更新。
 * 失败时重新读取状态并抛 IngressInvocationTerminalError（并发或状态已变）。
 */
async function casUpdateTurn(
 tx: Tx,
 params: {
 turnId: string;
 /** 占位，实际从 Turn 行读取（invocation.versionNo 与 Turn.versionNo 不同步）。 */
 expectedVersionNo: number;
 nextState: "completed" | "failed" | "interrupted" | "waiting_user";
 finalItemId?: string;
 adoptedInvocationId?: string;
 activeInvocationId?: string;
 errorCode?: string;
 },
): Promise<void> {
 const [current] = await tx
 .select()
 .from(turnTable)
 .where(eq(turnTable.id, params.turnId))
 .limit(1);
 if (!current) {
 throw new IngressInvocationNotFoundError(params.turnId);
 }

 const now = new Date();
 const updates: Partial<typeof turnTable.$inferInsert> = {
 turnState: params.nextState,
 versionNo: current.versionNo + 1,
 finishedAt:
 params.nextState === "completed" ||
 params.nextState === "failed" ||
 params.nextState === "interrupted"
 ? now
 : current.finishedAt,
 activeInvocationId:
 params.nextState === "waiting_user"
 ? (params.activeInvocationId ?? current.activeInvocationId)
 : null,
 };
 if (params.nextState === "completed") {
 if (params.finalItemId !== undefined) updates.finalItemId = params.finalItemId;
 if (params.adoptedInvocationId !== undefined) {
 updates.adoptedInvocationId = params.adoptedInvocationId;
 }
 }
 if (params.nextState === "failed" && params.errorCode !== undefined) {
 updates.errorCode = params.errorCode;
 }
 if (params.nextState === "waiting_user") {
 updates.waitingAt = now;
 }

 const result = await tx
 .update(turnTable)
 .set(updates)
 .where(and(eq(turnTable.id, params.turnId), eq(turnTable.versionNo, current.versionNo)));

 if (result[0].affectedRows === 0) {
 // CAS 失败：并发或状态已变
 const [retry] = await tx
 .select()
 .from(turnTable)
 .where(eq(turnTable.id, params.turnId))
 .limit(1);
 throw new IngressInvocationTerminalError(params.turnId, retry?.turnState ?? "unknown");
 }
}

// ─── 查询函数 ──────────────────────────────────────────────

/** 按 invocationId + producerEventId 查询 Ingress 行（跨租户隔离）。不存在返回 null。 */
export async function getIngressByProducerEventId(
 tenantId: string,
 invocationId: string,
 producerEventId: string,
): Promise<RuntimeEventIngress | null> {
 const [row] = await db
 .select()
 .from(runtimeEventIngressTable)
 .where(
 and(
 eq(runtimeEventIngressTable.tenantId, tenantId),
 eq(runtimeEventIngressTable.invocationId, invocationId),
 eq(runtimeEventIngressTable.producerEventId, producerEventId),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 按 invocationId + producerSequence 查询 Ingress 行（跨租户隔离）。不存在返回 null。 */
export async function getIngressByProducerSequence(
 tenantId: string,
 invocationId: string,
 producerSequence: number,
): Promise<RuntimeEventIngress | null> {
 const [row] = await db
 .select()
 .from(runtimeEventIngressTable)
 .where(
 and(
 eq(runtimeEventIngressTable.tenantId, tenantId),
 eq(runtimeEventIngressTable.invocationId, invocationId),
 eq(runtimeEventIngressTable.producerSequence, producerSequence),
 ),
 )
 .limit(1);
 return row ?? null;
}

/**
 * 列出 Invocation 的 Ingress 行（按 producerSequence 升序，跨租户隔离）。
 *
 * 选项：
 * - afterSequence：游标分页，返回 producerSequence > afterSequence 的行。
 * - limit：默认 100，最大 500。
 */
export async function getIngressByInvocation(
 tenantId: string,
 invocationId: string,
 options?: { afterSequence?: number; limit?: number },
): Promise<RuntimeEventIngress[]> {
 const limit = Math.min(options?.limit ?? 100, 500);
 const afterSeq = options?.afterSequence ?? 0;
 return db
 .select()
 .from(runtimeEventIngressTable)
 .where(
 and(
 eq(runtimeEventIngressTable.tenantId, tenantId),
 eq(runtimeEventIngressTable.invocationId, invocationId),
 gt(runtimeEventIngressTable.producerSequence, afterSeq),
 ),
 )
 .orderBy(asc(runtimeEventIngressTable.producerSequence))
 .limit(limit);
}
