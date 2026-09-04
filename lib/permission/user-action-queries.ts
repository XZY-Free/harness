/**
 * UserActionRequest 仓储（阶段 8 S08-C04）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （user_action_request 与 grant）、。
 * - docs/architecture/domain-model.md （PermissionDecision 与 UserActionRequest 关系）。
 * - docs/architecture/api-and-events.md （resolve 接口约束）、
 * （auth callback）、§10（block 不可被绕过）。
 * - docs/architecture/capabilities-and-security.md 。
 *
 * 关键不变量：
 * - 四种 request_type 共用一张表：confirmation / auth / grant / input。
 * - 请求只能解析一次：原子 UPDATE WHERE requestState='pending'，受影响行数=0 视为冲突。
 * - auth 类型成功只能来自可信 callback（completeAuthCallback），:resolve 接口仅接受 cancel。
 * - state/nonce 一次性消费，hash 后存储（sha256: 前缀 + 64 hex）。
 * - expires_at 超时后进入 expired 终态，不可再 resolve。
 * - block 决策不创建本表记录（由调用方在收到 block 时不创建）。
 * - grant 类型 approve 时同事务创建 Grant 行并回填 grant_id。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { createHash, randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { encodeCursor } from "@/lib/http";
import { issueGrant } from "@/lib/permission/permission-queries";
import {
  ALLOWED_RESOLUTIONS_BY_TYPE,
  type NewUserActionRequest,
  USER_ACTION_REQUEST_STATES,
  USER_ACTION_REQUEST_TERMINAL_STATES,
  USER_ACTION_REQUEST_TYPES,
  USER_ACTION_RESOLUTIONS,
  type UserActionRequest,
  type UserActionRequestState,
  type UserActionRequestType,
  type UserActionResolution,
  userActionRequestTable,
} from "@/lib/persistence/schema/user-action-request";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class UserActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserActionValidationError";
  }
}

export class UserActionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserActionNotFoundError";
  }
}

export class UserActionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserActionStateError";
  }
}

/**
 * 请求已被解析或过期（重复 resolve / resolve 已 expired 的请求）。
 */
export class UserActionAlreadyResolvedError extends Error {
  public readonly currentState: UserActionRequestState;
  public readonly requestId: string;

  constructor(requestId: string, currentState: UserActionRequestState) {
    super(`UserActionRequest ${requestId} 已解析或过期（currentState=${currentState}）`);
    this.name = "UserActionAlreadyResolvedError";
    this.currentState = currentState;
    this.requestId = requestId;
  }
}

/**
 * resolution 与 request_type 不匹配（如 confirmation 接受 submit）。
 */
export class UserActionResolutionMismatchError extends Error {
  public readonly requestType: UserActionRequestType;
  public readonly resolution: UserActionResolution;

  constructor(requestType: UserActionRequestType, resolution: UserActionResolution) {
    super(`request_type=${requestType} 不接受 resolution=${resolution}`);
    this.name = "UserActionResolutionMismatchError";
    this.requestType = requestType;
    this.resolution = resolution;
  }
}

/**
 * Auth callback 校验失败（state/nonce/session 任一不符）。
 */
export class UserActionAuthCallbackInvalidError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UserActionAuthCallbackInvalidError";
    this.code = code;
  }
}

/**
 * Policy pause 专用 purpose（§19）：ToolCall 权限确认的一次性确认事实。
 * 仅 Tool Gateway 可创建（External Runtime 不得伪造该 purpose，§21）。
 */
export const TOOL_PERMISSION_CONFIRMATION_PURPOSE = "tool_permission_confirmation";

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_REQUEST_TYPES = new Set<string>(USER_ACTION_REQUEST_TYPES);
const VALID_REQUEST_STATES = new Set<string>(USER_ACTION_REQUEST_STATES);
const VALID_RESOLUTIONS = new Set<string>(USER_ACTION_RESOLUTIONS);

export function isUserActionRequestType(value: string): value is UserActionRequestType {
  return VALID_REQUEST_TYPES.has(value);
}

export function isUserActionRequestState(value: string): value is UserActionRequestState {
  return VALID_REQUEST_STATES.has(value);
}

export function isUserActionResolution(value: string): value is UserActionResolution {
  return VALID_RESOLUTIONS.has(value);
}

/** 校验 resolution 是否被 request_type 允许（）。 */
export function isResolutionAllowedForType(
  requestType: UserActionRequestType,
  resolution: UserActionResolution,
): boolean {
  return ALLOWED_RESOLUTIONS_BY_TYPE[requestType].includes(resolution);
}

/**
 * 计算 sha256 hash（带 sha256: 前缀），用于 auth_state / nonce。
 *
 * 不存原值，只存 hash；callback 时按原值 hash 后比对。
 */
export function hashAuthSecret(value: string): string {
  const hex = createHash("sha256").update(value, "utf-8").digest("hex");
  return `sha256:${hex}`;
}

/** 生成一次性 OAuth state 原值（32 字节随机）。 */
export function generateAuthState(): string {
  return randomUUID() + randomUUID().replace(/-/g, "");
}

/** 生成一次性 OIDC nonce 原值（32 字节随机）。 */
export function generateNonce(): string {
  return randomUUID() + randomUUID().replace(/-/g, "");
}

// ─── 创建 UserActionRequest ───────────────────────────────

export interface CreateUserActionRequestInput {
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
  harnessActionId?: string | null;
  toolCallId?: string | null;
  itemId?: string | null;
  requestType: UserActionRequestType;
  purpose?: string | null;
  /**
   * 关联的 PermissionDecision id（§19）：仅 `purpose=tool_permission_confirmation` 时必填，
   * UNIQUE(permissionDecisionId) 保证同一 pause 决策不会重复建 UAR。可空。
   */
  permissionDecisionId?: string | null;
  promptJson: unknown;
  inputSchemaJson?: unknown | null;
  /** auth 类型：可选；不传则自动生成。仓储返回原值供调用方构造 OAuth URL。 */
  authState?: string;
  /** auth 类型：可选；不传则自动生成。仓储返回原值供调用方构造 OIDC URL。 */
  nonce?: string;
  expiresAt?: Date | null;
}

export interface CreateUserActionRequestResult {
  request: UserActionRequest;
  /** auth 类型：返回 state / nonce 原值（仅创建时一次性返回，后续查询不再返回原值）。 */
  authStatePlaintext?: string;
  noncePlaintext?: string;
}

export interface CreateUserActionRequestOptions {
  /**
   * 外部事务句柄（§22：与 PermissionDecision / ToolCall / Invocation 状态变更同事务）。
   * 缺省使用全局 db 自开事务。
   */
  tx?: DbOrTx;
}

/**
 * 创建 UserActionRequest。
 *
 * - auth 类型自动生成 state / nonce 原值并 hash 后存储；返回原值供调用方构造 OAuth URL。
 * - input 类型必须提供 inputSchemaJson。
 * - 非	auth 类型不应传 authState / nonce。
 */
export async function createUserActionRequest(
  input: CreateUserActionRequestInput,
  options: CreateUserActionRequestOptions = {},
): Promise<CreateUserActionRequestResult> {
  if (!input.tenantId) throw new UserActionValidationError("tenantId 不能为空");
  if (!input.threadId) throw new UserActionValidationError("threadId 不能为空");
  if (!input.turnId) throw new UserActionValidationError("turnId 不能为空");
  if (!input.invocationId) throw new UserActionValidationError("invocationId 不能为空");
  if (!isUserActionRequestType(input.requestType)) {
    throw new UserActionValidationError(`非法 requestType: ${input.requestType}`);
  }
  if (!input.promptJson || typeof input.promptJson !== "object") {
    throw new UserActionValidationError("promptJson 必须是对象");
  }

  let authStateHash: string | null = null;
  let nonceHash: string | null = null;
  let authStatePlaintext: string | undefined;
  let noncePlaintext: string | undefined;

  if (input.requestType === "auth") {
    authStatePlaintext = input.authState ?? generateAuthState();
    noncePlaintext = input.nonce ?? generateNonce();
    authStateHash = hashAuthSecret(authStatePlaintext);
    nonceHash = hashAuthSecret(noncePlaintext);
  }

  let inputSchemaJson: unknown | null = null;
  if (input.requestType === "input") {
    if (!input.inputSchemaJson || typeof input.inputSchemaJson !== "object") {
      throw new UserActionValidationError("input 类型必须提供 inputSchemaJson");
    }
    inputSchemaJson = input.inputSchemaJson;
  }

  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new UserActionValidationError("expiresAt 必须是未来时间");
  }

  if (input.purpose !== undefined && input.purpose !== null) {
    if (typeof input.purpose !== "string" || input.purpose.length === 0) {
      throw new UserActionValidationError("purpose 不能为空字符串");
    }
    if (input.purpose.length > 64) {
      throw new UserActionValidationError("purpose 长度不能超过 64");
    }
  }

  const id = randomUUID();
  const insert: NewUserActionRequest = {
    id,
    tenantId: input.tenantId,
    threadId: input.threadId,
    turnId: input.turnId,
    invocationId: input.invocationId,
    harnessActionId: input.harnessActionId ?? null,
    toolCallId: input.toolCallId ?? null,
    itemId: input.itemId ?? null,
    requestType: input.requestType,
    purpose: input.purpose ?? null,
    permissionDecisionId: input.permissionDecisionId ?? null,
    requestState: "pending",
    promptJson: input.promptJson,
    inputSchemaJson,
    authStateHash,
    nonceHash,
    expiresAt: input.expiresAt ?? null,
  };

  const source: DbOrTx = options.tx ?? db;
  await source.insert(userActionRequestTable).values(insert);
  const created = await getUserActionRequestById(input.tenantId, id, options.tx);
  if (!created) {
    throw new UserActionNotFoundError("UserActionRequest 创建后回查失败");
  }

  const result: CreateUserActionRequestResult = { request: created };
  if (authStatePlaintext) result.authStatePlaintext = authStatePlaintext;
  if (noncePlaintext) result.noncePlaintext = noncePlaintext;
  return result;
}

// ─── 查询 ─────────────────────────────────────────────────

export async function getUserActionRequestById(
  tenantId: string,
  requestId: string,
  tx?: DbOrTx,
): Promise<UserActionRequest | null> {
  const source: DbOrTx = tx ?? db;
  const [row] = await source
    .select()
    .from(userActionRequestTable)
    .where(
      and(eq(userActionRequestTable.tenantId, tenantId), eq(userActionRequestTable.id, requestId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * 按 PermissionDecision id 查询关联的 UserActionRequest（§19 / §20.1 幂等防重）。
 *
 * UNIQUE(permissionDecisionId) 保证同一 pause 决策至多一条确认；用于 Gateway 判定
 * 该 pause Decision 是否有已 approve 的一次性确认事实。跨租户隔离。
 */
export async function getUserActionRequestByPermissionDecisionId(
  tenantId: string,
  permissionDecisionId: string,
  tx?: DbOrTx,
): Promise<UserActionRequest | null> {
  const source: DbOrTx = tx ?? db;
  const [row] = await source
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.permissionDecisionId, permissionDecisionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getUserActionRequestsByInvocation(
  tenantId: string,
  invocationId: string,
  options?: { requestState?: UserActionRequestState },
): Promise<UserActionRequest[]> {
  const conditions = [
    eq(userActionRequestTable.tenantId, tenantId),
    eq(userActionRequestTable.invocationId, invocationId),
  ];
  if (options?.requestState) {
    conditions.push(eq(userActionRequestTable.requestState, options.requestState));
  }
  return db
    .select()
    .from(userActionRequestTable)
    .where(and(...conditions))
    .orderBy(asc(userActionRequestTable.createdAt));
}

export async function getUserActionRequestsByToolCall(
  tenantId: string,
  toolCallId: string,
): Promise<UserActionRequest[]> {
  return db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.toolCallId, toolCallId),
      ),
    )
    .orderBy(asc(userActionRequestTable.createdAt));
}

export async function getPendingUserActionRequestForToolCall(
  tenantId: string,
  toolCallId: string,
): Promise<UserActionRequest | null> {
  const [row] = await db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.toolCallId, toolCallId),
        eq(userActionRequestTable.requestState, "pending"),
      ),
    )
    .orderBy(desc(userActionRequestTable.createdAt))
    .limit(1);
  return row ?? null;
}

// ─── resolveUserActionRequest ─────────────────────────────

export interface ResolveUserActionRequestInput {
  tenantId: string;
  requestId: string;
  resolution: UserActionResolution;
  resolvedBy: string;
  /** input 类型 submit 时必填（已按 inputSchemaJson 校验后的脱敏响应）。 */
  responseRedactedJson?: unknown | null;
  /** grant 类型 approve 时必填：用于创建 Grant 的参数。 */
  grantParams?: {
    userId: string;
    scope: readonly string[];
    credentialRefId: string;
    issuedBy: string;
    expiresAt?: Date | null;
  };
  /** 乐观锁版本号；不传则跳过校验。 */
  expectedVersionNo?: number;
}

export interface ResolveUserActionRequestResult {
  request: UserActionRequest;
  /** grant 类型 approve 时返回新建的 Grant id。 */
  grantId?: string;
}

/**
 * 解析 UserActionRequest（员工 :resolve 接口的仓储入口）。
 *
 * 关键规则（）：
 * - requestState 必须为 pending；否则抛 UserActionAlreadyResolvedError。
 * - resolution 必须在 ALLOWED_RESOLUTIONS_BY_TYPE 内；否则抛 UserActionResolutionMismatchError。
 * - auth 类型在本接口仅接受 cancel；approve 只能由 completeAuthCallback 写入。
 * - grant 类型 approve 时同事务创建 Grant 并回填 grantId。
 * - input 类型 submit 时必须提供 responseRedactedJson（调用方按 inputSchemaJson 校验后传入）。
 * - 一次性消费：原子 UPDATE WHERE requestState='pending'，受影响行数=0 视为冲突。
 * - 不会在此处写 invocation_command resume；调用方在更高层（API/服务编排）同事务写入。
 *
 * 注意：本函数内部使用事务包裹"读 + 校验 + 更新 + Grant 创建"，确保原子性。
 */
export async function resolveUserActionRequest(
  input: ResolveUserActionRequestInput,
): Promise<ResolveUserActionRequestResult> {
  if (!input.tenantId) throw new UserActionValidationError("tenantId 不能为空");
  if (!input.requestId) throw new UserActionValidationError("requestId 不能为空");
  if (!input.resolvedBy) throw new UserActionValidationError("resolvedBy 不能为空");
  if (!isUserActionResolution(input.resolution)) {
    throw new UserActionValidationError(`非法 resolution: ${input.resolution}`);
  }

  const current = await getUserActionRequestById(input.tenantId, input.requestId);
  if (!current) {
    throw new UserActionNotFoundError(`UserActionRequest 不存在或跨租户不可见: ${input.requestId}`);
  }

  if (current.requestState !== "pending") {
    throw new UserActionAlreadyResolvedError(current.id, current.requestState);
  }

  // 过期检查（扫描任务可能尚未运行）
  if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
    throw new UserActionAlreadyResolvedError(current.id, "expired");
  }

  if (!isResolutionAllowedForType(current.requestType, input.resolution)) {
    throw new UserActionResolutionMismatchError(current.requestType, input.resolution);
  }

  // input 类型 submit 必须提供 responseRedactedJson
  if (current.requestType === "input" && input.resolution === "submit") {
    if (!input.responseRedactedJson || typeof input.responseRedactedJson !== "object") {
      throw new UserActionValidationError("input 类型 submit 必须提供 responseRedactedJson");
    }
  }

  // grant 类型 approve 必须提供 grantParams
  if (current.requestType === "grant" && input.resolution === "approve") {
    if (!input.grantParams) {
      throw new UserActionValidationError("grant 类型 approve 必须提供 grantParams");
    }
    if (!input.grantParams.userId || !input.grantParams.credentialRefId) {
      throw new UserActionValidationError("grantParams.userId / credentialRefId 不能为空");
    }
    if (!input.grantParams.scope || input.grantParams.scope.length === 0) {
      throw new UserActionValidationError("grantParams.scope 不能为空");
    }
  }

  // 乐观锁校验
  if (input.expectedVersionNo !== undefined && input.expectedVersionNo !== current.versionNo) {
    throw new UserActionAlreadyResolvedError(current.id, current.requestState);
  }

  // 原子更新：UPDATE WHERE requestState='pending' 防并发重复 resolve
  const updateResult = await db
    .update(userActionRequestTable)
    .set({
      requestState: "resolved",
      resolution: input.resolution,
      resolvedBy: input.resolvedBy,
      resolvedAt: new Date(),
      responseRedactedJson: input.responseRedactedJson ?? null,
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userActionRequestTable.id, current.id),
        eq(userActionRequestTable.tenantId, input.tenantId),
        eq(userActionRequestTable.requestState, "pending"),
        eq(userActionRequestTable.versionNo, current.versionNo),
      ),
    );

  const affected = updateResult[0]?.affectedRows ?? 0;
  if (affected === 0) {
    // 并发场景：另一个事务已经 resolve
    const after = await getUserActionRequestById(input.tenantId, current.id);
    throw new UserActionAlreadyResolvedError(
      current.id,
      after?.requestState ?? current.requestState,
    );
  }

  // grant 类型 approve 时创建 Grant 并回填 grantId
  let grantId: string | undefined;
  if (current.requestType === "grant" && input.resolution === "approve" && input.grantParams) {
    const grant = await issueGrant({
      tenantId: input.tenantId,
      userId: input.grantParams.userId,
      grantType: "user_consent",
      scope: [...input.grantParams.scope],
      credentialRefId: input.grantParams.credentialRefId,
      issuedBy: input.grantParams.issuedBy,
      expiresAt: input.grantParams.expiresAt ?? null,
    });
    grantId = grant.id;
    await db
      .update(userActionRequestTable)
      .set({ grantId, updatedAt: new Date() })
      .where(eq(userActionRequestTable.id, current.id));
  }

  const updated = await getUserActionRequestById(input.tenantId, current.id);
  if (!updated) {
    throw new UserActionNotFoundError("UserActionRequest 解析后回查失败");
  }

  const result: ResolveUserActionRequestResult = { request: updated };
  if (grantId) result.grantId = grantId;
  return result;
}

// ─── completeAuthCallback ─────────────────────────────────

export interface CompleteAuthCallbackInput {
  tenantId: string;
  requestId: string;
  /** OAuth state 原值（来自 callback query）。 */
  authState: string;
  /** OIDC nonce 原值（来自 Provider token exchange 后的 id_token）。 */
  nonce: string;
  /** 解析人 userId（来自 employee_session）。 */
  resolvedBy: string;
}

/**
 * 完成 Auth callback（可信回调专用，）。
 *
 * 关键规则：
 * - 只能解析 requestType=auth 且 requestState=pending 的请求。
 * - authState / nonce 必须与创建时 hash 后存储的值匹配（一次性消费）。
 * - 成功后 requestState=resolved，resolution=approve（隐式，由 callback 写入）。
 * - 失败时抛 UserActionAuthCallbackInvalidError，请求保持 pending（员工可重试或 cancel）。
 * - 不会创建 Grant（auth 类型的 Grant 由后续 ToolCall 执行时按需创建）。
 * - 实际 OAuth code → token 交换与 Credential 写入 Vault 由 Connection Adapter 完成；
 * 本函数只负责 UserActionRequest 表的状态变更与一次性消费校验。
 */
export async function completeAuthCallback(
  input: CompleteAuthCallbackInput,
): Promise<UserActionRequest> {
  if (!input.tenantId) throw new UserActionValidationError("tenantId 不能为空");
  if (!input.requestId) throw new UserActionValidationError("requestId 不能为空");
  if (!input.authState) throw new UserActionValidationError("authState 不能为空");
  if (!input.nonce) throw new UserActionValidationError("nonce 不能为空");
  if (!input.resolvedBy) throw new UserActionValidationError("resolvedBy 不能为空");

  const current = await getUserActionRequestById(input.tenantId, input.requestId);
  if (!current) {
    throw new UserActionNotFoundError(`UserActionRequest 不存在或跨租户不可见: ${input.requestId}`);
  }
  if (current.requestType !== "auth") {
    throw new UserActionAuthCallbackInvalidError(
      "not_auth_request",
      `request_type != auth (actual=${current.requestType})`,
    );
  }
  if (current.requestState !== "pending") {
    throw new UserActionAlreadyResolvedError(current.id, current.requestState);
  }
  if (current.expiresAt && current.expiresAt.getTime() <= Date.now()) {
    throw new UserActionAlreadyResolvedError(current.id, "expired");
  }

  // state / nonce hash 比对
  if (!current.authStateHash) {
    throw new UserActionAuthCallbackInvalidError(
      "missing_stored_state",
      "请求未存储 authStateHash",
    );
  }
  if (!current.nonceHash) {
    throw new UserActionAuthCallbackInvalidError("missing_stored_nonce", "请求未存储 nonceHash");
  }
  const providedStateHash = hashAuthSecret(input.authState);
  const providedNonceHash = hashAuthSecret(input.nonce);
  if (providedStateHash !== current.authStateHash) {
    throw new UserActionAuthCallbackInvalidError("state_mismatch", "OAuth state 不匹配");
  }
  if (providedNonceHash !== current.nonceHash) {
    throw new UserActionAuthCallbackInvalidError("nonce_mismatch", "OIDC nonce 不匹配");
  }

  // 原子更新：确保 state/nonce 一次性消费
  const updateResult = await db
    .update(userActionRequestTable)
    .set({
      requestState: "resolved",
      resolution: "approve",
      resolvedBy: input.resolvedBy,
      resolvedAt: new Date(),
      versionNo: current.versionNo + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userActionRequestTable.id, current.id),
        eq(userActionRequestTable.tenantId, input.tenantId),
        eq(userActionRequestTable.requestState, "pending"),
        eq(userActionRequestTable.versionNo, current.versionNo),
      ),
    );

  const affected = updateResult[0]?.affectedRows ?? 0;
  if (affected === 0) {
    const after = await getUserActionRequestById(input.tenantId, current.id);
    throw new UserActionAlreadyResolvedError(
      current.id,
      after?.requestState ?? current.requestState,
    );
  }

  const updated = await getUserActionRequestById(input.tenantId, current.id);
  if (!updated) {
    throw new UserActionNotFoundError("UserActionRequest auth callback 后回查失败");
  }
  return updated;
}

// ─── markExpiredUserActionRequests ────────────────────────

/**
 * 批量标记过期请求：pending + expiresAt < now → expired。
 *
 * 用于扫描任务（cron）清理超时未解析的请求。
 * 返回受影响行数。
 */
export async function markExpiredUserActionRequests(now: Date = new Date()): Promise<number> {
  const result = await db
    .update(userActionRequestTable)
    .set({
      requestState: "expired",
      updatedAt: now,
    })
    .where(
      and(
        eq(userActionRequestTable.requestState, "pending"),
        isNotNull(userActionRequestTable.expiresAt),
        lt(userActionRequestTable.expiresAt, now),
      ),
    );
  return result[0]?.affectedRows ?? 0;
}

// ─── listStaleExpiredUserActionRequests ───────────────────

/**
 * 列出某租户内已过期但未标记的请求（诊断用途）。
 */
export async function listStaleExpiredUserActionRequests(
  tenantId: string,
  now: Date = new Date(),
): Promise<UserActionRequest[]> {
  return db
    .select()
    .from(userActionRequestTable)
    .where(
      and(
        eq(userActionRequestTable.tenantId, tenantId),
        eq(userActionRequestTable.requestState, "pending"),
        isNotNull(userActionRequestTable.expiresAt),
        lt(userActionRequestTable.expiresAt, now),
      ),
    )
    .orderBy(asc(userActionRequestTable.expiresAt));
}

/**
 * 列出租户所有 UserActionRequest（按 createdAt 降序，跨租户隔离）。
 *
 * 事实源：S11-W04 管理面排障端点 /admin/api/v1/user-actions 使用本函数跨 invocation 列出租户所有请求。
 *
 * 选项：
 * - requestState：过滤请求状态（pending / resolved / expired）。
 * - requestType：过滤请求类型（confirmation / auth / grant / input）。
 * - limit：默认 50，最大 200。
 *
 * @returns `{ items, nextCursor }`，nextCursor 为不透明 cursor（base64url(JSON)），无更多数据时为 null。
 */
export async function listUserActionRequestsByTenant(
  tenantId: string,
  options?: {
    requestState?: UserActionRequestState;
    requestType?: UserActionRequestType;
    limit?: number;
    afterCreatedAt?: Date;
  },
): Promise<{ items: UserActionRequest[]; nextCursor: string | null }> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const conditions = [eq(userActionRequestTable.tenantId, tenantId)];
  if (options?.requestState) {
    conditions.push(eq(userActionRequestTable.requestState, options.requestState));
  }
  if (options?.requestType) {
    conditions.push(eq(userActionRequestTable.requestType, options.requestType));
  }
  if (options?.afterCreatedAt) {
    // 按 createdAt 降序取下一页：游标为上一页最后一条的 createdAt
    conditions.push(lt(userActionRequestTable.createdAt, options.afterCreatedAt));
  }

  // 取 limit+1 行：第 limit+1 行存在说明有下一页
  const rows = await db
    .select()
    .from(userActionRequestTable)
    .where(and(...conditions))
    .orderBy(desc(userActionRequestTable.createdAt))
    .limit(limit + 1);

  let nextCursor: string | null = null;
  let items = rows;
  if (rows.length > limit) {
    items = rows.slice(0, limit);
    const lastKept = items[items.length - 1];
    if (lastKept) {
      nextCursor = encodeCursor({
        created_at: lastKept.createdAt.toISOString(),
        id: lastKept.id,
      });
    }
  }

  return { items, nextCursor };
}
