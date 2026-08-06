/**
 * V11 ToolCall 仓储（阶段 6 S06-C05）。
 *
 * 事实源：lib/persistence/schema/tool-call.ts、
 * ../v11-agentkit-platform/10-core-data-model.md （tool_call）、
 * ../v11-agentkit-platform/04-skills-tools-mcp-and-security.md （Tool 稳定边界）、
 * ../v11-agentkit-platform/12-capability-and-collaboration-api.md （TOOL_SCHEMA_CHANGED）。
 *
 * 职责：
 * - computeArgumentsHash：计算脱敏参数的 sha256 hash（sha256: 前缀 + 64 hex）。
 * - createToolCall：事务内创建 ToolCall（校验 SchemaRevision、分配 callSequence、
 * 计算 argumentsHash、检查 operation_id 幂等与 arguments_hash 一致性）。
 * - getToolCallById：按 id 查询（跨租户隔离）。
 * - getToolCallByOperation：按 (toolId, operationId) 查询（幂等回查）。
 * - listToolCallsByInvocation：列出某 Invocation 的全部 ToolCall（按 callSequence 升序）。
 * - updateToolCallState：更新调用状态（proposed → running → succeeded/failed/cancelled）。
 *
 * 关键约束：
 * - 稳定边界是单次 ToolCall（）：调用开始时固定 schemaHash，不可变。
 * - UNIQUE(invocationId, callSequence)：Invocation 内 callSequence 单调递增（事务内分配 max+1）。
 * - UNIQUE(toolId, operationId)：同 Tool + 同 operation_id 幂等。
 * - 若 (toolId, operationId) 已存在且 argumentsHash 相同 → 返回已存在行（幂等）。
 * - 若 (toolId, operationId) 已存在但 argumentsHash 不同 → ToolCallConflictError（TOOL_SCHEMA_CHANGED 409）。
 * - argumentsHash 必须以 `sha256:` 开头。
 * - schemaHash 必须以 `sha256:` 开头。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
 type ToolCall,
 type ToolCallState,
 toolCallTable,
} from "@/lib/persistence/schema/tool-call";
import { isValidContentHash } from "@/lib/v11/capability/content-cache";
import { and, asc, eq, max } from "drizzle-orm";

// ─── 错误类 ────────────────────────────────────────────────

/** ToolCall 校验错误（参数非法 / hash 格式非法）。 */
export class ToolCallValidationError extends Error {
 constructor(
 public readonly code: string,
 message: string,
 ) {
 super(message);
 this.name = "ToolCallValidationError";
 }
}

/** ToolCall 不存在（或跨租户不可见）。 */
export class ToolCallNotFoundError extends Error {
 constructor(public readonly toolCallId: string) {
 super(`ToolCall 不存在或跨租户不可见: ${toolCallId}`);
 this.name = "ToolCallNotFoundError";
 }
}

/**
 * 同 operation_id 与不同 arguments_hash 冲突（TOOL_SCHEMA_CHANGED 409）。
 *
 * 触发条件：(toolId, operationId) 已存在但 argumentsHash 不同。
 * 调用方应映射为 409 TOOL_SCHEMA_CHANGED（retryable=true，客户端可按新 Schema 重试）。
 */
export class ToolCallConflictError extends Error {
 constructor(
 public readonly toolId: string,
 public readonly operationId: string,
 public readonly expectedArgumentsHash: string,
 public readonly actualArgumentsHash: string,
 ) {
 super(
 `ToolCall (toolId=${toolId}, operationId=${operationId}) 已存在但 argumentsHash 不匹配：` +
 `期望 ${expectedArgumentsHash}，实际 ${actualArgumentsHash}`,
 );
 this.name = "ToolCallConflictError";
 }
}

/** ToolCall 状态机非法迁移（如 succeeded → running）。 */
export class ToolCallStateError extends Error {
 constructor(
 public readonly toolCallId: string,
 public readonly fromState: ToolCallState,
 public readonly toState: ToolCallState,
 ) {
 super(`ToolCall ${toolCallId} 状态不允许 ${fromState} → ${toState}`);
 this.name = "ToolCallStateError";
 }
}

/** callSequence 分配冲突（UNIQUE(invocationId, callSequence) 并发兜底）。 */
export class ToolCallSequenceConflictError extends Error {
 constructor(message: string) {
 super(message);
 this.name = "ToolCallSequenceConflictError";
 }
}

// ─── 常量校验 ─────────────────────────────────────────────

const VALID_TOOL_CALL_STATES = new Set<string>([
 "proposed",
 "paused",
 "running",
 "succeeded",
 "failed",
 "cancelled",
 "unknown_effect",
]);

function assertValidToolCallState(value: string): asserts value is ToolCallState {
 if (!VALID_TOOL_CALL_STATES.has(value)) {
 throw new ToolCallValidationError("invalid_call_state", `callState 非法: ${value}`);
 }
}

/** 校验 hash 格式（sha256: 前缀 + 64 hex）。 */
function assertValidHash(hash: string, label: string): void {
 if (!isValidContentHash(hash)) {
 throw new ToolCallValidationError(
 `invalid_${label}`,
 `${label} 必须以 sha256: 开头并跟随 64 hex: ${hash}`,
 );
 }
}

// ─── computeArgumentsHash ─────────────────────────────────

/**
 * 计算脱敏参数的 argumentsHash。
 *
 * 公式：sha256(JSON.stringify(argumentsRedactedJson))，带 sha256: 前缀。
 *
 * - 同一 operation_id 下相同脱敏参数产生相同 hash（幂等回查）。
 * - 同一 operation_id 下不同脱敏参数产生不同 hash → ToolCallConflictError（TOOL_SCHEMA_CHANGED）。
 *
 * @returns 形如 `sha256:<64-hex>` 的 hash 字符串
 */
export function computeArgumentsHash(argumentsRedactedJson: unknown): string {
 if (
 argumentsRedactedJson === undefined ||
 argumentsRedactedJson === null ||
 typeof argumentsRedactedJson !== "object"
 ) {
 throw new ToolCallValidationError(
 "invalid_arguments",
 "argumentsRedactedJson 必须为非空 JSON 对象",
 );
 }
 const payload = JSON.stringify(argumentsRedactedJson);
 const hex = createHash("sha256").update(payload, "utf-8").digest("hex");
 return `sha256:${hex}`;
}

// ─── createToolCall ───────────────────────────────────────

/** createToolCall 入参。 */
export interface CreateToolCallParams {
 tenantId: string;
 invocationId: string;
 /** 会话 ToolCall 必填：所属 Thread id。 */
 threadId?: string | null;
 /** 会话 ToolCall 必填：所属 Turn id。 */
 turnId?: string | null;
 /** 纯 Job ToolCall 必填：所属 Job id。 */
 jobId?: string | null;
 /** 被调用的 Tool id。 */
 toolId: string;
 /** 调用时锁定的 ToolSchemaRevision id。 */
 toolSchemaRevisionId: string;
 /** 调用时 Schema hash（sha256: 前缀）。 */
 schemaHash: string;
 /** 稳定业务操作幂等 id（同 toolId + operationId 幂等）。 */
 operationId: string;
 /** 脱敏参数（去除 secret/PII 后的 JSON）。 */
 argumentsRedactedJson: unknown;
 /** 实际执行环境 lease id（本阶段可空）。 */
 environmentLeaseId?: string | null;
 /** 员工可见 ToolCall Item id（逻辑外键 → ThreadItem）。 */
 itemId?: string | null;
 /** 调用开始时间；不传则不设置（proposed 状态）。 */
 startedAt?: Date | null;
}

/**
 * 事务内创建 ToolCall。
 *
 * 流程：
 * 1. 校验入参（tenantId/invocationId/toolId 必填、schemaHash/argumentsHash 格式）。
 * 2. 计算 argumentsHash = sha256(JSON.stringify(argumentsRedactedJson))。
 * 3. 幂等回查：按 (toolId, operationId) 查询已存在行。
 * - 若已存在且 argumentsHash 相同 → 返回已存在行（幂等）。
 * - 若已存在但 argumentsHash 不同 → 抛 ToolCallConflictError（TOOL_SCHEMA_CHANGED）。
 * 4. 分配 callSequence：max(callSequence) + 1（事务内）。
 * 5. INSERT 新行；UNIQUE(invocationId, callSequence) 冲突 → 抛 ToolCallSequenceConflictError。
 *
 * @throws ToolCallValidationError 入参非法
 * @throws ToolCallConflictError (toolId, operationId) 已存在但 argumentsHash 不匹配
 * @throws ToolCallSequenceConflictError callSequence 分配并发冲突
 */
export async function createToolCall(params: CreateToolCallParams): Promise<ToolCall> {
 if (!params.tenantId) {
 throw new ToolCallValidationError("invalid_tenant_id", "tenantId 不能为空");
 }
 if (!params.invocationId) {
 throw new ToolCallValidationError("invalid_invocation_id", "invocationId 不能为空");
 }
 if (!params.toolId) {
 throw new ToolCallValidationError("invalid_tool_id", "toolId 不能为空");
 }
 if (!params.toolSchemaRevisionId) {
 throw new ToolCallValidationError(
 "invalid_tool_schema_revision_id",
 "toolSchemaRevisionId 不能为空",
 );
 }
 if (!params.operationId) {
 throw new ToolCallValidationError("invalid_operation_id", "operationId 不能为空");
 }
 assertValidHash(params.schemaHash, "schemaHash");

 const argumentsHash = computeArgumentsHash(params.argumentsRedactedJson);

 // 幂等回查：同 (toolId, operationId) 已存在时按 argumentsHash 决定幂等或冲突。
 const existing = await getToolCallByOperation({
 tenantId: params.tenantId,
 toolId: params.toolId,
 operationId: params.operationId,
 });
 if (existing) {
 if (existing.argumentsHash === argumentsHash) {
 // 幂等：同 operation_id 同 arguments_hash 视为同一调用，返回已存在行。
 return existing;
 }
 // 冲突：同 operation_id 但 arguments_hash 不同 → TOOL_SCHEMA_CHANGED。
 throw new ToolCallConflictError(
 params.toolId,
 params.operationId,
 argumentsHash,
 existing.argumentsHash,
 );
 }

 // 事务内分配 callSequence + INSERT。
 const id = randomUUID();
 try {
 await db.transaction(async (tx) => {
 // 分配 callSequence = max(callSequence) + 1（事务内）。
 const callSequence = await nextCallSequence(tx, params.invocationId);

 await tx.insert(toolCallTable).values({
 id,
 tenantId: params.tenantId,
 invocationId: params.invocationId,
 threadId: params.threadId ?? null,
 turnId: params.turnId ?? null,
 jobId: params.jobId ?? null,
 callSequence,
 toolId: params.toolId,
 toolSchemaRevisionId: params.toolSchemaRevisionId,
 schemaHash: params.schemaHash,
 callState: "proposed",
 operationId: params.operationId,
 argumentsRedactedJson: params.argumentsRedactedJson,
 argumentsHash,
 environmentLeaseId: params.environmentLeaseId ?? null,
 itemId: params.itemId ?? null,
 startedAt: params.startedAt ?? null,
 });
 });
 } catch (err) {
 if (isDuplicateEntryError(err)) {
 // 并发竞态下 (toolId, operationId) 或 (invocationId, callSequence) 冲突。
 // 区分两种情况：先回查 operation；若命中且 hash 匹配 → 幂等，否则冲突。
 const retried = await getToolCallByOperation({
 tenantId: params.tenantId,
 toolId: params.toolId,
 operationId: params.operationId,
 });
 if (retried) {
 if (retried.argumentsHash === argumentsHash) {
 return retried;
 }
 throw new ToolCallConflictError(
 params.toolId,
 params.operationId,
 argumentsHash,
 retried.argumentsHash,
 );
 }
 // 否则视为 callSequence 冲突（UNIQUE(invocationId, callSequence)）。
 throw new ToolCallSequenceConflictError(
 `ToolCall 并发冲突：callSequence 分配冲突 (invocationId=${params.invocationId})`,
 );
 }
 throw err;
 }

 const [row] = await db.select().from(toolCallTable).where(eq(toolCallTable.id, id)).limit(1);
 if (!row) {
 throw new Error(`createToolCall: 行未找到（id=${id}）`);
 }
 return row;
}

// ─── 查询 ─────────────────────────────────────────────────

/** 按 id 查询 ToolCall（跨租户隔离）。不存在返回 null。 */
export async function getToolCallById(params: {
 tenantId: string;
 toolCallId: string;
}): Promise<ToolCall | null> {
 const [row] = await db
 .select()
 .from(toolCallTable)
 .where(
 and(eq(toolCallTable.tenantId, params.tenantId), eq(toolCallTable.id, params.toolCallId)),
 )
 .limit(1);
 return row ?? null;
}

/** 按 (toolId, operationId) 查询 ToolCall（幂等回查）。不存在返回 null。 */
export async function getToolCallByOperation(params: {
 tenantId: string;
 toolId: string;
 operationId: string;
}): Promise<ToolCall | null> {
 const [row] = await db
 .select()
 .from(toolCallTable)
 .where(
 and(
 eq(toolCallTable.tenantId, params.tenantId),
 eq(toolCallTable.toolId, params.toolId),
 eq(toolCallTable.operationId, params.operationId),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 列出某 Invocation 的全部 ToolCall（按 callSequence 升序）。 */
export async function listToolCallsByInvocation(params: {
 tenantId: string;
 invocationId: string;
}): Promise<ToolCall[]> {
 return db
 .select()
 .from(toolCallTable)
 .where(
 and(
 eq(toolCallTable.tenantId, params.tenantId),
 eq(toolCallTable.invocationId, params.invocationId),
 ),
 )
 .orderBy(asc(toolCallTable.callSequence), asc(toolCallTable.id));
}

// ─── updateToolCallState ──────────────────────────────────

/** ToolCall 状态机：合法迁移映射。 */
const TOOL_CALL_STATE_TRANSITIONS: Record<ToolCallState, readonly ToolCallState[]> = {
 proposed: ["running", "paused", "cancelled"],
 paused: ["running", "cancelled"],
 running: ["succeeded", "failed", "cancelled", "unknown_effect", "paused"],
 succeeded: [], // 终态
 failed: [], // 终态
 cancelled: [], // 终态
 // unknown_effect 可通过 EffectRecord reconcile 迁移到 succeeded/failed（、）：
 // confirmed_success/partial → succeeded；confirmed_failure → failed。
 // 仍可保持 unknown_effect（reconcile 后仍有未知目标）；不可迁回 running/proposed/cancelled。
 unknown_effect: ["succeeded", "failed"],
};

/** updateToolCallState 入参。 */
export interface UpdateToolCallStateParams {
 tenantId: string;
 toolCallId: string;
 /** 目标状态。 */
 toState: ToolCallState;
 /** 成功时的结果摘要（JSON）。 */
 resultSummaryJson?: unknown;
 /** 结果 artifact id。 */
 resultArtifactId?: string | null;
 /** 失败时的错误代码。 */
 errorCode?: string | null;
 /** 失败时的错误摘要。 */
 errorSummary?: string | null;
 /** 调用结束时间；不传则按目标状态自动设置（succeeded/failed/cancelled/unknown_effect）。 */
 finishedAt?: Date | null;
}

/**
 * 更新 ToolCall 状态（状态机校验）。
 *
 * - proposed → running/paused/cancelled
 * - paused → running/cancelled
 * - running → succeeded/failed/cancelled/unknown_effect/paused
 * - succeeded/failed/cancelled/unknown_effect 为终态，不可迁移。
 *
 * @throws ToolCallNotFoundError ToolCall 不存在或跨租户
 * @throws ToolCallStateError 状态机非法迁移
 */
export async function updateToolCallState(params: UpdateToolCallStateParams): Promise<ToolCall> {
 assertValidToolCallState(params.toState);

 const current = await getToolCallById({
 tenantId: params.tenantId,
 toolCallId: params.toolCallId,
 });
 if (!current) {
 throw new ToolCallNotFoundError(params.toolCallId);
 }

 if (current.callState === params.toState) {
 // 同状态：允许更新 result/error 字段（如 running → running 补充部分结果），不视为非法迁移。
 return current;
 }

 // DB 行的 callState 类型为 string，索引状态机映射需显式断言为 ToolCallState。
 const allowed = TOOL_CALL_STATE_TRANSITIONS[current.callState as ToolCallState];
 if (!allowed.includes(params.toState)) {
 throw new ToolCallStateError(
 params.toolCallId,
 current.callState as ToolCallState,
 params.toState,
 );
 }

 const now = new Date();
 const updates: Record<string, unknown> = {
 callState: params.toState,
 updatedAt: now,
 };

 // 进入 running 时设置 startedAt（若未设置）；进入终态时设置 finishedAt。
 if (params.toState === "running" && !current.startedAt) {
 updates.startedAt = now;
 }
 if (["succeeded", "failed", "cancelled", "unknown_effect"].includes(params.toState)) {
 updates.finishedAt = params.finishedAt ?? now;
 }
 if (params.resultSummaryJson !== undefined) {
 updates.resultSummaryJson = params.resultSummaryJson;
 }
 if (params.resultArtifactId !== undefined) {
 updates.resultArtifactId = params.resultArtifactId;
 }
 if (params.errorCode !== undefined) {
 updates.errorCode = params.errorCode;
 }
 if (params.errorSummary !== undefined) {
 updates.errorSummary = params.errorSummary;
 }

 await db
 .update(toolCallTable)
 .set(updates)
 .where(
 and(eq(toolCallTable.tenantId, params.tenantId), eq(toolCallTable.id, params.toolCallId)),
 );

 const updated = await getToolCallById({
 tenantId: params.tenantId,
 toolCallId: params.toolCallId,
 });
 if (!updated) {
 throw new ToolCallNotFoundError(params.toolCallId);
 }
 return updated;
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 计算 Invocation 内下一个 callSequence（max +1）。并发冲突由 UNIQUE 约束 fail-loud。 */
async function nextCallSequence(
 tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
 invocationId: string,
): Promise<number> {
 const [row] = await tx
 .select({ maxSeq: max(toolCallTable.callSequence) })
 .from(toolCallTable)
 .where(eq(toolCallTable.invocationId, invocationId));
 const currentMax = row?.maxSeq;
 if (currentMax === null || currentMax === undefined) return 1;
 return currentMax + 1;
}

/** 判断 MySQL 错误是否为唯一约束冲突（ER_DUP_ENTRY, code 1062）。 */
function isDuplicateEntryError(err: unknown): boolean {
 if (!err || typeof err !== "object") return false;
 const e = err as { code?: string; errno?: number };
 return e.code === "ER_DUP_ENTRY" || e.errno === 1062;
}

// ─── Re-exports ────────────────────────────────────────────

export type { ToolCallState, ToolCall } from "@/lib/persistence/schema/tool-call";
