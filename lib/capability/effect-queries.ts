/**
 * EffectRecord + EffectTarget 仓储。
 *
 * 事实源：
 * - docs/architecture/persistence.md （effect_record 与 effect_target）、
 * （tool_call.call_state 与 effect_state 同步）、（ToolCall、Effect 与 Credential）。
 * - docs/architecture/domain-model.md §10 第 9 条（unknown_effect 不自动重放）。
 * - docs/architecture/api-and-events.md （Gateway 即时核对）、
 * （Admin 长期核对 + 同事务更新 tool_call.call_state + AuditEvent）。
 * - docs/architecture/capabilities-and-security.md 。
 * - docs/topic02/nexharness-topic02-closure/repairs/10-topic03-interfaces.md §T32。
 *
 * 关键不变量：
 * - Owner 多态（tool_call / job_step）：ownerRef 必须回读真实源对象并通过
 * tenant / Invocation 校验（见 lib/capability/effect-owner.ts），不看字符串格式。
 * - UNIQUE(tenantId, ownerKind, ownerRef, operationKey) 是外部操作身份；
 * tool_call 分支另有 UNIQUE(tenantId, toolOwnerSlot) 兜底「一 ToolCall 一 Effect」。
 * - effect_target 通过 UNIQUE(effectRecordId, targetHash) 防止同目标重复记录。
 * - 总 effect_state 由目标明细派生：confirmed_success / confirmed_partial /
 * confirmed_failure / unknown_effect。
 * - 写入后不可变：effect_type / ownerKind / ownerRef / invocationId / operationKey /
 * requestDigest 不可修改；dispatchEvidence 一旦非 null 语义不可覆写。
 * - reconcile 同事务更新：effect_record + effect_target + tool_call.call_state
 * （仅 tool_call owner 有 ToolCall 可同步）。
 * - unknown_effect 不能自动重放；partial success 只允许重试明确失败且安全的目标。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { createHash, randomUUID } from "node:crypto";
import { type ResolvedEffectOwner, resolveEffectOwner } from "@/lib/capability/effect-owner";
import { getToolCallById, updateToolCallState } from "@/lib/capability/tool-call-queries";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  ADMIN_VERIFICATION_METHODS,
  EFFECT_STATES,
  EFFECT_TARGET_STATES,
  EFFECT_TYPES,
  type EffectDispatchEvidence,
  type EffectOwnerKind,
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
  toolCallOperationKey,
} from "@/lib/persistence/schema/effect";
import { type ToolCall, toolCallTable } from "@/lib/persistence/schema/tool-call";
import { and, asc, eq, inArray } from "drizzle-orm";

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

/**
 * 派发意图证据已存在且与新提交内容不一致。
 *
 * 首次派发证据是外部副作用的代际事实，不允许被后续 Attempt 覆写
 * （否则「意图已写但可能尚未发出」的保守核对语义会失去依据）。
 */
export class EffectDispatchEvidenceImmutableError extends Error {
  public readonly effectRecordId: string;

  constructor(effectRecordId: string) {
    super(`EffectRecord ${effectRecordId} 的首次派发意图证据已固定，不可覆写`);
    this.name = "EffectDispatchEvidenceImmutableError";
    this.effectRecordId = effectRecordId;
  }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_EFFECT_TYPES = new Set<string>(EFFECT_TYPES);
const VALID_EFFECT_STATES = new Set<string>(EFFECT_STATES);
const VALID_TARGET_STATES = new Set<string>(EFFECT_TARGET_STATES);
const VALID_VERIFICATION_METHODS = new Set<string>(VERIFICATION_METHODS);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

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

/** requestDigest 语义一致：外部目标 / 连接身份 / 动作与参数的 JCS+SHA256。 */
export function isValidRequestDigest(digest: string): boolean {
  return SHA256_DIGEST.test(digest);
}

/** 计算 requestDigest（对 canonical 输入做 SHA256）。 */
export function computeEffectRequestDigest(input: unknown): string {
  const hex = createHash("sha256").update(canonicalize(input), "utf-8").digest("hex");
  return `sha256:${hex}`;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return result;
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
  /** 多态 owner 类别；无默认值，必须显式给出。 */
  ownerKind: EffectOwnerKind;
  /** ToolCall.id（tool_call）或 job.step.accepted 的 Ingress id（job_step）。 */
  ownerRef: string;
  /** 调用方声明的所属 Invocation；必须与源对象真实归属一致。 */
  invocationId: string;
  /** owner 内稳定逻辑外部操作键；tool_call 分支固定为 ToolCall.id。 */
  operationKey?: string;
  /** 外部目标 / 连接身份 / 动作与参数的语义 Hash（sha256: + 64 hex）。 */
  requestDigest: string;
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
 * 创建 EffectRecord（owner 内逻辑操作身份唯一）。
 *
 * 关键行为：
 * - 单事务：回读真实 owner 源对象 → 校验 tenant/Invocation → 插入。
 * - 同一 (ownerKind, ownerRef, operationKey) 已存在时抛 EffectValidationError
 * （不返回幂等行，强制调用方走查询路径）。
 * - tool_call 分支的 operationKey 固定为 ToolCall.id；不允许调用方自定义，
 * 否则一个 ToolCall 会出现多个逻辑操作身份。
 * - 不创建 EffectTarget；调用方应紧接着调用 createEffectTargets。
 */
export async function createEffectRecord(
  input: CreateEffectRecordInput,
  tx?: DbOrTx,
): Promise<EffectRecord> {
  if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
  if (!input.ownerRef) throw new EffectValidationError("ownerRef 不能为空");
  if (!input.invocationId) throw new EffectValidationError("invocationId 不能为空");
  if (!isEffectType(input.effectType)) {
    throw new EffectValidationError(`非法 effectType: ${input.effectType}`);
  }
  if (!isValidRequestDigest(input.requestDigest)) {
    throw new EffectValidationError("requestDigest 格式非法（需 sha256: + 64 hex）");
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

  const run = async (source: DbOrTx): Promise<EffectRecord> => {
    const owner = await resolveEffectOwner(source, {
      tenantId: input.tenantId,
      ownerKind: input.ownerKind,
      ownerRef: input.ownerRef,
      invocationId: input.invocationId,
    });
    const operationKey = resolveOperationKey(owner, input.operationKey);
    if (operationKey.length > 128) {
      throw new EffectValidationError("operationKey 长度不能超过 128");
    }
    const existing = await findEffectByOwnerKey(
      source,
      input.tenantId,
      input.ownerKind,
      owner.ownerRef,
      operationKey,
    );
    if (existing) {
      throw new EffectValidationError(
        `EffectRecord 已存在（ownerKind=${input.ownerKind}, ownerRef=${owner.ownerRef}, operationKey=${operationKey}）；逻辑操作身份唯一约束禁止二次创建`,
      );
    }

    const id = randomUUID();
    const now = new Date();
    const insert: NewEffectRecord = {
      id,
      tenantId: input.tenantId,
      ownerKind: input.ownerKind,
      ownerRef: owner.ownerRef,
      invocationId: owner.invocationId,
      operationKey,
      requestDigest: input.requestDigest,
      effectType: input.effectType,
      targetSummaryJson: input.targetSummaryJson,
      effectState: input.initialEffectState ?? "not_started",
      externalIdempotencyKey: input.externalIdempotencyKey ?? null,
      externalResultRef: input.externalResultRef ?? null,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    };

    await source.insert(effectRecordTable).values(insert);
    const created = await getEffectRecordById(input.tenantId, id, source);
    if (!created) {
      throw new EffectNotFoundError("EffectRecord 创建后回查失败");
    }
    return created;
  };

  return tx ? run(tx) : db.transaction(run);
}

function resolveOperationKey(owner: ResolvedEffectOwner, requested?: string): string {
  if (owner.ownerKind === "tool_call") {
    // 一 ToolCall 只有一个外部操作身份；不接受调用方另行指定。
    if (requested && requested !== owner.operationKey) {
      throw new EffectValidationError(
        `tool_call owner 的 operationKey 固定为 ToolCall 唯一外部操作身份（${owner.operationKey}），不接受自定义值`,
      );
    }
    return owner.operationKey;
  }
  if (!requested) {
    throw new EffectValidationError("job_step owner 必须显式提供 operationKey");
  }
  return requested;
}

async function findEffectByOwnerKey(
  source: DbOrTx,
  tenantId: string,
  ownerKind: EffectOwnerKind,
  ownerRef: string,
  operationKey: string,
): Promise<EffectRecord | null> {
  const [row] = await source
    .select()
    .from(effectRecordTable)
    .where(
      and(
        eq(effectRecordTable.tenantId, tenantId),
        eq(effectRecordTable.ownerKind, ownerKind),
        eq(effectRecordTable.ownerRef, ownerRef),
        eq(effectRecordTable.operationKey, operationKey),
      ),
    )
    .limit(1);
  return row ?? null;
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
  tx?: DbOrTx,
): Promise<EffectTarget[]> {
  if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
  if (!input.effectRecordId) throw new EffectValidationError("effectRecordId 不能为空");
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    throw new EffectValidationError("targets 必须是非空数组");
  }
  const source = tx ?? db;

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

  await source.insert(effectTargetTable).values(rows);
  return source
    .select()
    .from(effectTargetTable)
    .where(eq(effectTargetTable.effectRecordId, input.effectRecordId))
    .orderBy(asc(effectTargetTable.targetHash));
}

// ─── 查询 ─────────────────────────────────────────────────

export async function getEffectRecordById(
  tenantId: string,
  effectRecordId: string,
  tx?: DbOrTx,
): Promise<EffectRecord | null> {
  const [row] = await (tx ?? db)
    .select()
    .from(effectRecordTable)
    .where(and(eq(effectRecordTable.tenantId, tenantId), eq(effectRecordTable.id, effectRecordId)))
    .limit(1);
  return row ?? null;
}

/**
 * 按多态 owner 逻辑操作身份查询 EffectRecord。
 *
 * operationKey 省略时返回该 owner 的任意一条（tool_call 分支至多一条）。
 */
export async function getEffectRecordByOwner(
  tenantId: string,
  ownerKind: EffectOwnerKind,
  ownerRef: string,
  operationKey?: string,
  tx?: DbOrTx,
): Promise<EffectRecord | null> {
  const conditions = [
    eq(effectRecordTable.tenantId, tenantId),
    eq(effectRecordTable.ownerKind, ownerKind),
    eq(effectRecordTable.ownerRef, ownerRef),
  ];
  if (operationKey) conditions.push(eq(effectRecordTable.operationKey, operationKey));
  const [row] = await (tx ?? db)
    .select()
    .from(effectRecordTable)
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/** ToolCall owner 的一对一 EffectRecord（沿用旧调用点语义）。 */
export async function getEffectRecordByToolCall(
  tenantId: string,
  toolCallId: string,
  tx?: DbOrTx,
): Promise<EffectRecord | null> {
  return getEffectRecordByOwner(tenantId, "tool_call", toolCallId, undefined, tx);
}

export async function listEffectTargets(
  tenantId: string,
  effectRecordId: string,
  tx?: DbOrTx,
): Promise<EffectTarget[]> {
  return (tx ?? db)
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
 * 列出某 Invocation 的全部 EffectRecord（tool_call 与 job_step 两类都可见）。
 *
 * 直接按 EffectRecord.invocationId 过滤：不再 INNER JOIN ToolCall，
 * 否则 job_step Effect（没有 ToolCall）会被静默丢弃。
 */
export async function listEffectRecordsByInvocation(
  tenantId: string,
  invocationId: string,
  tx?: DbOrTx,
): Promise<EffectRecord[]> {
  return (tx ?? db)
    .select()
    .from(effectRecordTable)
    .where(
      and(
        eq(effectRecordTable.tenantId, tenantId),
        eq(effectRecordTable.invocationId, invocationId),
      ),
    )
    .orderBy(asc(effectRecordTable.createdAt), asc(effectRecordTable.id));
}

/** 列出某 Invocation 处于指定状态的 EffectRecord（Job 收口 / 清理路径使用）。 */
export async function listEffectRecordsByInvocationState(
  tenantId: string,
  invocationId: string,
  states: readonly EffectState[],
  tx?: DbOrTx,
): Promise<EffectRecord[]> {
  if (states.length === 0) return [];
  return (tx ?? db)
    .select()
    .from(effectRecordTable)
    .where(
      and(
        eq(effectRecordTable.tenantId, tenantId),
        eq(effectRecordTable.invocationId, invocationId),
        inArray(effectRecordTable.effectState, [...states]),
      ),
    )
    .orderBy(asc(effectRecordTable.createdAt), asc(effectRecordTable.id));
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

// ─── 派发意图（不可覆写） ─────────────────────────────────

export interface RecordEffectDispatchIntentInput {
  tenantId: string;
  effectRecordId: string;
  /** 首次派发的执行身份（十进制字符串保持 BIGINT 精度）。 */
  authority: EffectDispatchEvidence["authority"];
  /** 首次派发目标（Provider / Connection / 端点指纹；不含凭据明文）。 */
  provider: EffectDispatchEvidence["provider"];
  /** 派发时冻结的请求摘要；必须等于该 EffectRecord 的 requestDigest。 */
  requestDigest: string;
  recordedAt?: Date;
}

/**
 * 记录「首次外部派发意图」。
 *
 * 语义边界：记录的是意图，不是送达。Crash 在意图已写但可能尚未发出时，
 * 后续接管者必须保守进入核对（unknown_effect），不能自动重复外部写入。
 *
 * - 第一次调用写入 dispatchIntentAt + dispatchEvidence。
 * - 已有值且与本次内容 canonical 相等 → 幂等返回。
 * - 已有值但内容不同 → EffectDispatchEvidenceImmutableError（不覆写代际事实）。
 */
export async function recordEffectDispatchIntent(
  input: RecordEffectDispatchIntentInput,
  tx?: DbOrTx,
): Promise<EffectRecord> {
  if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
  if (!input.effectRecordId) throw new EffectValidationError("effectRecordId 不能为空");
  if (!isValidRequestDigest(input.requestDigest)) {
    throw new EffectValidationError("requestDigest 格式非法（需 sha256: + 64 hex）");
  }

  const run = async (source: DbOrTx): Promise<EffectRecord> => {
    const record = await getEffectRecordById(input.tenantId, input.effectRecordId, source);
    if (!record) {
      throw new EffectNotFoundError(
        `EffectRecord 不存在或跨租户不可见（id=${input.effectRecordId}）`,
      );
    }
    if (record.requestDigest !== input.requestDigest) {
      throw new EffectValidationError(
        `派发意图 requestDigest 与 EffectRecord 冻结值不一致（record=${record.requestDigest}, intent=${input.requestDigest}）`,
      );
    }
    const at = input.recordedAt ?? new Date();
    const evidence: EffectDispatchEvidence = {
      authority: input.authority,
      provider: input.provider,
      requestDigest: input.requestDigest,
      recordedAt: at.toISOString(),
    };
    if (record.dispatchIntentAt || record.dispatchEvidence) {
      if (record.dispatchEvidence && sameDispatchEvidence(record.dispatchEvidence, evidence)) {
        return record;
      }
      throw new EffectDispatchEvidenceImmutableError(record.id);
    }
    await source
      .update(effectRecordTable)
      .set({
        dispatchIntentAt: at,
        dispatchEvidence: evidence,
        versionNo: record.versionNo + 1,
        updatedAt: at,
      })
      .where(
        and(eq(effectRecordTable.tenantId, input.tenantId), eq(effectRecordTable.id, record.id)),
      );
    const updated = await getEffectRecordById(input.tenantId, record.id, source);
    if (!updated) throw new EffectNotFoundError("EffectRecord 派发意图写入后回查失败");
    return updated;
  };

  return tx ? run(tx) : db.transaction(run);
}

function sameDispatchEvidence(a: EffectDispatchEvidence, b: EffectDispatchEvidence): boolean {
  // 只比较代际事实本身，忽略记录时间（同一意图重试会带来不同 recordedAt）。
  return (
    canonicalize({
      authority: a.authority,
      provider: a.provider,
      requestDigest: a.requestDigest,
    }) ===
    canonicalize({ authority: b.authority, provider: b.provider, requestDigest: b.requestDigest })
  );
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
  /** 目标 EffectRecord；按主键定位，避免依赖任一 owner 分支。 */
  effectRecordId: string;
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
  /** Provider 已脱敏的结果摘要；与 effect/call terminal 在同一事务写入。 */
  resultSummaryJson?: unknown;
  /** Gateway 路径 + tool_call owner 必填：必须与原 ToolCall.operationId 一致。 */
  expectedOperationId?: string;
  /** 调用者标识（用于审计；本仓储不写 AuditEvent，由调用方在更高层补充）。 */
  reconciledBy?: string;
}

export interface ReconcileEffectResult {
  effectRecord: EffectRecord;
  effectTargets: EffectTarget[];
  /** 核对后的 ToolCall；job_step owner 没有 ToolCall，固定为 null（不伪造）。 */
  toolCall: ToolCall | null;
  /** 派生的目标计数（与 API 响应 targets 字段一致）。 */
  targetsCount: {
    total: number;
    confirmed_success: number;
    confirmed_failure: number;
    unknown: number;
  };
}

/**
 * 核对外部副作用（Gateway 即时核对 / Admin 长期核对）。
 *
 * 关键规则：
 * - path=gateway：仅允许 verification_method=provider_query；tool_call owner 必须提供
 * expectedOperationId 且匹配原 ToolCall.operationId（job_step 没有 operationId，不比对）。
 * - path=admin：允许 provider_query / callback_evidence / manual_evidence。
 * - EffectRecord 当前状态不能为 confirmed_*（终态不可再 reconcile）；unknown_effect 可多次 reconcile。
 * - 同事务更新：effect_record + effect_target + tool_call.call_state（仅 tool_call owner）。
 * - targetUpdates 中的 targetHash 必须匹配现有 EffectTarget；不存在的抛 EffectTargetNotFoundError。
 * - 派生新 effect_state：confirmed_success → call_state=succeeded；
 * confirmed_failure → call_state=failed；confirmed_partial → call_state=unknown_effect。
 *
 * 注意：ThreadEvent / AuditEvent 不在本仓储写入；由调用方在更高层同事务或后续写入。
 */
export async function reconcileEffect(
  input: ReconcileEffectInput,
  sourceTx?: DbOrTx,
): Promise<ReconcileEffectResult> {
  if (!input.tenantId) throw new EffectValidationError("tenantId 不能为空");
  if (!input.effectRecordId) throw new EffectValidationError("effectRecordId 不能为空");
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

  // 查询现有 EffectRecord（+ tool_call owner 的 ToolCall）
  const record = await getEffectRecordById(input.tenantId, input.effectRecordId, sourceTx);
  if (!record) {
    throw new EffectNotFoundError(
      `EffectRecord 不存在或跨租户不可见（id=${input.effectRecordId}）`,
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

  const toolCall =
    record.ownerKind === "tool_call"
      ? await getToolCallById({ tenantId: input.tenantId, toolCallId: record.ownerRef }, sourceTx)
      : null;
  if (record.ownerKind === "tool_call" && !toolCall) {
    throw new EffectNotFoundError(`ToolCall 不存在或跨租户不可见: ${record.ownerRef}`);
  }

  if (input.path === "gateway") {
    if (record.ownerKind === "tool_call") {
      if (!input.expectedOperationId) {
        throw new EffectValidationError(
          "gateway 路径的 tool_call Effect 必须提供 expectedOperationId",
        );
      }
      if (input.expectedOperationId !== toolCall?.operationId) {
        throw new EffectOperationMismatchError(
          input.expectedOperationId,
          toolCall?.operationId ?? "",
        );
      }
    }
  }

  const existingTargets = await listEffectTargets(input.tenantId, record.id, sourceTx);
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
  const applyReconciliation = async (tx: DbOrTx) => {
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

    // 4. 同步更新 ToolCall.call_state（仅 tool_call owner 有 ToolCall）
    // - confirmed_success → succeeded
    // - confirmed_partial → unknown_effect
    // - confirmed_failure → failed
    // - unknown_effect 保持原状
    let newCallState: ToolCall["callState"] | null = null;
    if (newEffectState === "confirmed_success") {
      newCallState = "succeeded";
    } else if (newEffectState === "confirmed_failure") {
      newCallState = "failed";
    } else if (newEffectState === "confirmed_partial") {
      newCallState = "unknown_effect";
    }

    if (toolCall && newCallState) {
      const toolCallSetFields: Record<string, unknown> = {
        callState: newCallState,
        updatedAt: now,
      };
      if (input.resultSummaryJson !== undefined) {
        toolCallSetFields.resultSummaryJson = input.resultSummaryJson;
      }
      // 进入 succeeded/failed 时设置 finishedAt（若尚未设置）
      if (newCallState === "succeeded" || newCallState === "failed") {
        if (!toolCall.finishedAt) {
          toolCallSetFields.finishedAt = now;
        }
      }
      await tx
        .update(toolCallTable)
        .set(toolCallSetFields)
        .where(and(eq(toolCallTable.tenantId, input.tenantId), eq(toolCallTable.id, toolCall.id)));
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

    let updatedToolCall: ToolCall | null = null;
    if (toolCall) {
      const [row] = await tx
        .select()
        .from(toolCallTable)
        .where(eq(toolCallTable.id, toolCall.id))
        .limit(1);
      if (!row) {
        throw new EffectNotFoundError("ToolCall reconcile 后回查失败");
      }
      updatedToolCall = row;
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
  };
  return sourceTx ? applyReconciliation(sourceTx) : db.transaction(applyReconciliation);
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
      ownerKind: "tool_call",
      ownerRef: input.toolCallId,
      invocationId: toolCall.invocationId,
      operationKey: toolCallOperationKey(input.toolCallId),
      requestDigest: toolCall.argumentsHash,
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
