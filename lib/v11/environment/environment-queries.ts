/**
 * V11 Environment 仓储：EnvironmentDefinition / EnvironmentLease /
 * EnvironmentChangeRequest CRUD + ExecutionOwnership 管理 + 跨租户隔离。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.13（execution_ownership 与
 *   environment_change_request）、§7.2（environment_definition 与 environment_lease）。
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §11（Execution Environment）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W02。
 *
 * 关键不变量：
 * - EnvironmentDefinition.archived 后不允许新 Lease 引用。
 * - EnvironmentLease 一经创建不可改 environmentDefinitionId（不可变绑定）；
 *   只能改 leaseState、lastHeartbeatAt、releasedAt。
 * - Desktop Lease 必含 deviceId；Cloud/Remote/Sandbox 可空。
 * - 终态 Lease 不可恢复；状态机：allocated → active → releasing → released/expired/lost。
 * - EnvironmentChangeRequest 当前 Invocation 热迁移必须 Runtime capability 支持；
 *   否则只影响下一 Invocation（accepted_for_next_invocation）。
 * - ExecutionOwnership.leaseEpoch 单调递增，UNIQUE(invocationId, leaseEpoch)；
 *   同一 Invocation 同一时刻只有一个 active ownership。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { db } from "@/lib/db/client";
import {
  ENVIRONMENT_CHANGE_REQUEST_STATES,
  ENVIRONMENT_CHANGE_REQUEST_TERMINAL_STATES,
  ENVIRONMENT_DEFINITION_LIFECYCLE_STATES,
  ENVIRONMENT_LEASE_STATES,
  ENVIRONMENT_LEASE_TERMINAL_STATES,
  ENVIRONMENT_TYPES,
  type EnvironmentChangeRequestState,
  type EnvironmentDefinitionLifecycleState,
  type EnvironmentLeaseState,
  type EnvironmentType,
  type V11EnvironmentChangeRequest,
  type V11EnvironmentChangeRequestInsert,
  type V11EnvironmentDefinition,
  type V11EnvironmentDefinitionInsert,
  type V11EnvironmentLease,
  type V11EnvironmentLeaseInsert,
  v11EnvironmentChangeRequest,
  v11EnvironmentDefinition,
  v11EnvironmentLease,
} from "@/lib/v11/schema/environment";
import { type ExecutionOwnershipState, v11ExecutionOwnership } from "@/lib/v11/schema/runtime";
import { and, desc, eq, isNotNull, lt, ne } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class EnvironmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentValidationError";
  }
}

export class EnvironmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentNotFoundError";
  }
}

export class EnvironmentLeaseConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseConflictError";
  }
}

export class EnvironmentLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentLeaseStateError";
  }
}

export class EnvironmentChangeRequestStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentChangeRequestStateError";
  }
}

export class EnvironmentVersionConflictError extends Error {
  public readonly expectedVersionNo: number;
  public readonly actualVersionNo: number;

  constructor(message: string, expectedVersionNo: number, actualVersionNo: number) {
    super(message);
    this.name = "EnvironmentVersionConflictError";
    this.expectedVersionNo = expectedVersionNo;
    this.actualVersionNo = actualVersionNo;
  }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_ENVIRONMENT_TYPES = new Set<string>(ENVIRONMENT_TYPES);
const VALID_DEFINITION_LIFECYCLE = new Set<string>(ENVIRONMENT_DEFINITION_LIFECYCLE_STATES);
const VALID_LEASE_STATES = new Set<string>(ENVIRONMENT_LEASE_STATES);
const VALID_CHANGE_REQUEST_STATES = new Set<string>(ENVIRONMENT_CHANGE_REQUEST_STATES);

export function isEnvironmentType(value: string): value is EnvironmentType {
  return VALID_ENVIRONMENT_TYPES.has(value);
}

export function isEnvironmentDefinitionLifecycleState(
  value: string,
): value is EnvironmentDefinitionLifecycleState {
  return VALID_DEFINITION_LIFECYCLE.has(value);
}

export function isEnvironmentLeaseState(value: string): value is EnvironmentLeaseState {
  return VALID_LEASE_STATES.has(value);
}

export function isEnvironmentChangeRequestState(
  value: string,
): value is EnvironmentChangeRequestState {
  return VALID_CHANGE_REQUEST_STATES.has(value);
}

export function isValidEnvironmentKey(key: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(key);
}

/** 默认空策略 JSON（避免每次调用都要构造）。 */
export const DEFAULT_ENVIRONMENT_POLICIES = {
  filesystem: { allowPaths: [], denyPaths: [], defaultAccessMode: "read" as const },
  network: { allowDomains: [], denyDomains: [], allowEgress: false },
  resourceLimits: { cpuMillis: 1000, memoryMb: 1024, timeoutSeconds: 300, maxConcurrency: 1 },
  secret: { allowedCredentialRefIds: [], injectionMode: "env" as const },
} satisfies V11EnvironmentDefinitionInsert["filesystemPolicyJson"];

// ─── EnvironmentDefinition CRUD ───────────────────────────

export interface CreateEnvironmentDefinitionInput {
  tenantId: string;
  environmentKey: string;
  displayName: string;
  description?: string;
  environmentType: EnvironmentType;
  filesystemPolicyJson?: V11EnvironmentDefinitionInsert["filesystemPolicyJson"];
  networkPolicyJson?: V11EnvironmentDefinitionInsert["networkPolicyJson"];
  resourceLimitsJson?: V11EnvironmentDefinitionInsert["resourceLimitsJson"];
  secretPolicyJson?: V11EnvironmentDefinitionInsert["secretPolicyJson"];
}

export async function createEnvironmentDefinition(
  input: CreateEnvironmentDefinitionInput,
): Promise<V11EnvironmentDefinition> {
  if (!input.tenantId) throw new EnvironmentValidationError("tenantId 不能为空");
  if (!isValidEnvironmentKey(input.environmentKey)) {
    throw new EnvironmentValidationError(
      "environmentKey 必须以字母开头，长度 1-128，仅允许字母数字、下划线、连字符",
    );
  }
  if (!input.displayName) throw new EnvironmentValidationError("displayName 不能为空");
  if (!isEnvironmentType(input.environmentType)) {
    throw new EnvironmentValidationError(`非法 environmentType: ${input.environmentType}`);
  }

  const insert: V11EnvironmentDefinitionInsert = {
    tenantId: input.tenantId,
    environmentKey: input.environmentKey,
    displayName: input.displayName,
    description: input.description ?? null,
    environmentType: input.environmentType,
    filesystemPolicyJson: input.filesystemPolicyJson ?? DEFAULT_ENVIRONMENT_POLICIES.filesystem,
    networkPolicyJson: input.networkPolicyJson ?? DEFAULT_ENVIRONMENT_POLICIES.network,
    resourceLimitsJson: input.resourceLimitsJson ?? DEFAULT_ENVIRONMENT_POLICIES.resourceLimits,
    secretPolicyJson: input.secretPolicyJson ?? DEFAULT_ENVIRONMENT_POLICIES.secret,
  };

  await db.insert(v11EnvironmentDefinition).values(insert);
  // MySQL 不支持 .returning()，回查。
  const created = await getEnvironmentDefinitionByKey(input.tenantId, input.environmentKey);
  if (!created) throw new EnvironmentNotFoundError("EnvironmentDefinition 创建后回查失败");
  return created;
}

export async function getEnvironmentDefinitionById(
  tenantId: string,
  id: string,
): Promise<V11EnvironmentDefinition | null> {
  const [row] = await db
    .select()
    .from(v11EnvironmentDefinition)
    .where(
      and(eq(v11EnvironmentDefinition.tenantId, tenantId), eq(v11EnvironmentDefinition.id, id)),
    )
    .limit(1);
  return row ?? null;
}

export async function getEnvironmentDefinitionByKey(
  tenantId: string,
  environmentKey: string,
): Promise<V11EnvironmentDefinition | null> {
  const [row] = await db
    .select()
    .from(v11EnvironmentDefinition)
    .where(
      and(
        eq(v11EnvironmentDefinition.tenantId, tenantId),
        eq(v11EnvironmentDefinition.environmentKey, environmentKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listEnvironmentDefinitions(
  tenantId: string,
  options?: {
    environmentType?: EnvironmentType;
    lifecycleState?: EnvironmentDefinitionLifecycleState;
    limit?: number;
  },
): Promise<V11EnvironmentDefinition[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [eq(v11EnvironmentDefinition.tenantId, tenantId)];

  if (options?.environmentType) {
    conditions.push(eq(v11EnvironmentDefinition.environmentType, options.environmentType));
  }
  if (options?.lifecycleState) {
    conditions.push(eq(v11EnvironmentDefinition.lifecycleState, options.lifecycleState));
  } else {
    // 默认排除 deleted。
    conditions.push(ne(v11EnvironmentDefinition.lifecycleState, "deleted"));
  }

  return db
    .select()
    .from(v11EnvironmentDefinition)
    .where(and(...conditions))
    .orderBy(desc(v11EnvironmentDefinition.updatedAt))
    .limit(limit);
}

export async function archiveEnvironmentDefinition(
  tenantId: string,
  id: string,
  expectedVersionNo: number,
): Promise<V11EnvironmentDefinition> {
  const current = await getEnvironmentDefinitionById(tenantId, id);
  if (!current) throw new EnvironmentNotFoundError(`EnvironmentDefinition ${id} 不存在`);
  if (current.versionNo !== expectedVersionNo) {
    throw new EnvironmentVersionConflictError(
      `EnvironmentDefinition 版本号不匹配：期望 ${expectedVersionNo}，实际 ${current.versionNo}`,
      expectedVersionNo,
      current.versionNo,
    );
  }
  if (current.lifecycleState === "deleted") {
    throw new EnvironmentValidationError("已删除的 EnvironmentDefinition 不能归档");
  }
  if (current.lifecycleState === "archived") {
    throw new EnvironmentValidationError("EnvironmentDefinition 已归档");
  }

  await db
    .update(v11EnvironmentDefinition)
    .set({
      lifecycleState: "archived",
      updatedAt: new Date(),
      versionNo: expectedVersionNo + 1,
    })
    .where(
      and(
        eq(v11EnvironmentDefinition.tenantId, tenantId),
        eq(v11EnvironmentDefinition.id, id),
        eq(v11EnvironmentDefinition.versionNo, expectedVersionNo),
      ),
    );

  const updated = await getEnvironmentDefinitionById(tenantId, id);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentDefinition 归档后回查失败");
  return updated;
}

// ─── EnvironmentLease CRUD ────────────────────────────────

export interface CreateEnvironmentLeaseInput {
  tenantId: string;
  environmentDefinitionId: string;
  invocationId: string;
  attemptId: string;
  deviceId?: string;
  workerRef?: string;
  capabilitiesJson?: V11EnvironmentLeaseInsert["capabilitiesJson"];
  expiresAt?: Date;
}

export async function createEnvironmentLease(
  input: CreateEnvironmentLeaseInput,
): Promise<V11EnvironmentLease> {
  if (!input.tenantId) throw new EnvironmentValidationError("tenantId 不能为空");
  if (!input.environmentDefinitionId) {
    throw new EnvironmentValidationError("environmentDefinitionId 不能为空");
  }
  if (!input.invocationId) throw new EnvironmentValidationError("invocationId 不能为空");
  if (!input.attemptId) throw new EnvironmentValidationError("attemptId 不能为空");

  const definition = await getEnvironmentDefinitionById(
    input.tenantId,
    input.environmentDefinitionId,
  );
  if (!definition) {
    throw new EnvironmentNotFoundError(
      `EnvironmentDefinition ${input.environmentDefinitionId} 不存在`,
    );
  }
  if (definition.lifecycleState !== "active") {
    throw new EnvironmentValidationError(
      `EnvironmentDefinition 状态非 active：${definition.lifecycleState}`,
    );
  }
  // Desktop Lease 必含 deviceId。
  if (definition.environmentType === "desktop" && !input.deviceId) {
    throw new EnvironmentValidationError("Desktop EnvironmentLease 必须提供 deviceId");
  }
  // Cloud/Remote/Sandbox 不允许 deviceId（避免误绑定具体设备）。
  if (definition.environmentType !== "desktop" && input.deviceId) {
    throw new EnvironmentValidationError(
      `${definition.environmentType} EnvironmentLease 不允许 deviceId`,
    );
  }

  const insert: V11EnvironmentLeaseInsert = {
    tenantId: input.tenantId,
    environmentDefinitionId: input.environmentDefinitionId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    deviceId: input.deviceId ?? null,
    workerRef: input.workerRef ?? null,
    leaseState: "allocated",
    capabilitiesJson: input.capabilitiesJson ?? null,
    expiresAt: input.expiresAt ?? null,
  };

  await db.insert(v11EnvironmentLease).values(insert);
  const [created] = await db
    .select()
    .from(v11EnvironmentLease)
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, input.tenantId),
        eq(v11EnvironmentLease.invocationId, input.invocationId),
        eq(v11EnvironmentLease.attemptId, input.attemptId),
      ),
    )
    .limit(1);
  if (!created) throw new EnvironmentNotFoundError("EnvironmentLease 创建后回查失败");
  return created;
}

export async function getEnvironmentLeaseById(
  tenantId: string,
  id: string,
): Promise<V11EnvironmentLease | null> {
  const [row] = await db
    .select()
    .from(v11EnvironmentLease)
    .where(and(eq(v11EnvironmentLease.tenantId, tenantId), eq(v11EnvironmentLease.id, id)))
    .limit(1);
  return row ?? null;
}

export async function listEnvironmentLeasesByInvocation(
  tenantId: string,
  invocationId: string,
): Promise<V11EnvironmentLease[]> {
  return db
    .select()
    .from(v11EnvironmentLease)
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        eq(v11EnvironmentLease.invocationId, invocationId),
      ),
    )
    .orderBy(desc(v11EnvironmentLease.createdAt));
}

/**
 * 在事务内通过 SELECT FOR UPDATE 锁定 Lease 行并切换状态。
 *
 * 校验：
 * - 当前 leaseState 必须在允许的前置状态集合中。
 * - 终态 Lease 不可恢复。
 *
 * @returns 更新后的 Lease；如果未命中返回 null
 */
async function transitionLeaseState(
  tenantId: string,
  leaseId: string,
  nextState: EnvironmentLeaseState,
  allowedFrom: EnvironmentLeaseState[],
  patch: Partial<V11EnvironmentLease> = {},
): Promise<V11EnvironmentLease> {
  const current = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!current) {
    throw new EnvironmentNotFoundError(`EnvironmentLease ${leaseId} 不存在`);
  }
  if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 已是终态 ${current.leaseState}，不可恢复`,
    );
  }
  if (!allowedFrom.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 状态 ${current.leaseState} 不允许切换到 ${nextState}`,
    );
  }

  await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: nextState,
      updatedAt: new Date(),
      ...patch,
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        eq(v11EnvironmentLease.id, leaseId),
        eq(v11EnvironmentLease.leaseState, current.leaseState),
      ),
    );

  const updated = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentLease 更新后回查失败");
  return updated;
}

/** allocated → active：Runtime 开始使用此 Lease。 */
export async function activateEnvironmentLease(
  tenantId: string,
  leaseId: string,
  heartbeatAt?: Date,
): Promise<V11EnvironmentLease> {
  return transitionLeaseState(tenantId, leaseId, "active", ["allocated"], {
    lastHeartbeatAt: heartbeatAt ?? new Date(),
  });
}

/** 更新 Lease 心跳时间（任意非终态 Lease）。 */
export async function heartbeatEnvironmentLease(
  tenantId: string,
  leaseId: string,
  heartbeatAt?: Date,
): Promise<V11EnvironmentLease> {
  const current = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!current) throw new EnvironmentNotFoundError(`EnvironmentLease ${leaseId} 不存在`);
  if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 已是终态 ${current.leaseState}，不可心跳`,
    );
  }
  await db
    .update(v11EnvironmentLease)
    .set({
      lastHeartbeatAt: heartbeatAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(v11EnvironmentLease.tenantId, tenantId), eq(v11EnvironmentLease.id, leaseId)));
  const updated = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentLease 心跳后回查失败");
  return updated;
}

/** active → releasing：平台开始回收（运行中 ToolCall 完成后释放）。 */
export async function beginReleaseEnvironmentLease(
  tenantId: string,
  leaseId: string,
): Promise<V11EnvironmentLease> {
  return transitionLeaseState(tenantId, leaseId, "releasing", ["active"]);
}

/** releasing/active → released：主动释放（终态）。 */
export async function releaseEnvironmentLease(
  tenantId: string,
  leaseId: string,
): Promise<V11EnvironmentLease> {
  const current = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!current) throw new EnvironmentNotFoundError(`EnvironmentLease ${leaseId} 不存在`);
  if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 已是终态 ${current.leaseState}，不可重复释放`,
    );
  }
  await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: "released",
      releasedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        eq(v11EnvironmentLease.id, leaseId),
        eq(v11EnvironmentLease.leaseState, current.leaseState),
      ),
    );
  const updated = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentLease 释放后回查失败");
  return updated;
}

/** 任意非终态 → expired：超时未心跳（终态）。 */
export async function expireEnvironmentLease(
  tenantId: string,
  leaseId: string,
): Promise<V11EnvironmentLease> {
  const current = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!current) throw new EnvironmentNotFoundError(`EnvironmentLease ${leaseId} 不存在`);
  if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 已是终态 ${current.leaseState}，不可重复过期`,
    );
  }
  await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: "expired",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        eq(v11EnvironmentLease.id, leaseId),
        eq(v11EnvironmentLease.leaseState, current.leaseState),
      ),
    );
  const updated = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentLease 过期后回查失败");
  return updated;
}

/** 任意非终态 → lost：Runtime 报告丢失或心跳超时被标记（终态）。 */
export async function markLostEnvironmentLease(
  tenantId: string,
  leaseId: string,
): Promise<V11EnvironmentLease> {
  const current = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!current) throw new EnvironmentNotFoundError(`EnvironmentLease ${leaseId} 不存在`);
  if (ENVIRONMENT_LEASE_TERMINAL_STATES.includes(current.leaseState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 已是终态 ${current.leaseState}，不可重复标记 lost`,
    );
  }
  await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: "lost",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        eq(v11EnvironmentLease.id, leaseId),
        eq(v11EnvironmentLease.leaseState, current.leaseState),
      ),
    );
  const updated = await getEnvironmentLeaseById(tenantId, leaseId);
  if (!updated) throw new EnvironmentNotFoundError("EnvironmentLease 标记 lost 后回查失败");
  return updated;
}

/**
 * 扫描所有 expiresAt < now 且非终态的 Lease，批量标记 expired。
 *
 * @returns 被标记的 Lease 数量
 */
export async function markExpiredEnvironmentLeases(
  tenantId: string,
  now: Date = new Date(),
): Promise<number> {
  const result = await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: "expired",
      updatedAt: now,
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        lt(v11EnvironmentLease.expiresAt, now),
        ne(v11EnvironmentLease.leaseState, "released"),
        ne(v11EnvironmentLease.leaseState, "expired"),
        ne(v11EnvironmentLease.leaseState, "lost"),
        isNotNull(v11EnvironmentLease.expiresAt),
      ),
    );
  return result[0].affectedRows;
}

/**
 * 扫描所有 lastHeartbeatAt + 心跳超时阈值 < now 且非终态的 active/releasing Lease，
 * 批量标记 lost。
 *
 * @param heartbeatTimeoutMs 心跳超时阈值（毫秒，默认 60s）
 */
export async function markLostEnvironmentLeasesByHeartbeat(
  tenantId: string,
  now: Date = new Date(),
  heartbeatTimeoutMs = 60_000,
): Promise<number> {
  const cutoff = new Date(now.getTime() - heartbeatTimeoutMs);
  const result = await db
    .update(v11EnvironmentLease)
    .set({
      leaseState: "lost",
      updatedAt: now,
    })
    .where(
      and(
        eq(v11EnvironmentLease.tenantId, tenantId),
        lt(v11EnvironmentLease.lastHeartbeatAt, cutoff),
        ne(v11EnvironmentLease.leaseState, "released"),
        ne(v11EnvironmentLease.leaseState, "expired"),
        ne(v11EnvironmentLease.leaseState, "lost"),
        isNotNull(v11EnvironmentLease.lastHeartbeatAt),
      ),
    );
  return result[0].affectedRows;
}

// ─── EnvironmentChangeRequest CRUD ────────────────────────

export interface CreateEnvironmentChangeRequestInput {
  tenantId: string;
  threadId: string;
  invocationId?: string;
  fromEnvironmentDefinitionId: string;
  requestedEnvironmentDefinitionId: string;
  requestedDeviceId?: string;
  reasonCode?: string;
  requestedBy: string;
}

export async function createEnvironmentChangeRequest(
  input: CreateEnvironmentChangeRequestInput,
): Promise<V11EnvironmentChangeRequest> {
  if (!input.tenantId) throw new EnvironmentValidationError("tenantId 不能为空");
  if (!input.threadId) throw new EnvironmentValidationError("threadId 不能为空");
  if (!input.fromEnvironmentDefinitionId) {
    throw new EnvironmentValidationError("fromEnvironmentDefinitionId 不能为空");
  }
  if (!input.requestedEnvironmentDefinitionId) {
    throw new EnvironmentValidationError("requestedEnvironmentDefinitionId 不能为空");
  }
  if (input.fromEnvironmentDefinitionId === input.requestedEnvironmentDefinitionId) {
    throw new EnvironmentValidationError("from 与 requested EnvironmentDefinition 不能相同");
  }
  if (!input.requestedBy) throw new EnvironmentValidationError("requestedBy 不能为空");

  const fromDef = await getEnvironmentDefinitionById(
    input.tenantId,
    input.fromEnvironmentDefinitionId,
  );
  if (!fromDef) {
    throw new EnvironmentNotFoundError(
      `from EnvironmentDefinition ${input.fromEnvironmentDefinitionId} 不存在`,
    );
  }
  const requestedDef = await getEnvironmentDefinitionById(
    input.tenantId,
    input.requestedEnvironmentDefinitionId,
  );
  if (!requestedDef) {
    throw new EnvironmentNotFoundError(
      `requested EnvironmentDefinition ${input.requestedEnvironmentDefinitionId} 不存在`,
    );
  }
  if (requestedDef.lifecycleState !== "active") {
    throw new EnvironmentValidationError(
      `requested EnvironmentDefinition 状态非 active：${requestedDef.lifecycleState}`,
    );
  }
  // 切换到 Desktop 必须指定 deviceId。
  if (requestedDef.environmentType === "desktop" && !input.requestedDeviceId) {
    throw new EnvironmentValidationError(
      "切换到 Desktop EnvironmentDefinition 必须指定 requestedDeviceId",
    );
  }
  // 切换到非 Desktop 不允许 deviceId。
  if (requestedDef.environmentType !== "desktop" && input.requestedDeviceId) {
    throw new EnvironmentValidationError(
      `切换到 ${requestedDef.environmentType} EnvironmentDefinition 不允许 requestedDeviceId`,
    );
  }

  const insert: V11EnvironmentChangeRequestInsert = {
    tenantId: input.tenantId,
    threadId: input.threadId,
    invocationId: input.invocationId ?? null,
    fromEnvironmentDefinitionId: input.fromEnvironmentDefinitionId,
    requestedEnvironmentDefinitionId: input.requestedEnvironmentDefinitionId,
    requestedDeviceId: input.requestedDeviceId ?? null,
    requestState: "pending",
    reasonCode: input.reasonCode ?? null,
    requestedBy: input.requestedBy,
  };

  await db.insert(v11EnvironmentChangeRequest).values(insert);
  const [created] = await db
    .select()
    .from(v11EnvironmentChangeRequest)
    .where(
      and(
        eq(v11EnvironmentChangeRequest.tenantId, input.tenantId),
        eq(v11EnvironmentChangeRequest.threadId, input.threadId),
        eq(v11EnvironmentChangeRequest.requestedBy, input.requestedBy),
      ),
    )
    .orderBy(desc(v11EnvironmentChangeRequest.createdAt))
    .limit(1);
  if (!created) {
    throw new EnvironmentNotFoundError("EnvironmentChangeRequest 创建后回查失败");
  }
  return created;
}

export async function getEnvironmentChangeRequestById(
  tenantId: string,
  id: string,
): Promise<V11EnvironmentChangeRequest | null> {
  const [row] = await db
    .select()
    .from(v11EnvironmentChangeRequest)
    .where(
      and(
        eq(v11EnvironmentChangeRequest.tenantId, tenantId),
        eq(v11EnvironmentChangeRequest.id, id),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listEnvironmentChangeRequestsByThread(
  tenantId: string,
  threadId: string,
  options?: { requestState?: EnvironmentChangeRequestState; limit?: number },
): Promise<V11EnvironmentChangeRequest[]> {
  const limit = Math.min(options?.limit ?? 100, 500);
  const conditions = [
    eq(v11EnvironmentChangeRequest.tenantId, tenantId),
    eq(v11EnvironmentChangeRequest.threadId, threadId),
  ];
  if (options?.requestState) {
    conditions.push(eq(v11EnvironmentChangeRequest.requestState, options.requestState));
  }
  return db
    .select()
    .from(v11EnvironmentChangeRequest)
    .where(and(...conditions))
    .orderBy(desc(v11EnvironmentChangeRequest.createdAt))
    .limit(limit);
}

/** pending → accepted_for_next_invocation：Runtime 不支持热迁移，标记下一 Invocation 生效。 */
export async function acceptForNextInvocationEnvironmentChangeRequest(
  tenantId: string,
  id: string,
  reasonCode?: string,
): Promise<V11EnvironmentChangeRequest> {
  return transitionChangeRequestState(
    tenantId,
    id,
    "accepted_for_next_invocation",
    ["pending"],
    reasonCode,
  );
}

/** pending → runtime_acknowledged：Runtime 支持热迁移并 ack，当前 Invocation 已切换 Lease。 */
export async function acknowledgeRuntimeMigrationEnvironmentChangeRequest(
  tenantId: string,
  id: string,
  reasonCode?: string,
): Promise<V11EnvironmentChangeRequest> {
  return transitionChangeRequestState(
    tenantId,
    id,
    "runtime_acknowledged",
    ["pending"],
    reasonCode,
  );
}

/** pending → rejected：平台或策略拒绝（终态）。 */
export async function rejectEnvironmentChangeRequest(
  tenantId: string,
  id: string,
  reasonCode?: string,
): Promise<V11EnvironmentChangeRequest> {
  return transitionChangeRequestState(tenantId, id, "rejected", ["pending"], reasonCode);
}

/** pending/accepted_for_next_invocation → expired：超时未 ack 或下一 Invocation 接纳（终态）。 */
export async function expireEnvironmentChangeRequest(
  tenantId: string,
  id: string,
  reasonCode?: string,
): Promise<V11EnvironmentChangeRequest> {
  return transitionChangeRequestState(
    tenantId,
    id,
    "expired",
    ["pending", "accepted_for_next_invocation"],
    reasonCode,
  );
}

async function transitionChangeRequestState(
  tenantId: string,
  id: string,
  nextState: EnvironmentChangeRequestState,
  allowedFrom: EnvironmentChangeRequestState[],
  reasonCode?: string,
): Promise<V11EnvironmentChangeRequest> {
  const current = await getEnvironmentChangeRequestById(tenantId, id);
  if (!current) {
    throw new EnvironmentNotFoundError(`EnvironmentChangeRequest ${id} 不存在`);
  }
  if (ENVIRONMENT_CHANGE_REQUEST_TERMINAL_STATES.includes(current.requestState)) {
    throw new EnvironmentChangeRequestStateError(
      `EnvironmentChangeRequest 已是终态 ${current.requestState}，不可恢复`,
    );
  }
  if (!allowedFrom.includes(current.requestState)) {
    throw new EnvironmentChangeRequestStateError(
      `EnvironmentChangeRequest 状态 ${current.requestState} 不允许切换到 ${nextState}`,
    );
  }

  await db
    .update(v11EnvironmentChangeRequest)
    .set({
      requestState: nextState,
      reasonCode: reasonCode ?? current.reasonCode,
      resolvedAt: ENVIRONMENT_CHANGE_REQUEST_TERMINAL_STATES.includes(nextState)
        ? new Date()
        : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(v11EnvironmentChangeRequest.tenantId, tenantId),
        eq(v11EnvironmentChangeRequest.id, id),
        eq(v11EnvironmentChangeRequest.requestState, current.requestState),
      ),
    );

  const updated = await getEnvironmentChangeRequestById(tenantId, id);
  if (!updated) {
    throw new EnvironmentNotFoundError("EnvironmentChangeRequest 更新后回查失败");
  }
  return updated;
}

// ─── ExecutionOwnership 管理 ──────────────────────────────
//
// ExecutionOwnership 表定义在 runtime.ts；本节提供业务侧查询函数。
//
// 关键约束：
// - 一个活跃 Invocation 同一时刻只有一个 active ownership。
// - leaseEpoch 单调递增，每次新获取 +1。
// - UNIQUE(invocationId, leaseEpoch) 保证 epoch 唯一。

export interface AcquireExecutionOwnershipInput {
  tenantId: string;
  invocationId: string;
  deviceId?: string;
  environmentLeaseId?: string;
}

/**
 * 为 Invocation 获取执行权：创建新的 active ownership。
 *
 * 同一 Invocation 已有 active ownership 时，先将其置为 released，再创建新 ownership
 * （leaseEpoch 递增）。leaseEpoch 通过 SELECT FOR UPDATE 锁定 Invocation 内的最大 epoch
 * 原子递增，避免并发冲突。
 */
export async function acquireExecutionOwnership(
  input: AcquireExecutionOwnershipInput,
): Promise<{ id: string; leaseEpoch: number; ownershipState: "active" }> {
  if (!input.tenantId) throw new EnvironmentValidationError("tenantId 不能为空");
  if (!input.invocationId) throw new EnvironmentValidationError("invocationId 不能为空");

  return db.transaction(async (tx) => {
    // 锁定当前 Invocation 的所有 ownership 行，计算 next epoch。
    const rows = await tx
      .select({
        id: v11ExecutionOwnership.id,
        leaseEpoch: v11ExecutionOwnership.leaseEpoch,
        ownershipState: v11ExecutionOwnership.ownershipState,
      })
      .from(v11ExecutionOwnership)
      .where(eq(v11ExecutionOwnership.invocationId, input.invocationId))
      .for("update");

    const activeRows = rows.filter((r) => r.ownershipState === "active");
    if (activeRows.length > 0) {
      // 释放已有的 active ownership。
      for (const r of activeRows) {
        await tx
          .update(v11ExecutionOwnership)
          .set({
            ownershipState: "released",
            releasedAt: new Date(),
          })
          .where(eq(v11ExecutionOwnership.id, r.id));
      }
    }

    const nextEpoch = rows.reduce((max, r) => Math.max(max, r.leaseEpoch), 0) + 1;
    const id = crypto.randomUUID();
    await tx.insert(v11ExecutionOwnership).values({
      id,
      invocationId: input.invocationId,
      deviceId: input.deviceId ?? null,
      environmentLeaseId: input.environmentLeaseId ?? null,
      ownershipState: "active",
      leaseEpoch: nextEpoch,
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
    });

    return { id, leaseEpoch: nextEpoch, ownershipState: "active" as const };
  });
}

/** 获取 Invocation 当前 active ownership（不存在返回 null）。 */
export async function getActiveExecutionOwnership(invocationId: string): Promise<{
  id: string;
  invocationId: string;
  deviceId: string | null;
  environmentLeaseId: string | null;
  ownershipState: ExecutionOwnershipState;
  leaseEpoch: number;
  acquiredAt: Date;
  lastHeartbeatAt: Date | null;
  releasedAt: Date | null;
} | null> {
  const [row] = await db
    .select()
    .from(v11ExecutionOwnership)
    .where(
      and(
        eq(v11ExecutionOwnership.invocationId, invocationId),
        eq(v11ExecutionOwnership.ownershipState, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** active → released：主动释放执行权。 */
export async function releaseExecutionOwnership(
  invocationId: string,
  ownershipId: string,
): Promise<void> {
  const result = await db
    .update(v11ExecutionOwnership)
    .set({
      ownershipState: "released",
      releasedAt: new Date(),
    })
    .where(
      and(
        eq(v11ExecutionOwnership.id, ownershipId),
        eq(v11ExecutionOwnership.invocationId, invocationId),
        eq(v11ExecutionOwnership.ownershipState, "active"),
      ),
    );
  if (result[0].affectedRows === 0) {
    throw new EnvironmentLeaseStateError(
      `ExecutionOwnership ${ownershipId} 不存在或非 active 状态`,
    );
  }
}

/** active → lost：心跳超时被标记丢失。 */
export async function markLostExecutionOwnership(
  invocationId: string,
  ownershipId: string,
): Promise<void> {
  const result = await db
    .update(v11ExecutionOwnership)
    .set({
      ownershipState: "lost",
    })
    .where(
      and(
        eq(v11ExecutionOwnership.id, ownershipId),
        eq(v11ExecutionOwnership.invocationId, invocationId),
        eq(v11ExecutionOwnership.ownershipState, "active"),
      ),
    );
  if (result[0].affectedRows === 0) {
    throw new EnvironmentLeaseStateError(
      `ExecutionOwnership ${ownershipId} 不存在或非 active 状态`,
    );
  }
}

/** 更新 ExecutionOwnership 心跳时间。 */
export async function heartbeatExecutionOwnership(
  invocationId: string,
  ownershipId: string,
  heartbeatAt?: Date,
): Promise<void> {
  const result = await db
    .update(v11ExecutionOwnership)
    .set({
      lastHeartbeatAt: heartbeatAt ?? new Date(),
    })
    .where(
      and(
        eq(v11ExecutionOwnership.id, ownershipId),
        eq(v11ExecutionOwnership.invocationId, invocationId),
        eq(v11ExecutionOwnership.ownershipState, "active"),
      ),
    );
  if (result[0].affectedRows === 0) {
    throw new EnvironmentLeaseStateError(
      `ExecutionOwnership ${ownershipId} 不存在或非 active 状态`,
    );
  }
}

/**
 * 校验给定 leaseEpoch 是否为当前 Invocation 的最新 active epoch。
 *
 * 旧 epoch 的设备或 Runtime 回调必须被拒绝（§6.13）。
 */
export async function isActiveEpoch(invocationId: string, leaseEpoch: number): Promise<boolean> {
  const active = await getActiveExecutionOwnership(invocationId);
  return active?.leaseEpoch === leaseEpoch;
}
