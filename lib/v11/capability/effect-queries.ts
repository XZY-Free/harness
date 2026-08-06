/**
 * V11 EffectRecord + EffectTarget 仓储（阶段 8 S08-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md （effect_record 与 effect_target）、
 * （tool_call.call_state 与 effect_state 同步）、（ToolCall、Effect 与 Credential）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §10 第 9 条（unknown_effect 不自动重放）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md （Gateway 即时核对）、
 * （Admin 长期核对 + 同事务更新 tool_call.call_state + AuditEvent）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md 。
 *
 * 关键不变量：
 * - 一条有副作用 ToolCall 恰有一条 EffectRecord（UNIQUE(toolCallId)）。
 * - effect_target 通过 UNIQUE(effectRecordId, targetHash) 防止同目标重复记录。
 * - 总 effect_state 由目标明细派生：confirmed_success / confirmed_partial / confirmed_failure / unknown_effect。
 * - 写入后不可变：effect_type / toolCallId / externalIdempotencyKey 不可修改；
 * 补偿是新的、单独授权 ToolCall，通过 causation 关联原操作，不修改原事实。
 * - reconcile 同事务更新：effect_record + effect_target + tool_call.call_state（）。
 * - unknown_effect 不能自动重放；partial success 只允许重试明确失败且安全的目标。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
 ADMIN_VERIFICATION_METHODS,
 EFFECT_STATES,
 EFFECT_TARGET_STATES,
 EFFECT_TYPES,
 type EffectRecord,
 type EffectState,
 type EffectTarget,
 type EffectTargetState,
 type EffectType,
 GATEWAY_VERIFICATION_METHODS,
 type NewEffectRecord,
 type NewEffectTarget,
 VERIFICATION_METHODS,
 type VerificationMethod,
 effectRecordTable,
 effectTargetTable,
} from "@/lib/persistence/schema/effect";
import { type ToolCall, toolCallTable } from "@/lib/persistence/schema/tool-call";
import { getToolCallById, updateToolCallState } from "@/lib/v11/capability/tool-call-queries";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class EffectValidationError extends Error {
 constructor(message: string) {
 super(message);
 this.name = "EffectValidationError";
 }
}

export class EffectNotFoundError extends Error {
 constructor(message: string) {
 super(message);
 this.name = "EffectNotFoundError";
 }
}

/**
 * EffectRecord 已进入终态（confirmed_*），不可再 reconcile。
 *
 * unknown_effect 不属于终态，可多次 reconcile 直到所有 target 都确认。
 */
export class EffectAlreadyConfirmedError extends Error {
 public readonly currentState: EffectState;
 public readonly effectRecordId: string;

 constructor(effectRecordId: string, currentState: EffectState) {
 super(
 `EffectRecord ${effectRecordId} 已进入终态（currentState=${currentState}），不可再 reconcile`,
 );
 this.name = "EffectAlreadyConfirmedError";
 this.currentState = currentState;
 this.effectRecordId = effectRecordId;
 }
}

/**
 * reconcile 提供的 targetHash 与现有 EffectTarget 不匹配。
 *
 * 调用方应先查询 listEffectTargets 获取合法 targetHash 列表。
 */
export class EffectTargetNotFoundError extends Error {
 public readonly targetHash: string;

 constructor(targetHash: string) {
 super(`EffectTarget 不存在或跨租户不可见: ${targetHash}`);
 this.name = "EffectTargetNotFoundError";
 this.targetHash = targetHash;
 }
}

/**
 * operation_id 与原 ToolCall 不匹配（Gateway 即时核对路径要求一致）。
 */
export class EffectOperationMismatchError extends Error {
 public readonly expectedOperationId: string;
 public readonly actualOperationId: string;

 constructor(expectedOperationId: string, actualOperationId: string) {
 super(`operation_id 不匹配：期望 ${expectedOperationId}，实际 ${actualOperationId}`);
 this.name = "EffectOperationMismatchError";
 this.expectedOperationId = expectedOperationId;
 this.actualOperationId = actualOperationId;
 }
}

/**
 * 核对方式不被当前路径允许（如 Gateway 路径使用 manual_evidence）。
 */
export class EffectVerificationMethodNotAllowedError extends Error {
 public readonly method: VerificationMethod;
 public readonly allowedMethods: readonly VerificationMethod[];

 constructor(method: VerificationMethod, allowedMethods: readonly VerificationMethod[]) {
 super(`verification_method=${method} 不被当前路径允许；合法值：${allowedMethods.join(", ")}`);
 this.name = "EffectVerificationMethodNotAllowedError";
 this.method = method;
 this.allowedMethods = allowedMethods;
 }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_EFFECT_TYPES = new Set<string>(EFFECT_TYPES);
const VALID_EFFECT_STATES = new Set<string>(EFFECT_STATES);
const VALID_TARGET_STATES = new Set<string>(EFFECT_TARGET_STATES);
const VALID_VERIFICATION_METHODS = new Set<string>(VERIFICATION_METHODS);

export function isEffectType(value: string): value is EffectType {
 return VALID_EFFECT_TYPES.has(value);
}

export function isEffectState(value: string): value is EffectState {
 return VALID_EFFECT_STATES.has(value);
}

export function isEffectTargetState(value: string): value is EffectTargetState {
 return VALID_TARGET_STATES.has(value);
}

export function isVerificationMethod(value: string): value is VerificationMethod {
 return VALID_VERIFICATION_METHODS.has(value);
}

/**
 * 校验 hash 格式（sha256: 前缀 + 64 hex）。
 * 与 ToolCall.argumentsHash / schemaHash 一致风格。
 */
export function isValidTargetHash(hash: string): boolean {
 if (!hash.startsWith("sha256:")) return false;
 const hex = hash.slice("sha256:".length);
 return /^[0-9a-f]{64}$/.test(hex);
}

/**
 * 计算目标摘要 hash（sha256: 前缀 + 64 hex）。
 *
 * 用于 EffectTarget.targetHash，确保同 EffectRecord 内同目标不重复记录。
 * 输入为目标引用字符串（如 "user:email:foo@example.com"）。
 */
export function computeTargetHash(targetRef: string): string {
 if (!targetRef || typeof targetRef !== "string") {
 throw new EffectValidationError("targetRef 不能为空");
 }
 const hex = createHash("sha256").update(targetRef, "utf-8").digest("hex");
 return `sha256:${hex}`;
}

/**
 * 从目标明细派生总 effect_state（）。
 *
 * 规则：
 * - 全部 confirmed_success → confirmed_success
 * - 全部 confirmed_failure → confirmed_failure
 * - 混合 success/failure 且无 unknown → confirmed_partial
 * - 含任意 unknown → unknown_effect
 * - 空数组 → unknown_effect（无法核对）
 */
export function deriveEffectStateFromTargets(targets: readonly EffectTargetState[]): EffectState {
 if (targets.length === 0) return "unknown_effect";

 let successCount = 0;
 let failureCount = 0;
 let unknownCount = 0;
 for (const s of targets) {
 if (s === "confirmed_success") successCount++;
 else if (s === "confirmed_failure") failureCount++;
 else unknownCount++;
 }

 if (unknownCount > 0) return "unknown_effect";
 if (successCount === targets.length) return "confirmed_success";
 if (failureCount === targets.length) return "confirmed_failure";
 return "confirmed_partial";
}

// ─── createEffectRecord ──────────────────────────────────

export interface CreateEffectRecordInput {
 tenantId: string;
 /** 所属 ToolCall id（一对一；逻辑外键 → ToolCall.id）。 */
 toolCallId: string;
 effectType: EffectType;
 /** 目标数量和脱敏摘要（JSON：{ total, description, ... }）。 */
 targetSummaryJson: unknown;
 /** 目标系统幂等键（如外部 API 的 Idempotency-Key）。 */
 externalIdempotencyKey?: string | null;
 /** 初始外部结果引用（通常创建时为空，reconcile 后回填）。 */
 externalResultRef?: string | null;
 /** 初始 effect_state；默认 not_started。 */
 initialEffectState?: EffectState | null;
}

/**
 * 创建 EffectRecord（一条 ToolCall 一条；UNIQUE(toolCallId)）。
 *
 * 关键约束：
 * - 同一 toolCallId 已存在 EffectRecord 时抛 EffectValidationError（不返回幂等行）。
 * - targetSummaryJson 必须为非空对象。
 * - 不创建 EffectTarget；调用方应紧接着调用 createEffectTargets。
 */
export async function createEffectRecord(input: CreateEffectRecordInput): Promise<EffectRecord> {
 if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
 if (!input.toolCallId) throw new EffectValidationError("toolCallId 不能为空");
 if (!isEffectType(input.effectType)) {
 throw new EffectValidationError(`非法 effectType: ${input.effectType}`);
 }
 if (!input.targetSummaryJson || typeof input.targetSummaryJson !== "object") {
 throw new EffectValidationError("targetSummaryJson 必须是对象");
 }
 if (input.externalIdempotencyKey !== undefined && input.externalIdempotencyKey !== null) {
 if (
 typeof input.externalIdempotencyKey !== "string" ||
 input.externalIdempotencyKey.length === 0
 ) {
 throw new EffectValidationError("externalIdempotencyKey 不能为空字符串");
 }
 if (input.externalIdempotencyKey.length > 128) {
 throw new EffectValidationError("externalIdempotencyKey 长度不能超过 128");
 }
 }

 // 幂等回查：同一 toolCallId 已存在时拒绝（不返回已存在行，强制调用方走查询路径）。
 const existing = await getEffectRecordByToolCall(input.tenantId, input.toolCallId);
 if (existing) {
 throw new EffectValidationError(
 `EffectRecord 已存在（toolCallId=${input.toolCallId}）；一对一约束禁止二次创建`,
 );
 }

 const id = randomUUID();
 const now = new Date();
 const insert: NewEffectRecord = {
 id,
 tenantId: input.tenantId,
 toolCallId: input.toolCallId,
 effectType: input.effectType,
 targetSummaryJson: input.targetSummaryJson,
 effectState: input.initialEffectState ?? "not_started",
 externalIdempotencyKey: input.externalIdempotencyKey ?? null,
 externalResultRef: input.externalResultRef ?? null,
 versionNo: 1,
 createdAt: now,
 updatedAt: now,
 };

 await db.insert(effectRecordTable).values(insert);
 const created = await getEffectRecordById(input.tenantId, id);
 if (!created) {
 throw new EffectNotFoundError("EffectRecord 创建后回查失败");
 }
 return created;
}

// ─── createEffectTargets ─────────────────────────────────

export interface CreateEffectTargetItem {
 /** 目标引用（如 user:email:foo@example.com）。 */
 targetRef: string;
 /** 目标摘要 hash；不传则由 computeTargetHash(targetRef) 计算。 */
 targetHash?: string;
 /** 初始状态；默认 unknown。 */
 initialTargetState?: EffectTargetState | null;
 /** 初始外部结果引用；通常创建时为空。 */
 externalResultRef?: string | null;
 /** 初始证据；通常创建时为空。 */
 evidenceJson?: unknown | null;
 /** 备注。 */
 notes?: string | null;
}

export interface CreateEffectTargetsInput {
 tenantId: string;
 effectRecordId: string;
 targets: readonly CreateEffectTargetItem[];
}

/**
 * 批量创建 EffectTarget（UNIQUE(effectRecordId, targetHash)）。
 *
 * - 同 EffectRecord 内同 targetHash 重复 → 抛 EffectValidationError。
 * - targetHash 不传时由 computeTargetHash(targetRef) 计算。
 * - 调用方应在 createEffectRecord 后紧接着调用本函数。
 */
export async function createEffectTargets(
 input: CreateEffectTargetsInput,
): Promise<EffectTarget[]> {
 if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
 if (!input.effectRecordId) throw new EffectValidationError("effectRecordId 不能为空");
 if (!Array.isArray(input.targets) || input.targets.length === 0) {
 throw new EffectValidationError("targets 必须是非空数组");
 }

 // 校验 + 去重检查
 const seenHashes = new Set<string>();
 const rows: NewEffectTarget[] = [];
 const now = new Date();
 for (const item of input.targets) {
 if (!item.targetRef) throw new EffectValidationError("targetRef 不能为空");
 if (item.targetRef.length > 512) {
 throw new EffectValidationError("targetRef 长度不能超过 512");
 }
 const hash = item.targetHash ?? computeTargetHash(item.targetRef);
 if (!isValidTargetHash(hash)) {
 throw new EffectValidationError(`targetHash 格式非法: ${hash}`);
 }
 if (item.initialTargetState !== undefined && item.initialTargetState !== null) {
 if (!isEffectTargetState(item.initialTargetState)) {
 throw new EffectValidationError(`非法 initialTargetState: ${item.initialTargetState}`);
 }
 }
 if (seenHashes.has(hash)) {
 throw new EffectValidationError(`targets 内 targetHash 重复: ${hash}`);
 }
 seenHashes.add(hash);

 rows.push({
 id: randomUUID(),
 tenantId: input.tenantId,
 effectRecordId: input.effectRecordId,
 targetRef: item.targetRef,
 targetHash: hash,
 targetState: item.initialTargetState ?? "unknown",
 externalResultRef: item.externalResultRef ?? null,
 evidenceJson: item.evidenceJson ?? null,
 notes: item.notes ?? null,
 createdAt: now,
 updatedAt: now,
 });
 }

 await db.insert(effectTargetTable).values(rows);
 return db
 .select()
 .from(effectTargetTable)
 .where(eq(effectTargetTable.effectRecordId, input.effectRecordId))
 .orderBy(asc(effectTargetTable.targetHash));
}

// ─── 查询 ─────────────────────────────────────────────────

export async function getEffectRecordById(
 tenantId: string,
 effectRecordId: string,
): Promise<EffectRecord | null> {
 const [row] = await db
 .select()
 .from(effectRecordTable)
 .where(and(eq(effectRecordTable.tenantId, tenantId), eq(effectRecordTable.id, effectRecordId)))
 .limit(1);
 return row ?? null;
}

export async function getEffectRecordByToolCall(
 tenantId: string,
 toolCallId: string,
): Promise<EffectRecord | null> {
 const [row] = await db
 .select()
 .from(effectRecordTable)
 .where(
 and(eq(effectRecordTable.tenantId, tenantId), eq(effectRecordTable.toolCallId, toolCallId)),
 )
 .limit(1);
 return row ?? null;
}

export async function listEffectTargets(
 tenantId: string,
 effectRecordId: string,
): Promise<EffectTarget[]> {
 return db
 .select()
 .from(effectTargetTable)
 .where(
 and(
 eq(effectTargetTable.tenantId, tenantId),
 eq(effectTargetTable.effectRecordId, effectRecordId),
 ),
 )
 .orderBy(asc(effectTargetTable.targetHash));
}

/**
 * 列出某 Invocation 的全部 EffectRecord（通过 tool_call 联表查询）。
 *
 * - 按 tool_call.callSequence 升序排列。
 * - 跨租户隔离：tool_call.tenantId + effect_record.tenantId 双重过滤。
 */
export async function listEffectRecordsByInvocation(
 tenantId: string,
 invocationId: string,
): Promise<EffectRecord[]> {
 const rows = await db
 .select({
 record: effectRecordTable,
 })
 .from(effectRecordTable)
 .innerJoin(
 toolCallTable,
 and(
 eq(effectRecordTable.toolCallId, toolCallTable.id),
 eq(effectRecordTable.tenantId, toolCallTable.tenantId),
 ),
 )
 .where(
 and(eq(effectRecordTable.tenantId, tenantId), eq(toolCallTable.invocationId, invocationId)),
 )
 .orderBy(asc(toolCallTable.callSequence));

 return rows.map((r) => r.record);
}

/**
 * 列出某租户内指定状态的 EffectRecord（用于扫描 unknown_effect 待核对任务）。
 */
export async function listEffectRecordsByState(
 tenantId: string,
 state: EffectState,
 options?: { limit?: number },
): Promise<EffectRecord[]> {
 const limit = options?.limit ?? 100;
 return db
 .select()
 .from(effectRecordTable)
 .where(and(eq(effectRecordTable.tenantId, tenantId), eq(effectRecordTable.effectState, state)))
 .orderBy(asc(effectRecordTable.createdAt))
 .limit(limit);
}

// ─── reconcileEffect ─────────────────────────────────────

export interface ReconcileTargetUpdate {
 /** 必须匹配现有 EffectTarget.targetHash。 */
 targetHash: string;
 /** 新的核对状态。 */
 targetState: EffectTargetState;
 /** 该目标的外部结果引用；不传则不改。 */
 externalResultRef?: string | null;
 /** 该目标的证据摘要；不传则不改。 */
 evidenceJson?: unknown | null;
 /** 备注；不传则不改。 */
 notes?: string | null;
}

export type ReconcilePath = "gateway" | "admin";

export interface ReconcileEffectInput {
 tenantId: string;
 toolCallId: string;
 /** 调用路径：gateway（仅 provider_query + operation_id 校验）或 admin（三种 method）。 */
 path: ReconcilePath;
 /** 核对方式。 */
 verificationMethod: VerificationMethod;
 /** 各目标的核对结果；可为空（仅刷新总体 verifiedAt）。 */
 targetUpdates: readonly ReconcileTargetUpdate[];
 /** 整体证据；不传则不改。 */
 evidenceJson?: unknown | null;
 /** 整体外部结果引用；不传则不改。 */
 externalResultRef?: string | null;
 /** Gateway 路径必填：必须与原 ToolCall.operationId 一致。 */
 expectedOperationId?: string;
 /** 调用者标识（用于审计；本仓储不写 AuditEvent，由调用方在更高层补充）。 */
 reconciledBy?: string;
}

export interface ReconcileEffectResult {
 effectRecord: EffectRecord;
 effectTargets: EffectTarget[];
 /** 核对后的 ToolCall（call_state 可能同步迁移）。 */
 toolCall: ToolCall;
 /** 派生的目标计数（与 API 响应 targets 字段一致）。 */
 targetsCount: {
 total: number;
 confirmed_success: number;
 confirmed_failure: number;
 unknown: number;
 };
}

/**
 * 核对 ToolCall 副作用（Gateway 即时核对 / Admin 长期核对）。
 *
 * 关键规则：
 * - path=gateway：仅允许 verification_method=provider_query；expectedOperationId 必填且必须匹配。
 * - path=admin：允许 provider_query / callback_evidence / manual_evidence；不强制 operation_id。
 * - EffectRecord 当前状态不能为 confirmed_*（终态不可再 reconcile）；unknown_effect 可多次 reconcile。
 * - 同事务更新：effect_record + effect_target + tool_call.call_state（）。
 * - targetUpdates 中的 targetHash 必须匹配现有 EffectTarget；不存在的抛 EffectTargetNotFoundError。
 * - 派生新 effect_state：confirmed_success/partial → call_state=succeeded；
 * confirmed_failure → call_state=failed；unknown_effect 保持 unknown_effect。
 *
 * 注意：ThreadEvent / AuditEvent 不在本仓储写入；由调用方在更高层同事务或后续写入。
 */
export async function reconcileEffect(input: ReconcileEffectInput): Promise<ReconcileEffectResult> {
 if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
 if (!input.toolCallId) throw new EffectValidationError("toolCallId 不能为空");
 if (input.path !== "gateway" && input.path !== "admin") {
 throw new EffectValidationError(`非法 path: ${input.path}`);
 }
 if (!isVerificationMethod(input.verificationMethod)) {
 throw new EffectValidationError(`非法 verificationMethod: ${input.verificationMethod}`);
 }

 // 路径与方法校验
 const allowedMethods =
 input.path === "gateway" ? GATEWAY_VERIFICATION_METHODS : ADMIN_VERIFICATION_METHODS;
 if (!allowedMethods.includes(input.verificationMethod)) {
 throw new EffectVerificationMethodNotAllowedError(input.verificationMethod, allowedMethods);
 }
 if (input.path === "gateway" && !input.expectedOperationId) {
 throw new EffectValidationError("gateway 路径必须提供 expectedOperationId");
 }

 // 查询现有 EffectRecord + ToolCall + Targets
 const record = await getEffectRecordByToolCall(input.tenantId, input.toolCallId);
 if (!record) {
 throw new EffectNotFoundError(
 `EffectRecord 不存在或跨租户不可见（toolCallId=${input.toolCallId}）`,
 );
 }

 // 终态校验：confirmed_* 不可再 reconcile；unknown_effect / not_started 允许
 if (
 record.effectState === "confirmed_success" ||
 record.effectState === "confirmed_partial" ||
 record.effectState === "confirmed_failure"
 ) {
 throw new EffectAlreadyConfirmedError(record.id, record.effectState);
 }

 const toolCall = await getToolCallById({
 tenantId: input.tenantId,
 toolCallId: input.toolCallId,
 });
 if (!toolCall) {
 throw new EffectNotFoundError(`ToolCall 不存在或跨租户不可见: ${input.toolCallId}`);
 }

 // Gateway 路径 operation_id 校验
 if (input.path === "gateway" && input.expectedOperationId !== toolCall.operationId) {
 throw new EffectOperationMismatchError(input.expectedOperationId ?? "", toolCall.operationId);
 }

 const existingTargets = await listEffectTargets(input.tenantId, record.id);
 const targetByHash = new Map<string, EffectTarget>();
 for (const t of existingTargets) {
 targetByHash.set(t.targetHash, t);
 }

 // 校验 targetUpdates 中的 targetHash 都存在
 for (const update of input.targetUpdates) {
 if (!targetByHash.has(update.targetHash)) {
 throw new EffectTargetNotFoundError(update.targetHash);
 }
 if (!isEffectTargetState(update.targetState)) {
 throw new EffectValidationError(`非法 targetState: ${update.targetState}`);
 }
 }

 // 在事务内更新 effect_target + effect_record + tool_call.call_state
 const now = new Date();
 return db.transaction(async (tx) => {
 // 1. 更新各 EffectTarget
 for (const update of input.targetUpdates) {
 const setFields: Record<string, unknown> = {
 targetState: update.targetState,
 verifiedAt: now,
 updatedAt: now,
 };
 if (update.externalResultRef !== undefined) {
 setFields.externalResultRef = update.externalResultRef;
 }
 if (update.evidenceJson !== undefined) {
 setFields.evidenceJson = update.evidenceJson;
 }
 if (update.notes !== undefined) {
 setFields.notes = update.notes;
 }
 await tx
 .update(effectTargetTable)
 .set(setFields)
 .where(
 and(
 eq(effectTargetTable.tenantId, input.tenantId),
 eq(effectTargetTable.effectRecordId, record.id),
 eq(effectTargetTable.targetHash, update.targetHash),
 ),
 );
 }

 // 2. 重新查询所有 target，派生新的 effect_state
 const updatedTargets = await tx
 .select()
 .from(effectTargetTable)
 .where(
 and(
 eq(effectTargetTable.tenantId, input.tenantId),
 eq(effectTargetTable.effectRecordId, record.id),
 ),
 )
 .orderBy(asc(effectTargetTable.targetHash));

 const targetStates: EffectTargetState[] = updatedTargets.map((t) => t.targetState);
 const newEffectState = deriveEffectStateFromTargets(targetStates);

 // 3. 更新 EffectRecord
 const recordSetFields: Record<string, unknown> = {
 effectState: newEffectState,
 verificationMethod: input.verificationMethod,
 verifiedAt: now,
 versionNo: record.versionNo + 1,
 updatedAt: now,
 };
 if (input.evidenceJson !== undefined) {
 recordSetFields.evidenceJson = input.evidenceJson;
 }
 if (input.externalResultRef !== undefined) {
 recordSetFields.externalResultRef = input.externalResultRef;
 }
 await tx
 .update(effectRecordTable)
 .set(recordSetFields)
 .where(
 and(eq(effectRecordTable.tenantId, input.tenantId), eq(effectRecordTable.id, record.id)),
 );

 // 4. 同步更新 ToolCall.call_state（）
 // - confirmed_success/partial → succeeded
 // - confirmed_failure → failed
 // - unknown_effect 保持原状（仍为 unknown_effect 或其他）
 // - not_started 不应该出现在 reconcile（ EffectRecord 创建时若已有副作用应直接进入 unknown_effect；
 // 但若所有 target 都是 unknown，新派生状态也是 unknown_effect）
 let newCallState: typeof toolCall.callState | null = null;
 if (newEffectState === "confirmed_success" || newEffectState === "confirmed_partial") {
 newCallState = "succeeded";
 } else if (newEffectState === "confirmed_failure") {
 newCallState = "failed";
 }
 // unknown_effect 保持原状；其他情况不迁移

 if (newCallState && toolCall.callState !== newCallState) {
 // 直接 DB 更新（不调用 updateToolCallState，因为 reconcile 是状态机的合法路径但
 // 该函数使用全局 db 而非 tx；此处需在事务内更新以保证原子性）。
 // 状态机已校验：unknown_effect → succeeded/failed 是合法迁移
 // （见 tool-call-queries.ts TOOL_CALL_STATE_TRANSITIONS）。
 const toolCallSetFields: Record<string, unknown> = {
 callState: newCallState,
 updatedAt: now,
 };
 // 进入 succeeded/failed 时设置 finishedAt（若尚未设置）
 if (newCallState === "succeeded" || newCallState === "failed") {
 if (!toolCall.finishedAt) {
 toolCallSetFields.finishedAt = now;
 }
 }
 await tx
 .update(toolCallTable)
 .set(toolCallSetFields)
 .where(
 and(eq(toolCallTable.tenantId, input.tenantId), eq(toolCallTable.id, input.toolCallId)),
 );
 }

 // 5. 回查最新状态
 const [updatedRecord] = await tx
 .select()
 .from(effectRecordTable)
 .where(eq(effectRecordTable.id, record.id))
 .limit(1);
 if (!updatedRecord) {
 throw new EffectNotFoundError("EffectRecord reconcile 后回查失败");
 }

 const [updatedToolCall] = await tx
 .select()
 .from(toolCallTable)
 .where(eq(toolCallTable.id, input.toolCallId))
 .limit(1);
 if (!updatedToolCall) {
 throw new EffectNotFoundError("ToolCall reconcile 后回查失败");
 }

 // 计算目标计数
 let successCount = 0;
 let failureCount = 0;
 let unknownCount = 0;
 for (const t of updatedTargets) {
 if (t.targetState === "confirmed_success") successCount++;
 else if (t.targetState === "confirmed_failure") failureCount++;
 else unknownCount++;
 }

 return {
 effectRecord: updatedRecord,
 effectTargets: updatedTargets,
 toolCall: updatedToolCall,
 targetsCount: {
 total: updatedTargets.length,
 confirmed_success: successCount,
 confirmed_failure: failureCount,
 unknown: unknownCount,
 },
 };
 });
}

// ─── 便捷函数 ─────────────────────────────────────────────

/**
 * 标记 ToolCall 进入 unknown_effect 状态（执行超时 / 副作用未确认时调用）。
 *
 * 同时创建 EffectRecord（若尚未创建）+ 可选的 EffectTarget。
 * 调用方应在 Tool 执行超时时调用本函数，避免直接置为 failed（）。
 */
export async function markToolCallUnknownEffect(input: {
 tenantId: string;
 toolCallId: string;
 effectType: EffectType;
 targetSummaryJson: unknown;
 targets?: readonly CreateEffectTargetItem[];
 externalIdempotencyKey?: string | null;
}): Promise<{ effectRecord: EffectRecord; effectTargets: EffectTarget[] }> {
 if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
 if (!input.toolCallId) throw new EffectValidationError("toolCallId 不能为空");

 // 先校验 ToolCall 存在（跨租户隔离）——必须在创建 EffectRecord 之前，
 // 否则跨租户调用会因 tenantId FK 约束直接抛底层 DB 错误而非 EffectNotFoundError。
 const toolCall = await getToolCallById({
 tenantId: input.tenantId,
 toolCallId: input.toolCallId,
 });
 if (!toolCall) {
 throw new EffectNotFoundError(`ToolCall 不存在或跨租户不可见: ${input.toolCallId}`);
 }

 // 幂等：若 EffectRecord 已存在，跳过创建
 let record = await getEffectRecordByToolCall(input.tenantId, input.toolCallId);
 if (!record) {
 record = await createEffectRecord({
 tenantId: input.tenantId,
 toolCallId: input.toolCallId,
 effectType: input.effectType,
 targetSummaryJson: input.targetSummaryJson,
 externalIdempotencyKey: input.externalIdempotencyKey ?? null,
 initialEffectState: "unknown_effect",
 });
 }

 let targets: EffectTarget[] = [];
 if (input.targets && input.targets.length > 0) {
 targets = await listEffectTargets(input.tenantId, record.id);
 if (targets.length === 0) {
 targets = await createEffectTargets({
 tenantId: input.tenantId,
 effectRecordId: record.id,
 targets: input.targets,
 });
 }
 }

 // 同步迁移 ToolCall 到 unknown_effect 状态（通过 updateToolCallState 走状态机校验）
 if (toolCall.callState !== "unknown_effect") {
 await updateToolCallState({
 tenantId: input.tenantId,
 toolCallId: input.toolCallId,
 toState: "unknown_effect",
 });
 }

 return { effectRecord: record, effectTargets: targets };
}
