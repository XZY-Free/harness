/**
 * Tool / ToolProvider / Connection / CredentialRef / ToolSchemaRevision 仓储
 * （阶段 6 S06-C02）。
 *
 * 事实源：lib/persistence/schema/tool.ts、阶段 6 Tool/Capability 模型。
 *
 * 职责：
 * - Connection 仓储：createConnection / getConnectionById / getConnectionByKey /
 * listConnections / updateConnection。
 * - CredentialRef 仓储：createCredentialRef / getCredentialRefsByConnection / revokeCredentialRef。
 * - ToolProvider 仓储：createToolProvider / getToolProviderById / getToolProviderByKey /
 * listToolProviders / updateToolProvider。
 * - Tool 仓储：createTool / getToolById / getToolByKey / listTools / updateTool。
 * - ToolSchemaRevision 仓储：createToolSchemaRevision / getToolSchemaRevisionById /
 * listToolSchemaRevisions / getCurrentToolSchemaRevision / publishToolSchemaRevision。
 *
 * 关键约束：
 * - connectionKey/providerKey/toolKey 正则：`^[a-z0-9]+(-[a-z0-9]+)*$`，1-64 字符。
 * - lifecycleState 状态机：draft → enabled → disabled → retired（retired 终态不可恢复）。
 * - revisionState 状态机：draft → published → withdrawn（withdrawn 终态）。
 * - publishToolSchemaRevision 事务内：draft → published + 旧 published → withdrawn +
 * Tool.currentSchemaRevisionId 更新。
 * - createTool 事务内校验 providerId 存在且 enabled。
 * - createToolSchemaRevision 事务内校验 toolId 存在 + 分配 revisionNo（COALESCE(MAX)+1）。
 * - schemaHash 覆盖 input/output/risk/execution contract，带 sha256: 前缀。
 * - credential_ref fingerprint 格式校验（sha256: 前缀）。
 * - 跨租户隔离：所有查询按 tenantId 过滤。
 */
import { createHash, randomUUID } from "node:crypto";
import { isValidContentHash } from "@/lib/capability/content-cache";
import {
  computeToolExecutionContractDigest,
  parseToolExecutionContract,
} from "@/lib/capability/tool-execution-contract";
import { db } from "@/lib/db/client";
import { isMysqlDuplicateEntryError } from "@/lib/db/mysql-error";
import {
  CONNECTION_AUTH_METHODS,
  CONNECTION_TYPES,
  type Connection,
  type ConnectionAuthMethod,
  type ConnectionLifecycleState,
  type ConnectionType,
  type CredentialRef,
  type CredentialRefLifecycleState,
  TOOL_PROVIDER_TRUST_LEVELS,
  TOOL_PROVIDER_TYPES,
  TOOL_RISK_CLASSES,
  type Tool,
  type ToolLifecycleState,
  type ToolProvider,
  type ToolProviderLifecycleState,
  type ToolProviderTrustLevel,
  type ToolProviderType,
  type ToolRevisionState,
  type ToolRiskClass,
  type ToolSchemaRevision,
  connectionTable,
  credentialRefTable,
  toolProviderTable,
  toolSchemaRevisionTable,
  toolTable,
} from "@/lib/persistence/schema/tool";
import { and, asc, desc, eq, gt, inArray, isNull, max, or } from "drizzle-orm";

// ─── 常量 ──────────────────────────────────────────────────

/** connectionKey / providerKey / toolKey 正则：1-64 字符，`^[a-z0-9]+(-[a-z0-9]+)*$`。 */
export const TOOL_KEY_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TOOL_KEY_MAX_LENGTH = 64;

/** lifecycle 状态机：合法迁移映射（Connection / ToolProvider / Tool 共用）。 */
const LIFECYCLE_TRANSITIONS: Record<
  ConnectionLifecycleState | ToolProviderLifecycleState | ToolLifecycleState,
  readonly (ConnectionLifecycleState | ToolProviderLifecycleState | ToolLifecycleState)[]
> = {
  draft: ["enabled", "disabled", "retired"],
  enabled: ["disabled", "retired"],
  disabled: ["enabled", "retired"],
  retired: [], // 终态
};

/** CredentialRef lifecycle 状态机：active → rotated / revoked。 */
const CREDENTIAL_REF_TRANSITIONS: Record<
  CredentialRefLifecycleState,
  readonly CredentialRefLifecycleState[]
> = {
  active: ["rotated", "revoked"],
  rotated: ["revoked"],
  revoked: [], // 终态
};

// ─── 错误类 ────────────────────────────────────────────────

/** Tool 校验错误（key 正则 / hash 格式 / 参数非法）。 */
export class ToolValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolValidationError";
  }
}

/** Tool / ToolProvider / Connection 不存在（或跨租户不可见）。 */
export class ToolNotFoundError extends Error {
  constructor(public readonly resourceId: string) {
    super(`Tool 资源不存在或跨租户不可见: ${resourceId}`);
    this.name = "ToolNotFoundError";
  }
}

/** 乐观锁/唯一约束冲突（versionNo 并发分配冲突）。 */
export class ToolVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolVersionConflictError";
  }
}

/** Tool lifecycle / revision 状态机错误。 */
export class ToolLifecycleError extends Error {
  constructor(
    public readonly resourceId: string,
    public readonly kind: "lifecycle" | "revision",
    public readonly fromState: string,
    public readonly toState: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolLifecycleError";
  }
}

/** SchemaRevision 在调用开始前已变更（currentSchemaRevisionId 与 caller 期望不符）。 */
export class ToolSchemaChangedError extends Error {
  constructor(
    public readonly toolId: string,
    public readonly expectedRevisionId: string,
    public readonly actualRevisionId: string | null,
  ) {
    super(
      `Tool ${toolId} SchemaRevision 已变更：期望 ${expectedRevisionId}，实际 ${actualRevisionId ?? "null"}`,
    );
    this.name = "ToolSchemaChangedError";
  }
}

// ─── 通用校验工具 ──────────────────────────────────────────

/** 校验 connectionKey/providerKey/toolKey 格式（正则 + 长度）。 */
function assertValidKey(key: string, label: string): void {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > TOOL_KEY_MAX_LENGTH ||
    !TOOL_KEY_REGEX.test(key)
  ) {
    throw new ToolValidationError(
      `invalid_${label}`,
      `${label} 非法（必须匹配 ${TOOL_KEY_REGEX.source}，1-${TOOL_KEY_MAX_LENGTH} 字符）: ${key}`,
    );
  }
}

/** 校验 hash 格式（sha256: 前缀 + 64 hex）。 */
function assertValidHash(hash: string, label: string): void {
  if (!isValidContentHash(hash)) {
    throw new ToolValidationError(
      `invalid_${label}`,
      `${label} 必须以 sha256: 开头并跟随 64 hex: ${hash}`,
    );
  }
}

/** 校验 connectionType 在已知枚举内。 */
function assertValidConnectionType(value: string): asserts value is ConnectionType {
  if (!CONNECTION_TYPES.includes(value as ConnectionType)) {
    throw new ToolValidationError("invalid_connection_type", `connectionType 非法: ${value}`);
  }
}

/** 校验 authMethod 在已知枚举内。 */
function assertValidAuthMethod(value: string): asserts value is ConnectionAuthMethod {
  if (!CONNECTION_AUTH_METHODS.includes(value as ConnectionAuthMethod)) {
    throw new ToolValidationError("invalid_auth_method", `authMethod 非法: ${value}`);
  }
}

/** 校验 providerType 在已知枚举内。 */
function assertValidProviderType(value: string): asserts value is ToolProviderType {
  if (!TOOL_PROVIDER_TYPES.includes(value as ToolProviderType)) {
    throw new ToolValidationError("invalid_provider_type", `providerType 非法: ${value}`);
  }
}

/** 校验 trustLevel 在已知枚举内。 */
function assertValidTrustLevel(value: string): asserts value is ToolProviderTrustLevel {
  if (!TOOL_PROVIDER_TRUST_LEVELS.includes(value as ToolProviderTrustLevel)) {
    throw new ToolValidationError("invalid_trust_level", `trustLevel 非法: ${value}`);
  }
}

/** 校验 riskClass 在已知枚举内。 */
function assertValidRiskClass(value: string): asserts value is ToolRiskClass {
  if (!TOOL_RISK_CLASSES.includes(value as ToolRiskClass)) {
    throw new ToolValidationError("invalid_risk_class", `riskClass 非法: ${value}`);
  }
}

/**
 * 计算 SchemaRevision 的 schemaHash。
 *
 * hash 内容同时覆盖 input/output schema、risk metadata 与 immutable execution contract，
 * 带 sha256: 前缀。
 */
export function computeSchemaHash(params: {
  inputSchemaJson: unknown;
  outputSchemaJson: unknown;
  riskMetadataJson: unknown;
  executionContractJson: unknown;
  executionContractDigest: string;
}): string {
  const payload = JSON.stringify({
    input: params.inputSchemaJson,
    output: params.outputSchemaJson,
    risk: params.riskMetadataJson,
    executionContract: params.executionContractJson,
    executionContractDigest: params.executionContractDigest,
  });
  const hex = createHash("sha256").update(payload, "utf-8").digest("hex");
  return `sha256:${hex}`;
}

// ═══════════════════════════════════════════════════════════
// Connection 仓储
// ═══════════════════════════════════════════════════════════

/** 创建 Connection。 */
export async function createConnection(params: {
  tenantId: string;
  connectionKey: string;
  connectionType: ConnectionType;
  endpointRef?: string | null;
  authMethod?: ConnectionAuthMethod;
  ownerUserId: string;
}): Promise<Connection> {
  assertValidKey(params.connectionKey, "connectionKey");
  assertValidConnectionType(params.connectionType);
  const authMethod = params.authMethod ?? "none";
  assertValidAuthMethod(authMethod);
  if (!params.ownerUserId) {
    throw new ToolValidationError("invalid_owner", "ownerUserId 不能为空");
  }
  if (params.endpointRef !== undefined && params.endpointRef !== null) {
    if (typeof params.endpointRef !== "string" || params.endpointRef.length === 0) {
      throw new ToolValidationError("invalid_endpoint_ref", "endpointRef 不能为空字符串");
    }
    if (params.endpointRef.length > 512) {
      throw new ToolValidationError("invalid_endpoint_ref", "endpointRef 长度不能超过 512");
    }
  }

  // 提前查重
  const existing = await getConnectionByKey({
    tenantId: params.tenantId,
    connectionKey: params.connectionKey,
  });
  if (existing) {
    throw new ToolValidationError(
      "connection_key_exists",
      `connectionKey 已存在: ${params.connectionKey}`,
    );
  }

  const id = randomUUID();
  try {
    await db.insert(connectionTable).values({
      id,
      tenantId: params.tenantId,
      connectionKey: params.connectionKey,
      connectionType: params.connectionType,
      endpointRef: params.endpointRef ?? null,
      authMethod,
      ownerUserId: params.ownerUserId,
      lifecycleState: "draft",
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      throw new ToolValidationError(
        "connection_key_exists",
        `connectionKey 已存在: ${params.connectionKey}`,
      );
    }
    throw err;
  }

  const [row] = await db.select().from(connectionTable).where(eq(connectionTable.id, id)).limit(1);
  if (!row) {
    throw new Error(`createConnection: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Connection（跨租户隔离）。不存在返回 null。 */
export async function getConnectionById(params: {
  tenantId: string;
  connectionId: string;
}): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(connectionTable)
    .where(
      and(
        eq(connectionTable.tenantId, params.tenantId),
        eq(connectionTable.id, params.connectionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 connectionKey 获取 Connection（跨租户隔离）。不存在返回 null。 */
export async function getConnectionByKey(params: {
  tenantId: string;
  connectionKey: string;
}): Promise<Connection | null> {
  const [row] = await db
    .select()
    .from(connectionTable)
    .where(
      and(
        eq(connectionTable.tenantId, params.tenantId),
        eq(connectionTable.connectionKey, params.connectionKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出 Connection（分页 + lifecycle 过滤；不含软删）。 */
export async function listConnections(params: {
  tenantId: string;
  lifecycleStates?: readonly ConnectionLifecycleState[];
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: Connection[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [
    eq(connectionTable.tenantId, params.tenantId),
    isNull(connectionTable.deletedAt),
  ];
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(connectionTable.lifecycleState, [...params.lifecycleStates]));
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.updatedAt);
      const cursorCondition = or(
        gt(connectionTable.updatedAt, cursorDate),
        and(eq(connectionTable.updatedAt, cursorDate), gt(connectionTable.id, decoded.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(connectionTable)
    .where(and(...conditions))
    .orderBy(asc(connectionTable.updatedAt), asc(connectionTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor({
          updatedAt: lastItem.updatedAt.toISOString(),
          id: lastItem.id,
        })
      : null;

  return { items, nextCursor };
}

/** 更新 Connection（乐观锁 + lifecycle 状态机校验）。 */
export async function updateConnection(params: {
  tenantId: string;
  connectionId: string;
  endpointRef?: string | null;
  authMethod?: ConnectionAuthMethod;
  lifecycleState?: ConnectionLifecycleState;
  expectedVersionNo: number;
}): Promise<Connection> {
  const current = await getConnectionById({
    tenantId: params.tenantId,
    connectionId: params.connectionId,
  });
  if (!current) {
    throw new ToolNotFoundError(params.connectionId);
  }

  // lifecycle 状态机校验
  if (params.lifecycleState && params.lifecycleState !== current.lifecycleState) {
    const allowed = LIFECYCLE_TRANSITIONS[current.lifecycleState];
    if (!allowed.includes(params.lifecycleState)) {
      throw new ToolLifecycleError(
        params.connectionId,
        "lifecycle",
        current.lifecycleState,
        params.lifecycleState,
        `Connection lifecycle 不允许 ${current.lifecycleState} → ${params.lifecycleState}`,
      );
    }
  }

  if (current.versionNo !== params.expectedVersionNo) {
    throw new ToolVersionConflictError(
      `Connection ${params.connectionId} versionNo 不匹配（期望 ${params.expectedVersionNo}, 实际 ${current.versionNo}）`,
    );
  }

  if (params.authMethod !== undefined) {
    assertValidAuthMethod(params.authMethod);
  }
  if (params.endpointRef !== undefined && params.endpointRef !== null) {
    if (typeof params.endpointRef !== "string" || params.endpointRef.length === 0) {
      throw new ToolValidationError("invalid_endpoint_ref", "endpointRef 不能为空字符串");
    }
    if (params.endpointRef.length > 512) {
      throw new ToolValidationError("invalid_endpoint_ref", "endpointRef 长度不能超过 512");
    }
  }

  const updates: Record<string, unknown> = {
    versionNo: current.versionNo + 1,
    updatedAt: new Date(),
  };
  if (params.endpointRef !== undefined) updates.endpointRef = params.endpointRef;
  if (params.authMethod !== undefined) updates.authMethod = params.authMethod;
  if (params.lifecycleState !== undefined) updates.lifecycleState = params.lifecycleState;

  const result = await db
    .update(connectionTable)
    .set(updates)
    .where(
      and(
        eq(connectionTable.tenantId, params.tenantId),
        eq(connectionTable.id, params.connectionId),
        eq(connectionTable.versionNo, params.expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    throw new ToolVersionConflictError(
      `Connection ${params.connectionId} 乐观锁冲突：update 未命中`,
    );
  }

  const updated = await getConnectionById({
    tenantId: params.tenantId,
    connectionId: params.connectionId,
  });
  if (!updated) {
    throw new ToolNotFoundError(params.connectionId);
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════
// CredentialRef 仓储
// ═══════════════════════════════════════════════════════════

/** 创建 CredentialRef（不存密文，只保存 Vault 引用 + 指纹）。 */
export async function createCredentialRef(params: {
  tenantId: string;
  connectionId?: string | null;
  provider: string;
  vaultRef: string;
  fingerprint: string;
  scopeJson?: unknown;
  expiresAt?: Date | null;
}): Promise<CredentialRef> {
  if (!params.provider) {
    throw new ToolValidationError("invalid_provider", "provider 不能为空");
  }
  if (!params.vaultRef) {
    throw new ToolValidationError("invalid_vault_ref", "vaultRef 不能为空");
  }
  assertValidHash(params.fingerprint, "fingerprint");

  // 若提供 connectionId，校验跨租户归属
  if (params.connectionId) {
    const conn = await getConnectionById({
      tenantId: params.tenantId,
      connectionId: params.connectionId,
    });
    if (!conn) {
      throw new ToolNotFoundError(params.connectionId);
    }
  }

  const id = randomUUID();
  await db.insert(credentialRefTable).values({
    id,
    tenantId: params.tenantId,
    connectionId: params.connectionId ?? null,
    provider: params.provider,
    vaultRef: params.vaultRef,
    fingerprint: params.fingerprint,
    scopeJson: params.scopeJson ?? null,
    expiresAt: params.expiresAt ?? null,
    lifecycleState: "active",
  });

  const [row] = await db
    .select()
    .from(credentialRefTable)
    .where(eq(credentialRefTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createCredentialRef: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 connection 列出 CredentialRef（跨租户隔离）。 */
export async function getCredentialRefsByConnection(params: {
  tenantId: string;
  connectionId: string;
}): Promise<CredentialRef[]> {
  return db
    .select()
    .from(credentialRefTable)
    .where(
      and(
        eq(credentialRefTable.tenantId, params.tenantId),
        eq(credentialRefTable.connectionId, params.connectionId),
      ),
    )
    .orderBy(desc(credentialRefTable.createdAt));
}

/** 撤销 CredentialRef（active/rotated → revoked，终态）。 */
export async function revokeCredentialRef(params: {
  tenantId: string;
  credentialRefId: string;
}): Promise<CredentialRef> {
  const [current] = await db
    .select()
    .from(credentialRefTable)
    .where(
      and(
        eq(credentialRefTable.tenantId, params.tenantId),
        eq(credentialRefTable.id, params.credentialRefId),
      ),
    )
    .limit(1);
  if (!current) {
    throw new ToolNotFoundError(params.credentialRefId);
  }
  if (current.lifecycleState === "revoked") {
    throw new ToolLifecycleError(
      params.credentialRefId,
      "lifecycle",
      current.lifecycleState,
      "revoked",
      "CredentialRef 已 revoked，不能再次撤销",
    );
  }

  await db
    .update(credentialRefTable)
    .set({ lifecycleState: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(credentialRefTable.tenantId, params.tenantId),
        eq(credentialRefTable.id, params.credentialRefId),
      ),
    );

  const [updated] = await db
    .select()
    .from(credentialRefTable)
    .where(eq(credentialRefTable.id, params.credentialRefId))
    .limit(1);
  if (!updated) {
    throw new ToolNotFoundError(params.credentialRefId);
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════
// ToolProvider 仓储
// ═══════════════════════════════════════════════════════════

/** 创建 ToolProvider。 */
export async function createToolProvider(params: {
  tenantId: string;
  providerKey: string;
  providerType: ToolProviderType;
  connectionId?: string | null;
  trustLevel?: ToolProviderTrustLevel;
  displayName: string;
  description?: string | null;
  ownerUserId: string;
}): Promise<ToolProvider> {
  assertValidKey(params.providerKey, "providerKey");
  assertValidProviderType(params.providerType);
  const trustLevel = params.trustLevel ?? "standard";
  assertValidTrustLevel(trustLevel);
  if (!params.displayName || params.displayName.length === 0) {
    throw new ToolValidationError("invalid_display_name", "displayName 不能为空");
  }
  if (!params.ownerUserId) {
    throw new ToolValidationError("invalid_owner", "ownerUserId 不能为空");
  }

  // 若提供 connectionId，校验跨租户归属
  if (params.connectionId) {
    const conn = await getConnectionById({
      tenantId: params.tenantId,
      connectionId: params.connectionId,
    });
    if (!conn) {
      throw new ToolNotFoundError(params.connectionId);
    }
  }

  // 提前查重
  const existing = await getToolProviderByKey({
    tenantId: params.tenantId,
    providerKey: params.providerKey,
  });
  if (existing) {
    throw new ToolValidationError(
      "provider_key_exists",
      `providerKey 已存在: ${params.providerKey}`,
    );
  }

  const id = randomUUID();
  try {
    await db.insert(toolProviderTable).values({
      id,
      tenantId: params.tenantId,
      providerKey: params.providerKey,
      providerType: params.providerType,
      connectionId: params.connectionId ?? null,
      trustLevel,
      displayName: params.displayName,
      description: params.description ?? null,
      ownerUserId: params.ownerUserId,
      lifecycleState: "draft",
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      throw new ToolValidationError(
        "provider_key_exists",
        `providerKey 已存在: ${params.providerKey}`,
      );
    }
    throw err;
  }

  const [row] = await db
    .select()
    .from(toolProviderTable)
    .where(eq(toolProviderTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createToolProvider: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 ToolProvider（跨租户隔离）。不存在返回 null。 */
export async function getToolProviderById(params: {
  tenantId: string;
  providerId: string;
}): Promise<ToolProvider | null> {
  const [row] = await db
    .select()
    .from(toolProviderTable)
    .where(
      and(
        eq(toolProviderTable.tenantId, params.tenantId),
        eq(toolProviderTable.id, params.providerId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 按 providerKey 获取 ToolProvider（跨租户隔离）。不存在返回 null。 */
export async function getToolProviderByKey(params: {
  tenantId: string;
  providerKey: string;
}): Promise<ToolProvider | null> {
  const [row] = await db
    .select()
    .from(toolProviderTable)
    .where(
      and(
        eq(toolProviderTable.tenantId, params.tenantId),
        eq(toolProviderTable.providerKey, params.providerKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出 ToolProvider（分页 + providerType / lifecycle 过滤；不含软删）。 */
export async function listToolProviders(params: {
  tenantId: string;
  providerTypes?: readonly ToolProviderType[];
  lifecycleStates?: readonly ToolProviderLifecycleState[];
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: ToolProvider[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [
    eq(toolProviderTable.tenantId, params.tenantId),
    isNull(toolProviderTable.deletedAt),
  ];
  if (params.providerTypes && params.providerTypes.length > 0) {
    conditions.push(inArray(toolProviderTable.providerType, [...params.providerTypes]));
  }
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(toolProviderTable.lifecycleState, [...params.lifecycleStates]));
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.updatedAt);
      const cursorCondition = or(
        gt(toolProviderTable.updatedAt, cursorDate),
        and(eq(toolProviderTable.updatedAt, cursorDate), gt(toolProviderTable.id, decoded.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(toolProviderTable)
    .where(and(...conditions))
    .orderBy(asc(toolProviderTable.updatedAt), asc(toolProviderTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor({
          updatedAt: lastItem.updatedAt.toISOString(),
          id: lastItem.id,
        })
      : null;

  return { items, nextCursor };
}

/** 更新 ToolProvider（乐观锁 + lifecycle 状态机校验）。 */
export async function updateToolProvider(params: {
  tenantId: string;
  providerId: string;
  displayName?: string;
  description?: string | null;
  trustLevel?: ToolProviderTrustLevel;
  connectionId?: string | null;
  lifecycleState?: ToolProviderLifecycleState;
  expectedVersionNo: number;
}): Promise<ToolProvider> {
  const current = await getToolProviderById({
    tenantId: params.tenantId,
    providerId: params.providerId,
  });
  if (!current) {
    throw new ToolNotFoundError(params.providerId);
  }

  // lifecycle 状态机校验
  if (params.lifecycleState && params.lifecycleState !== current.lifecycleState) {
    const allowed = LIFECYCLE_TRANSITIONS[current.lifecycleState];
    if (!allowed.includes(params.lifecycleState)) {
      throw new ToolLifecycleError(
        params.providerId,
        "lifecycle",
        current.lifecycleState,
        params.lifecycleState,
        `ToolProvider lifecycle 不允许 ${current.lifecycleState} → ${params.lifecycleState}`,
      );
    }
  }

  if (current.versionNo !== params.expectedVersionNo) {
    throw new ToolVersionConflictError(
      `ToolProvider ${params.providerId} versionNo 不匹配（期望 ${params.expectedVersionNo}, 实际 ${current.versionNo}）`,
    );
  }

  if (params.displayName !== undefined && params.displayName.length === 0) {
    throw new ToolValidationError("invalid_display_name", "displayName 不能为空");
  }
  if (params.trustLevel !== undefined) {
    assertValidTrustLevel(params.trustLevel);
  }
  // 若提供 connectionId，校验跨租户归属
  if (params.connectionId) {
    const conn = await getConnectionById({
      tenantId: params.tenantId,
      connectionId: params.connectionId,
    });
    if (!conn) {
      throw new ToolNotFoundError(params.connectionId);
    }
  }

  const updates: Record<string, unknown> = {
    versionNo: current.versionNo + 1,
    updatedAt: new Date(),
  };
  if (params.displayName !== undefined) updates.displayName = params.displayName;
  if (params.description !== undefined) updates.description = params.description;
  if (params.trustLevel !== undefined) updates.trustLevel = params.trustLevel;
  if (params.connectionId !== undefined) updates.connectionId = params.connectionId;
  if (params.lifecycleState !== undefined) updates.lifecycleState = params.lifecycleState;

  const result = await db
    .update(toolProviderTable)
    .set(updates)
    .where(
      and(
        eq(toolProviderTable.tenantId, params.tenantId),
        eq(toolProviderTable.id, params.providerId),
        eq(toolProviderTable.versionNo, params.expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    throw new ToolVersionConflictError(
      `ToolProvider ${params.providerId} 乐观锁冲突：update 未命中`,
    );
  }

  const updated = await getToolProviderById({
    tenantId: params.tenantId,
    providerId: params.providerId,
  });
  if (!updated) {
    throw new ToolNotFoundError(params.providerId);
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════
// Tool 仓储
// ═══════════════════════════════════════════════════════════

/** 创建 Tool（事务内校验 providerId 存在且 enabled）。 */
export async function createTool(params: {
  tenantId: string;
  providerId: string;
  toolKey: string;
  displayName: string;
  description?: string | null;
  riskClass?: ToolRiskClass;
}): Promise<Tool> {
  assertValidKey(params.toolKey, "toolKey");
  if (!params.displayName || params.displayName.length === 0) {
    throw new ToolValidationError("invalid_display_name", "displayName 不能为空");
  }
  const riskClass = params.riskClass ?? "medium";
  assertValidRiskClass(riskClass);

  // 校验 ToolProvider 存在 + 跨租户隔离 + enabled
  const provider = await getToolProviderById({
    tenantId: params.tenantId,
    providerId: params.providerId,
  });
  if (!provider) {
    throw new ToolNotFoundError(params.providerId);
  }
  if (provider.lifecycleState !== "enabled") {
    throw new ToolLifecycleError(
      params.providerId,
      "lifecycle",
      provider.lifecycleState,
      provider.lifecycleState,
      `ToolProvider lifecycleState=${provider.lifecycleState}，必须为 enabled 才能 createTool`,
    );
  }

  // 提前查重
  const existing = await getToolByKey({
    tenantId: params.tenantId,
    providerId: params.providerId,
    toolKey: params.toolKey,
  });
  if (existing) {
    throw new ToolValidationError("tool_key_exists", `toolKey 已存在: ${params.toolKey}`);
  }

  const id = randomUUID();
  try {
    await db.insert(toolTable).values({
      id,
      tenantId: params.tenantId,
      providerId: params.providerId,
      toolKey: params.toolKey,
      displayName: params.displayName,
      description: params.description ?? null,
      riskClass,
      lifecycleState: "draft",
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      throw new ToolValidationError("tool_key_exists", `toolKey 已存在: ${params.toolKey}`);
    }
    throw err;
  }

  const [row] = await db.select().from(toolTable).where(eq(toolTable.id, id)).limit(1);
  if (!row) {
    throw new Error(`createTool: 行未找到（id=${id}）`);
  }
  return row;
}

/** 按 id 获取 Tool（跨租户隔离）。不存在返回 null。 */
export async function getToolById(params: {
  tenantId: string;
  toolId: string;
}): Promise<Tool | null> {
  const [row] = await db
    .select()
    .from(toolTable)
    .where(and(eq(toolTable.tenantId, params.tenantId), eq(toolTable.id, params.toolId)))
    .limit(1);
  return row ?? null;
}

/** 按 (providerId, toolKey) 获取 Tool（跨租户隔离）。不存在返回 null。 */
export async function getToolByKey(params: {
  tenantId: string;
  providerId: string;
  toolKey: string;
}): Promise<Tool | null> {
  const [row] = await db
    .select()
    .from(toolTable)
    .where(
      and(
        eq(toolTable.tenantId, params.tenantId),
        eq(toolTable.providerId, params.providerId),
        eq(toolTable.toolKey, params.toolKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 列出 Tool（分页 + providerId / lifecycle / riskClass 过滤；不含软删）。 */
export async function listTools(params: {
  tenantId: string;
  providerId?: string;
  lifecycleStates?: readonly ToolLifecycleState[];
  riskClasses?: readonly ToolRiskClass[];
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: Tool[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const conditions = [eq(toolTable.tenantId, params.tenantId), isNull(toolTable.deletedAt)];
  if (params.providerId) {
    conditions.push(eq(toolTable.providerId, params.providerId));
  }
  if (params.lifecycleStates && params.lifecycleStates.length > 0) {
    conditions.push(inArray(toolTable.lifecycleState, [...params.lifecycleStates]));
  }
  if (params.riskClasses && params.riskClasses.length > 0) {
    conditions.push(inArray(toolTable.riskClass, [...params.riskClasses]));
  }

  if (params.cursor) {
    const decoded = decodeCursor(params.cursor);
    if (decoded) {
      const cursorDate = new Date(decoded.updatedAt);
      const cursorCondition = or(
        gt(toolTable.updatedAt, cursorDate),
        and(eq(toolTable.updatedAt, cursorDate), gt(toolTable.id, decoded.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
  }

  const rows = await db
    .select()
    .from(toolTable)
    .where(and(...conditions))
    .orderBy(asc(toolTable.updatedAt), asc(toolTable.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor({
          updatedAt: lastItem.updatedAt.toISOString(),
          id: lastItem.id,
        })
      : null;

  return { items, nextCursor };
}

/** 更新 Tool（乐观锁 + lifecycle 状态机校验）。 */
export async function updateTool(params: {
  tenantId: string;
  toolId: string;
  displayName?: string;
  description?: string | null;
  riskClass?: ToolRiskClass;
  lifecycleState?: ToolLifecycleState;
  expectedVersionNo: number;
}): Promise<Tool> {
  const current = await getToolById({
    tenantId: params.tenantId,
    toolId: params.toolId,
  });
  if (!current) {
    throw new ToolNotFoundError(params.toolId);
  }

  // lifecycle 状态机校验
  if (params.lifecycleState && params.lifecycleState !== current.lifecycleState) {
    const allowed = LIFECYCLE_TRANSITIONS[current.lifecycleState];
    if (!allowed.includes(params.lifecycleState)) {
      throw new ToolLifecycleError(
        params.toolId,
        "lifecycle",
        current.lifecycleState,
        params.lifecycleState,
        `Tool lifecycle 不允许 ${current.lifecycleState} → ${params.lifecycleState}`,
      );
    }
  }

  if (current.versionNo !== params.expectedVersionNo) {
    throw new ToolVersionConflictError(
      `Tool ${params.toolId} versionNo 不匹配（期望 ${params.expectedVersionNo}, 实际 ${current.versionNo}）`,
    );
  }

  if (params.displayName !== undefined && params.displayName.length === 0) {
    throw new ToolValidationError("invalid_display_name", "displayName 不能为空");
  }
  if (params.riskClass !== undefined) {
    assertValidRiskClass(params.riskClass);
  }

  const updates: Record<string, unknown> = {
    versionNo: current.versionNo + 1,
    updatedAt: new Date(),
  };
  if (params.displayName !== undefined) updates.displayName = params.displayName;
  if (params.description !== undefined) updates.description = params.description;
  if (params.riskClass !== undefined) updates.riskClass = params.riskClass;
  if (params.lifecycleState !== undefined) updates.lifecycleState = params.lifecycleState;

  const result = await db
    .update(toolTable)
    .set(updates)
    .where(
      and(
        eq(toolTable.tenantId, params.tenantId),
        eq(toolTable.id, params.toolId),
        eq(toolTable.versionNo, params.expectedVersionNo),
      ),
    );

  if (result[0].affectedRows === 0) {
    throw new ToolVersionConflictError(`Tool ${params.toolId} 乐观锁冲突：update 未命中`);
  }

  const updated = await getToolById({
    tenantId: params.tenantId,
    toolId: params.toolId,
  });
  if (!updated) {
    throw new ToolNotFoundError(params.toolId);
  }
  return updated;
}

// ═══════════════════════════════════════════════════════════
// ToolSchemaRevision 仓储
// ═══════════════════════════════════════════════════════════

/** 创建 ToolSchemaRevision（事务内校验 toolId 存在 + 分配 revisionNo）。 */
export async function createToolSchemaRevision(params: {
  tenantId: string;
  toolId: string;
  description?: string | null;
  inputSchemaJson: unknown;
  outputSchemaJson?: unknown;
  riskMetadataJson?: unknown;
  executionContractJson: unknown;
  createdBy: string;
}): Promise<ToolSchemaRevision> {
  if (!params.createdBy) {
    throw new ToolValidationError("invalid_created_by", "createdBy 不能为空");
  }
  // inputSchemaJson 必须为非空 object
  if (
    typeof params.inputSchemaJson !== "object" ||
    params.inputSchemaJson === null ||
    Array.isArray(params.inputSchemaJson)
  ) {
    throw new ToolValidationError("invalid_input_schema", "inputSchemaJson 必须是 JSON 对象");
  }

  // 校验 Tool 存在 + 跨租户隔离
  const tool = await getToolById({
    tenantId: params.tenantId,
    toolId: params.toolId,
  });
  if (!tool) {
    throw new ToolNotFoundError(params.toolId);
  }
  if (tool.lifecycleState === "retired") {
    throw new ToolLifecycleError(
      params.toolId,
      "lifecycle",
      tool.lifecycleState,
      tool.lifecycleState,
      "Tool 已 retired，不能创建新 SchemaRevision",
    );
  }

  const revisionNo = await nextRevisionNo(params.toolId);
  const executionContractJson = parseToolExecutionContract(params.executionContractJson);
  const executionContractDigest = computeToolExecutionContractDigest(executionContractJson);
  const schemaHash = computeSchemaHash({
    inputSchemaJson: params.inputSchemaJson,
    outputSchemaJson: params.outputSchemaJson ?? null,
    riskMetadataJson: params.riskMetadataJson ?? null,
    executionContractJson,
    executionContractDigest,
  });

  const id = randomUUID();
  try {
    await db.insert(toolSchemaRevisionTable).values({
      id,
      toolId: params.toolId,
      revisionNo,
      description: params.description ?? null,
      inputSchemaJson: params.inputSchemaJson,
      outputSchemaJson: params.outputSchemaJson ?? null,
      schemaHash,
      riskMetadataJson: params.riskMetadataJson ?? null,
      executionContractJson,
      executionContractDigest,
      revisionState: "draft",
      createdBy: params.createdBy,
    });
  } catch (err) {
    if (isMysqlDuplicateEntryError(err)) {
      throw new ToolVersionConflictError(
        `ToolSchemaRevision 并发冲突：revisionNo=${revisionNo} 已被占用 (toolId=${params.toolId})`,
      );
    }
    throw err;
  }

  const [row] = await db
    .select()
    .from(toolSchemaRevisionTable)
    .where(eq(toolSchemaRevisionTable.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`createToolSchemaRevision: 行未找到（id=${id}）`);
  }
  return row;
}

/** 获取 ToolSchemaRevision（跨租户隔离：通过 join Tool 校验 tenantId）。 */
export async function getToolSchemaRevisionById(params: {
  tenantId: string;
  schemaRevisionId: string;
}): Promise<ToolSchemaRevision | null> {
  const [row] = await db
    .select({ revision: toolSchemaRevisionTable, tool: toolTable })
    .from(toolSchemaRevisionTable)
    .innerJoin(toolTable, eq(toolSchemaRevisionTable.toolId, toolTable.id))
    .where(
      and(
        eq(toolTable.tenantId, params.tenantId),
        eq(toolSchemaRevisionTable.id, params.schemaRevisionId),
      ),
    )
    .limit(1);
  return row?.revision ?? null;
}

/** 列出 Tool 的 SchemaRevision（按 revisionNo 降序）。 */
export async function listToolSchemaRevisions(params: {
  tenantId: string;
  toolId: string;
  revisionStates?: readonly ToolRevisionState[];
  limit?: number;
}): Promise<ToolSchemaRevision[]> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
  // 先校验 toolId 属于 tenantId
  const tool = await getToolById({
    tenantId: params.tenantId,
    toolId: params.toolId,
  });
  if (!tool) {
    throw new ToolNotFoundError(params.toolId);
  }

  const conditions = [eq(toolSchemaRevisionTable.toolId, params.toolId)];
  if (params.revisionStates && params.revisionStates.length > 0) {
    conditions.push(inArray(toolSchemaRevisionTable.revisionState, [...params.revisionStates]));
  }

  return db
    .select()
    .from(toolSchemaRevisionTable)
    .where(and(...conditions))
    .orderBy(desc(toolSchemaRevisionTable.revisionNo))
    .limit(limit);
}

/** 获取当前生效 SchemaRevision（currentSchemaRevisionId 对应的版本）。 */
export async function getCurrentToolSchemaRevision(params: {
  tenantId: string;
  toolId: string;
}): Promise<ToolSchemaRevision | null> {
  const tool = await getToolById({
    tenantId: params.tenantId,
    toolId: params.toolId,
  });
  if (!tool || !tool.currentSchemaRevisionId) return null;

  return getToolSchemaRevisionById({
    tenantId: params.tenantId,
    schemaRevisionId: tool.currentSchemaRevisionId,
  });
}

/**
 * 发布 ToolSchemaRevision（事务内：draft → published + 旧 published → withdrawn +
 * Tool.currentSchemaRevisionId 更新）。
 *
 * @throws ToolNotFoundError SchemaRevision 不存在或跨租户
 * @throws ToolLifecycleError revisionState 状态机非法（非 draft 不能 publish）
 */
export async function publishToolSchemaRevision(params: {
  tenantId: string;
  schemaRevisionId: string;
  publishedBy: string;
}): Promise<{ tool: Tool; revision: ToolSchemaRevision }> {
  const revision = await getToolSchemaRevisionById({
    tenantId: params.tenantId,
    schemaRevisionId: params.schemaRevisionId,
  });
  if (!revision) {
    throw new ToolNotFoundError(params.schemaRevisionId);
  }

  // revision 状态机校验
  if (revision.revisionState !== "draft") {
    throw new ToolLifecycleError(
      params.schemaRevisionId,
      "revision",
      revision.revisionState,
      "published",
      `ToolSchemaRevision 状态为 ${revision.revisionState}，只有 draft 状态可发布`,
    );
  }

  // 加载 Tool
  const tool = await getToolById({
    tenantId: params.tenantId,
    toolId: revision.toolId,
  });
  if (!tool) {
    throw new ToolNotFoundError(revision.toolId);
  }

  const now = new Date();
  const expectedVersionNo = tool.versionNo;

  // 事务：1) 旧 published → withdrawn；2) 新版本 draft → published；3) Tool.currentSchemaRevisionId 更新。
  await db.transaction(async (tx) => {
    // 1. 旧 published → withdrawn（除当前正在发布的版本外）
    if (tool.currentSchemaRevisionId && tool.currentSchemaRevisionId !== params.schemaRevisionId) {
      await tx
        .update(toolSchemaRevisionTable)
        .set({ revisionState: "withdrawn" })
        .where(
          and(
            eq(toolSchemaRevisionTable.toolId, tool.id),
            eq(toolSchemaRevisionTable.revisionState, "published"),
          ),
        );
    }

    // 2. 新版本 draft → published
    const publishResult = await tx
      .update(toolSchemaRevisionTable)
      .set({ revisionState: "published", publishedAt: now })
      .where(eq(toolSchemaRevisionTable.id, params.schemaRevisionId));
    if (publishResult[0].affectedRows === 0) {
      throw new ToolVersionConflictError(
        `publishToolSchemaRevision: 更新 ToolSchemaRevision=${params.schemaRevisionId} 为 published 失败`,
      );
    }

    // 3. Tool.currentSchemaRevisionId 更新（乐观锁）
    const toolUpdateResult = await tx
      .update(toolTable)
      .set({
        currentSchemaRevisionId: params.schemaRevisionId,
        versionNo: expectedVersionNo + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(toolTable.tenantId, params.tenantId),
          eq(toolTable.id, tool.id),
          eq(toolTable.versionNo, expectedVersionNo),
        ),
      );
    if (toolUpdateResult[0].affectedRows === 0) {
      throw new ToolVersionConflictError(
        `publishToolSchemaRevision: Tool=${tool.id} 乐观锁冲突（期望 versionNo=${expectedVersionNo}）`,
      );
    }
  });

  // 回查返回最新状态
  const updatedRevision = await getToolSchemaRevisionById({
    tenantId: params.tenantId,
    schemaRevisionId: params.schemaRevisionId,
  });
  if (!updatedRevision) {
    throw new ToolNotFoundError(params.schemaRevisionId);
  }
  const updatedTool = await getToolById({
    tenantId: params.tenantId,
    toolId: tool.id,
  });
  if (!updatedTool) {
    throw new ToolNotFoundError(tool.id);
  }
  return { tool: updatedTool, revision: updatedRevision };
}

// ─── 内部工具 ──────────────────────────────────────────────

/** 计算 Tool 内下一个 revisionNo（max +1）。并发冲突由 UNIQUE 约束 fail-loud。 */
async function nextRevisionNo(toolId: string): Promise<number> {
  const [row] = await db
    .select({ maxNo: max(toolSchemaRevisionTable.revisionNo) })
    .from(toolSchemaRevisionTable)
    .where(eq(toolSchemaRevisionTable.toolId, toolId));
  const currentMax = row?.maxNo;
  if (currentMax === null || currentMax === undefined) return 1;
  return currentMax + 1;
}

/** 编码不透明 cursor（base64url(JSON)）。 */
function encodeCursor(payload: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
}

/** 解码不透明 cursor。非法返回 null。 */
function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as { updatedAt?: string; id?: string };
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") return null;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

// ─── Re-exports ────────────────────────────────────────────

export type {
  ConnectionAuthMethod,
  ConnectionLifecycleState,
  ConnectionType,
  CredentialRefLifecycleState,
  ToolLifecycleState,
  ToolProviderLifecycleState,
  ToolProviderTrustLevel,
  ToolProviderType,
  ToolRevisionState,
  ToolRiskClass,
  Connection,
  CredentialRef,
  Tool,
  ToolProvider,
  ToolSchemaRevision,
} from "@/lib/persistence/schema/tool";

export {
  CONNECTION_AUTH_METHODS,
  CONNECTION_LIFECYCLE_STATES,
  CONNECTION_TYPES,
  CREDENTIAL_REF_LIFECYCLE_STATES,
  TOOL_LIFECYCLE_STATES,
  TOOL_PROVIDER_LIFECYCLE_STATES,
  TOOL_PROVIDER_TRUST_LEVELS,
  TOOL_PROVIDER_TYPES,
  TOOL_REVISION_STATES,
  TOOL_RISK_CLASSES,
} from "@/lib/persistence/schema/tool";
