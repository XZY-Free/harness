/**
 * V11 PermissionDecision + Grant 仓储（阶段 8 S08-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.8（permission_decision、
 *   user_action_request 与 grant）、§5.5（ToolCall、Effect 与 Credential）。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §5.5（PermissionDecision）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §10（block 不可被绕过）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W03。
 *
 * 关键不变量：
 * - PermissionDecision：UNIQUE(toolCallId, decisionSequence)；每次评估新增行，
 *   decisionSequence 从 1 开始递增。允许同一 ToolCall 多次评估。
 * - decision=block 不创建可绕过的 UserActionRequest（§10，由调用方在收到 block 时不创建）。
 * - Agent 只能收紧不能放宽平台策略（应用层校验，本仓储不强制）。
 * - Grant.scope 必须覆盖 ToolCall 所需 scope（应用层校验）。
 * - Grant 撤销后不可注入；过期后不可注入。
 * - credentialRefId 外键 → V11CredentialRef(id) ON DELETE RESTRICT。
 * - 终态 Grant 不可恢复。
 * - MySQL 不支持 .returning()：update + select 两步。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  GRANT_STATES,
  GRANT_TERMINAL_STATES,
  GRANT_TYPES,
  type GrantState,
  type GrantType,
  type NewV11Grant,
  type NewV11PermissionDecision,
  type V11Grant,
  type V11PermissionDecision,
  type V11PermissionDecisionValue,
  V11_PERMISSION_DECISIONS,
  v11Grant,
  v11PermissionDecision,
} from "@/lib/v11/schema/permission";
import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";

// ─── 错误类型 ──────────────────────────────────────────────

export class PermissionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionValidationError";
  }
}

export class PermissionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionNotFoundError";
  }
}

export class GrantValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantValidationError";
  }
}

export class GrantNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantNotFoundError";
  }
}

export class GrantStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantStateError";
  }
}

export class GrantVersionConflictError extends Error {
  public readonly expectedVersionNo: number;
  public readonly actualVersionNo: number;

  constructor(message: string, expectedVersionNo: number, actualVersionNo: number) {
    super(message);
    this.name = "GrantVersionConflictError";
    this.expectedVersionNo = expectedVersionNo;
    this.actualVersionNo = actualVersionNo;
  }
}

/**
 * ToolCall 被策略阻止（decision=block）。
 * 调用方据此拒绝执行且不创建可绕过的 UserActionRequest（§10）。
 */
export class ToolCallBlockedError extends Error {
  public readonly toolCallId: string;
  public readonly reasonCodes: string[];

  constructor(toolCallId: string, reasonCodes: string[], message: string) {
    super(message);
    this.name = "ToolCallBlockedError";
    this.toolCallId = toolCallId;
    this.reasonCodes = reasonCodes;
  }
}

/**
 * ToolCall 处于 pause 状态（decision=pause）。
 * 调用方应创建 UserActionRequest 等待用户操作。
 */
export class ToolCallPausedError extends Error {
  public readonly toolCallId: string;
  public readonly reasonCodes: string[];

  constructor(toolCallId: string, reasonCodes: string[], message: string) {
    super(message);
    this.name = "ToolCallPausedError";
    this.toolCallId = toolCallId;
    this.reasonCodes = reasonCodes;
  }
}

// ─── 校验辅助 ──────────────────────────────────────────────

const VALID_PERMISSION_DECISIONS = new Set<string>(V11_PERMISSION_DECISIONS);
const VALID_GRANT_TYPES = new Set<string>(GRANT_TYPES);
const VALID_GRANT_STATES = new Set<string>(GRANT_STATES);

export function isPermissionDecision(value: string): value is V11PermissionDecisionValue {
  return VALID_PERMISSION_DECISIONS.has(value);
}

export function isGrantType(value: string): value is GrantType {
  return VALID_GRANT_TYPES.has(value);
}

export function isGrantState(value: string): value is GrantState {
  return VALID_GRANT_STATES.has(value);
}

/**
 * 判断 scope 是否覆盖所需 scope。
 *
 * 规则（§6.8 + §5.5）：
 * - 所需 scope 中每个元素必须出现在 grant scope 列表中，或被更宽的 scope 包含
 *   （如 `file:read:/tmp/*` 覆盖 `file:read:/tmp/foo.txt`）。
 * - 简化实现：精确匹配或前缀通配匹配（`scope:*` 覆盖 `scope:action`）。
 *
 * 本函数不处理 scope 字符串的语义解释，调用方需按平台 scope 规范构造。
 */
export function isScopeCoveredBy(
  requiredScopes: readonly string[],
  grantedScopes: readonly string[],
): boolean {
  if (requiredScopes.length === 0) return true;
  if (grantedScopes.length === 0) return false;

  const grantedSet = new Set(grantedScopes);
  for (const required of requiredScopes) {
    if (grantedSet.has(required)) continue;
    // 前缀通配：`tool:execute:*` 覆盖 `tool:execute:foo`
    const parts = required.split(":");
    let prefix = parts[0] ?? "";
    let covered = false;
    for (let i = 1; i < parts.length; i++) {
      prefix = `${prefix}:${parts[i]}`;
      if (grantedSet.has(`${prefix}:*`) || grantedSet.has(`${prefix}:**`)) {
        covered = true;
        break;
      }
    }
    // 顶级通配 `tool:*` 覆盖 `tool:execute:foo`
    if (!covered) {
      const topLevel = parts[0];
      if (topLevel && (grantedSet.has(`${topLevel}:*`) || grantedSet.has(`${topLevel}:**`))) {
        covered = true;
      }
    }
    if (!covered) return false;
  }
  return true;
}

// ─── PermissionDecision CRUD ──────────────────────────────

export interface RecordPermissionDecisionInput {
  tenantId: string;
  toolCallId: string;
  decision: V11PermissionDecisionValue;
  policyRevisionId?: string | null;
  reasonCodes: string[];
  riskSummary?: Record<string, unknown> | null;
  decisionSummary?: string | null;
  decidedBy: string;
}

/**
 * 记录一次 PermissionDecision（新行；decisionSequence 自增）。
 *
 * 关键约束：
 * - UNIQUE(toolCallId, decisionSequence)：事务内 max+1 分配，避免并发冲突。
 * - 不修改旧决策行，只追加新行（审计事实不可变）。
 * - 调用方收到 block 时不创建可绕过的 UserActionRequest（§10）。
 */
export async function recordPermissionDecision(
  input: RecordPermissionDecisionInput,
): Promise<V11PermissionDecision> {
  if (!input.tenantId) throw new PermissionValidationError("tenantId 不能为空");
  if (!input.toolCallId) throw new PermissionValidationError("toolCallId 不能为空");
  if (!isPermissionDecision(input.decision)) {
    throw new PermissionValidationError(`非法 decision: ${input.decision}`);
  }
  if (!Array.isArray(input.reasonCodes)) {
    throw new PermissionValidationError("reasonCodes 必须是字符串数组");
  }
  if (!input.decidedBy) throw new PermissionValidationError("decidedBy 不能为空");

  // 事务内分配 decisionSequence（max+1）
  const id = randomUUID();
  const now = new Date();

  return db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ maxSeq: sql<number>`COALESCE(MAX(${v11PermissionDecision.decisionSequence}), 0)` })
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.toolCallId, input.toolCallId));
    const decisionSequence = (maxRow?.maxSeq ?? 0) + 1;

    const insert: NewV11PermissionDecision = {
      id,
      tenantId: input.tenantId,
      toolCallId: input.toolCallId,
      decisionSequence,
      decision: input.decision,
      policyRevisionId: input.policyRevisionId ?? null,
      reasonCodesJson: input.reasonCodes,
      riskSummaryJson: input.riskSummary ?? null,
      decisionSummary: input.decisionSummary ?? null,
      decidedBy: input.decidedBy,
      decidedAt: now,
      createdAt: now,
    };
    await tx.insert(v11PermissionDecision).values(insert);

    const [row] = await tx
      .select()
      .from(v11PermissionDecision)
      .where(eq(v11PermissionDecision.id, id))
      .limit(1);
    if (!row) {
      throw new PermissionNotFoundError(
        `PermissionDecision 创建后回查失败（toolCallId=${input.toolCallId}）`,
      );
    }
    return row;
  });
}

export async function getPermissionDecisionById(
  tenantId: string,
  id: string,
): Promise<V11PermissionDecision | null> {
  const [row] = await db
    .select()
    .from(v11PermissionDecision)
    .where(and(eq(v11PermissionDecision.tenantId, tenantId), eq(v11PermissionDecision.id, id)))
    .limit(1);
  return row ?? null;
}

export async function getPermissionDecisionsByToolCall(
  tenantId: string,
  toolCallId: string,
): Promise<V11PermissionDecision[]> {
  return db
    .select()
    .from(v11PermissionDecision)
    .where(
      and(
        eq(v11PermissionDecision.tenantId, tenantId),
        eq(v11PermissionDecision.toolCallId, toolCallId),
      ),
    )
    .orderBy(asc(v11PermissionDecision.decisionSequence));
}

/**
 * 获取 ToolCall 最新决策（decisionSequence 最大）。
 * 不存在返回 null。
 */
export async function getLatestPermissionDecision(
  tenantId: string,
  toolCallId: string,
): Promise<V11PermissionDecision | null> {
  const [row] = await db
    .select()
    .from(v11PermissionDecision)
    .where(
      and(
        eq(v11PermissionDecision.tenantId, tenantId),
        eq(v11PermissionDecision.toolCallId, toolCallId),
      ),
    )
    .orderBy(desc(v11PermissionDecision.decisionSequence))
    .limit(1);
  return row ?? null;
}

/**
 * 断言 ToolCall 当前最新决策允许执行。
 *
 * 规则（§10）：
 * - 无决策 → PermissionNotFoundError（平台必须先评估再执行）。
 * - decision=allow → 通过。
 * - decision=pause → ToolCallPausedError（调用方应创建 UserActionRequest）。
 * - decision=block → ToolCallBlockedError（不创建可绕过的 UserActionRequest）。
 */
export async function assertToolCallAllowed(
  tenantId: string,
  toolCallId: string,
): Promise<V11PermissionDecision> {
  const latest = await getLatestPermissionDecision(tenantId, toolCallId);
  if (!latest) {
    throw new PermissionNotFoundError(`ToolCall ${toolCallId} 尚未评估 PermissionDecision`);
  }
  if (latest.decision === "allow") return latest;
  if (latest.decision === "pause") {
    throw new ToolCallPausedError(
      toolCallId,
      latest.reasonCodesJson as string[],
      latest.decisionSummary ?? `ToolCall ${toolCallId} 被暂停，等待用户操作`,
    );
  }
  throw new ToolCallBlockedError(
    toolCallId,
    latest.reasonCodesJson as string[],
    latest.decisionSummary ?? `ToolCall ${toolCallId} 被策略阻止`,
  );
}

// ─── Grant CRUD ───────────────────────────────────────────

export interface IssueGrantInput {
  tenantId: string;
  userId: string;
  grantType: GrantType;
  scope: string[];
  credentialRefId: string;
  issuedBy: string;
  expiresAt?: Date | null;
}

/**
 * 创建 Grant（用户授权记录）。
 *
 * 关键约束：
 * - scope 必须非空（至少包含一个权限声明）。
 * - credentialRefId 必须指向同一租户内的 V11CredentialRef（DB FK 保证）。
 * - admin_override 类型必须由管理员发起（应用层校验，本仓储不强制）。
 * - 创建时 grantState=active；revokedAt=null。
 */
export async function issueGrant(input: IssueGrantInput): Promise<V11Grant> {
  if (!input.tenantId) throw new GrantValidationError("tenantId 不能为空");
  if (!input.userId) throw new GrantValidationError("userId 不能为空");
  if (!isGrantType(input.grantType)) {
    throw new GrantValidationError(`非法 grantType: ${input.grantType}`);
  }
  if (!Array.isArray(input.scope) || input.scope.length === 0) {
    throw new GrantValidationError("scope 必须是非空字符串数组");
  }
  if (!input.credentialRefId) throw new GrantValidationError("credentialRefId 不能为空");
  if (!input.issuedBy) throw new GrantValidationError("issuedBy 不能为空");
  if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
    throw new GrantValidationError("expiresAt 必须是未来时间");
  }

  const id = randomUUID();
  const now = new Date();
  const insert: NewV11Grant = {
    id,
    tenantId: input.tenantId,
    userId: input.userId,
    grantType: input.grantType,
    scopeJson: input.scope,
    credentialRefId: input.credentialRefId,
    issuedBy: input.issuedBy,
    issuedAt: now,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    revokeReasonCode: null,
    grantState: "active",
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(v11Grant).values(insert);

  const [row] = await db.select().from(v11Grant).where(eq(v11Grant.id, id)).limit(1);
  if (!row) {
    throw new GrantNotFoundError(`Grant 创建后回查失败（tenantId=${input.tenantId}）`);
  }
  return row;
}

export async function getGrantById(tenantId: string, id: string): Promise<V11Grant | null> {
  const [row] = await db
    .select()
    .from(v11Grant)
    .where(and(eq(v11Grant.tenantId, tenantId), eq(v11Grant.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * 列出用户的所有 Grant（按 issuedAt 降序）。
 * 可选按 grantState 过滤（默认全部）。
 */
export async function listGrantsByUser(
  tenantId: string,
  userId: string,
  state?: GrantState,
): Promise<V11Grant[]> {
  const conditions = [eq(v11Grant.tenantId, tenantId), eq(v11Grant.userId, userId)];
  if (state) conditions.push(eq(v11Grant.grantState, state));
  return db
    .select()
    .from(v11Grant)
    .where(and(...conditions))
    .orderBy(desc(v11Grant.issuedAt));
}

/**
 * 列出某 CredentialRef 的所有活跃 Grant。
 * 用于 CredentialRef 撤销时联动检查仍有效的 Grant。
 */
export async function listActiveGrantsForCredential(
  tenantId: string,
  credentialRefId: string,
): Promise<V11Grant[]> {
  return db
    .select()
    .from(v11Grant)
    .where(
      and(
        eq(v11Grant.tenantId, tenantId),
        eq(v11Grant.credentialRefId, credentialRefId),
        eq(v11Grant.grantState, "active"),
      ),
    )
    .orderBy(desc(v11Grant.issuedAt));
}

/**
 * 撤销 Grant（active → revoked；revokedAt 回填；不可恢复）。
 *
 * 严格条件：仅当 Grant 存在、跨租户可见且 grantState=active 时撤销。
 * - 已 revoked/expired → GrantStateError（不可恢复）。
 * - 不存在 → GrantNotFoundError。
 * - versionNo 不匹配 → GrantVersionConflictError（ETag 乐观锁）。
 */
export async function revokeGrant(
  tenantId: string,
  id: string,
  expectedVersionNo: number,
  revokeReasonCode?: string | null,
): Promise<V11Grant> {
  const [current] = await db
    .select()
    .from(v11Grant)
    .where(and(eq(v11Grant.tenantId, tenantId), eq(v11Grant.id, id)))
    .limit(1);
  if (!current) {
    throw new GrantNotFoundError(`Grant 不存在或跨租户不可见: ${id}`);
  }
  if (current.versionNo !== expectedVersionNo) {
    throw new GrantVersionConflictError(
      `Grant 版本冲突：期望 ${expectedVersionNo}，实际 ${current.versionNo}`,
      expectedVersionNo,
      current.versionNo,
    );
  }
  if (GRANT_TERMINAL_STATES.includes(current.grantState)) {
    throw new GrantStateError(`Grant 已处于终态 ${current.grantState}，不可撤销（不可恢复）`);
  }

  const now = new Date();
  await db
    .update(v11Grant)
    .set({
      grantState: "revoked",
      revokedAt: now,
      revokeReasonCode: revokeReasonCode ?? null,
      versionNo: current.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(v11Grant.id, id));

  const [updated] = await db.select().from(v11Grant).where(eq(v11Grant.id, id)).limit(1);
  if (!updated) {
    throw new GrantNotFoundError(`Grant 撤销后回查失败: ${id}`);
  }
  return updated;
}

/**
 * 批量标记过期 Grant（active → expired）。
 *
 * 扫描条件：grantState=active AND expiresAt < now AND expiresAt IS NOT NULL。
 *
 * @returns 标记过期的 Grant 数量
 */
export async function markExpiredGrants(now: Date = new Date()): Promise<number> {
  const result = await db
    .update(v11Grant)
    .set({
      grantState: "expired",
      versionNo: sql`${v11Grant.versionNo} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(v11Grant.grantState, "active"),
        lt(v11Grant.expiresAt, now),
        isNull(v11Grant.revokedAt),
      ),
    );
  return result[0]?.affectedRows ?? 0;
}

/**
 * 查询 ToolCall 当前生效的 Grant。
 *
 * 规则（§6.8 + §5.5）：
 * - 通过 userId + tenantId 查询用户的所有 active Grant。
 * - 筛选 scope 覆盖 requiredScopes 的 Grant。
 * - 筛选未过期（expiresAt=null 或 expiresAt > now）的 Grant。
 * - 返回第一个匹配的 Grant；若无匹配返回 null（调用方据此决定是否触发 UserActionRequest）。
 *
 * @param tenantId 租户 id
 * @param userId 用户 id
 * @param requiredScopes ToolCall 所需 scope 列表
 * @param now 当前时间（默认 new Date()）
 */
export async function getEffectiveGrantForToolCall(
  tenantId: string,
  userId: string,
  requiredScopes: readonly string[],
  now: Date = new Date(),
): Promise<V11Grant | null> {
  const grants = await db
    .select()
    .from(v11Grant)
    .where(
      and(
        eq(v11Grant.tenantId, tenantId),
        eq(v11Grant.userId, userId),
        eq(v11Grant.grantState, "active"),
        isNull(v11Grant.revokedAt),
      ),
    )
    .orderBy(desc(v11Grant.issuedAt));

  for (const grant of grants) {
    // 过期检查（expiresAt=null 表示永不过期）
    if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) continue;
    // scope 覆盖检查
    const grantedScopes = (grant.scopeJson as string[]) ?? [];
    if (isScopeCoveredBy(requiredScopes, grantedScopes)) {
      return grant;
    }
  }
  return null;
}

// ─── 内部辅助 ──────────────────────────────────────────────

/**
 * 列出某租户内已过期但未标记的 Grant（诊断用途）。
 */
export async function listStaleExpiredGrants(
  tenantId: string,
  now: Date = new Date(),
): Promise<V11Grant[]> {
  return db
    .select()
    .from(v11Grant)
    .where(
      and(
        eq(v11Grant.tenantId, tenantId),
        eq(v11Grant.grantState, "active"),
        lt(v11Grant.expiresAt, now),
        isNull(v11Grant.revokedAt),
      ),
    )
    .orderBy(asc(v11Grant.expiresAt));
}

/**
 * 删除所有未引用的 non-active Grant（清理用途，谨慎调用）。
 * 仅删除 grantState in (revoked, expired) 的行。
 */
export async function purgeTerminalGrants(tenantId: string): Promise<number> {
  const result = await db
    .delete(v11Grant)
    .where(
      and(
        eq(v11Grant.tenantId, tenantId),
        inArray(v11Grant.grantState, [...GRANT_TERMINAL_STATES]),
      ),
    );
  return result[0]?.affectedRows ?? 0;
}

// ─── re-export 用于 drizzle 类型推导 ───────────────────────
// 防止 ne / isNull 等 drizzle operator 未使用告警。
export { ne as _ne, isNull as _isNull };
