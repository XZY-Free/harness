import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  EnvironmentComplianceError,
  EnvironmentLeaseConflictError,
  EnvironmentLeaseStateError,
} from "@/lib/environment/environment-errors";
import { capabilitiesMeet, unmetCapabilities } from "@/lib/environment/environment-instance-spec";
import {
  type EnvironmentPreparedEvidence,
  assertEnvironmentPreparedEvidence,
  assertLeasePreparedEvidence,
  environmentPreparedEvidenceDigest,
} from "@/lib/environment/environment-prepared-evidence";
import {
  ENVIRONMENT_LEASE_TERMINAL_STATES,
  type EnvironmentLease,
  type EnvironmentLeaseState,
  environmentLeaseTable,
} from "@/lib/persistence/schema/environment";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

export {
  EnvironmentComplianceError,
  EnvironmentInstanceOperationError,
  EnvironmentLeaseConflictError,
  EnvironmentLeaseStateError,
} from "@/lib/environment/environment-errors";

/** Prepared→ready 的清理重试退避（毫秒），按 cleanupCount 指数增长，上限 5 分钟。 */
export const ENVIRONMENT_CLEANUP_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** 清理工作租约时长（毫秒）：超出即视为该 Worker 已死，允许他人重新认领。 */
export const ENVIRONMENT_CLEANUP_LEASE_MS = 60_000 as const;

function cleanupBackoffMs(cleanupCount: number): number {
  const index = Math.min(Math.max(cleanupCount, 0), ENVIRONMENT_CLEANUP_BACKOFF_MS.length - 1);
  return ENVIRONMENT_CLEANUP_BACKOFF_MS[index] ?? 300_000;
}

/**
 * Lease 是否已进入终态。
 *
 * 列类型在 drizzle 里是普通字符串，这里显式收窄到枚举再做成员判断，
 * 避免 `Array.includes` 的联合类型拒绝。
 */
function isTerminalLeaseState(state: string): boolean {
  return ENVIRONMENT_LEASE_TERMINAL_STATES.includes(state as EnvironmentLeaseState);
}

export interface CreateEnvironmentLeaseInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  environmentDefinitionRevisionId: string;
  deviceId?: string | null;
  workerRef?: string | null;
  hostIdentity?: string | null;
  storageIdentity?: string | null;
  capabilitiesJson?: unknown;
  resourceManifest?: unknown;
  expiresAt?: Date;
}

export async function createEnvironmentLease(
  input: CreateEnvironmentLeaseInput,
  executor: DbOrTx = db,
): Promise<EnvironmentLease> {
  const [revision] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
        eq(environmentDefinitionRevisionTable.id, input.environmentDefinitionRevisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new EnvironmentLeaseConflictError("EnvironmentRevision 不存在或租户不匹配");
  const id = randomUUID();
  const now = new Date();
  await executor.insert(environmentLeaseTable).values({
    id,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    environmentDefinitionRevisionId: input.environmentDefinitionRevisionId,
    deviceId: input.deviceId ?? null,
    workerRef: input.workerRef ?? null,
    hostIdentity: input.hostIdentity ?? null,
    storageIdentity: input.storageIdentity ?? null,
    leaseState: "allocated",
    readinessState: "unresolved",
    capabilitiesJson: input.capabilitiesJson ?? null,
    complianceEvidence: null,
    complianceDigest: null,
    preparedEvidence: null,
    preparedDigest: null,
    preparedAt: null,
    activationOwnershipId: null,
    resourceManifest: input.resourceManifest ?? {},
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    nextCleanupAt: null,
    cleanupCount: 0,
    lastErrorCode: null,
    allocatedAt: now,
    lastHeartbeatAt: null,
    expiresAt: input.expiresAt ?? new Date(now.getTime() + 90_000),
    releasedAt: null,
    versionNo: 1,
  });
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, id))
    .limit(1);
  if (!row) throw new EnvironmentLeaseConflictError("EnvironmentLease 创建后回查失败");
  return row;
}

/** Attempt 已有的非终态 Lease（同 Attempt Transport Retry 必须复用它）。 */
export async function findReusableEnvironmentLease(
  tenantId: string,
  invocationId: string,
  attemptId: string,
  executor: DbOrTx = db,
): Promise<EnvironmentLease | null> {
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.invocationId, invocationId),
        eq(environmentLeaseTable.attemptId, attemptId),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (isTerminalLeaseState(row.leaseState)) return null;
  return row;
}

export interface PrepareEnvironmentLeaseInput {
  tenantId: string;
  leaseId: string;
  capabilitiesJson: unknown;
  /**
   * 实际实例符合性证据。**必填**——生产写入不允许 `evidence ?? {verified:true}` 默认成功。
   */
  evidence: EnvironmentPreparedEvidence;
  /** 复核上下文（与 Lease 冻结论证比对）。 */
  now?: Date;
}

/**
 * 实例已真实建立并核验通过 → Lease 进入 `prepared`。
 *
 * 注意语义边界（repairs/06-environment.md §4）：`prepared` 只说明**实例准备好**，
 * 不代表 Writer 已激活。`readinessState=ready` 与 `activationOwnershipId` 只能在
 * 当前 Ownership 事务内、Workspace Writer 激活之后写（见 activateEnvironmentLease）。
 */
export async function prepareEnvironmentLease(
  input: PrepareEnvironmentLeaseInput,
  executor: DbOrTx = db,
): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  const [lease] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .limit(1);
  if (!lease) throw new EnvironmentLeaseConflictError(input.leaseId);
  if (!["unresolved", "preparing"].includes(lease.readinessState)) {
    throw new EnvironmentLeaseStateError(
      `EnvironmentLease 未处于可准备状态：${lease.readinessState}`,
    );
  }
  if (!["allocated", "active"].includes(lease.leaseState)) {
    throw new EnvironmentLeaseStateError(`EnvironmentLease 已非活跃：${lease.leaseState}`);
  }
  if (!input.evidence) {
    throw new EnvironmentComplianceError("生产写入必须提供实际实例符合性证据（PreparedEvidence）");
  }
  // Revision 查询严格限定 tenant（跨租户引用必须失败，不能只按 id）。
  const [revision] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
        eq(environmentDefinitionRevisionTable.id, lease.environmentDefinitionRevisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new EnvironmentComplianceError("EnvironmentLease 引用的 Revision 不存在");
  // 实际能力必须覆盖 Revision 的 requiredCapabilities。
  if (!capabilitiesMeet(revision.requiredCapabilities, input.capabilitiesJson)) {
    const unmet = unmetCapabilities(revision.requiredCapabilities, input.capabilitiesJson);
    throw new EnvironmentComplianceError(
      `实际实例不满足 EnvironmentRevision requiredCapabilities：${unmet.join(", ") || "unknown"}`,
    );
  }
  // §5：资源创建前必须先登记稳定的 operation/manifest 归属。没有登记就没有可核对的
  // Workspace/恢复水位事实，此时写入 Prepared 证据等于给"无归属实例"发通过 —— 显式拒绝，
  // 而不是退化成空串后报一个含义模糊的"属于其他 WorkspaceBinding"。
  const manifest = lease.resourceManifest as {
    workspaceBindingId?: unknown;
    recoveryAnchorDigest?: unknown;
  } | null;
  if (
    typeof manifest?.workspaceBindingId !== "string" ||
    manifest.workspaceBindingId.length === 0
  ) {
    throw new EnvironmentComplianceError(
      "EnvironmentLease 未登记 operation/manifest 归属（缺少 workspaceBindingId），拒绝写入 Prepared 证据",
    );
  }
  const workspaceBindingId = manifest.workspaceBindingId;
  // 证据必须与本 Lease / Attempt / Revision / Workspace / 恢复水位逐项自洽。
  const evidence = assertEnvironmentPreparedEvidence(input.evidence, {
    revisionId: revision.id,
    semanticDigest: revision.semanticDigest,
    attemptId: lease.attemptId,
    workspaceBindingId,
    recoveryAnchorDigest:
      typeof manifest.recoveryAnchorDigest === "string" ? manifest.recoveryAnchorDigest : null,
    now,
  });
  const digest = environmentPreparedEvidenceDigest(evidence);
  await executor
    .update(environmentLeaseTable)
    .set({
      capabilitiesJson: input.capabilitiesJson,
      complianceEvidence: evidence,
      complianceDigest: digest,
      preparedEvidence: evidence,
      preparedDigest: digest,
      preparedAt: now,
      readinessState: "prepared",
      workerRef: evidence.instance.workerRef,
      hostIdentity: evidence.instance.hostIdentity,
      storageIdentity: evidence.instance.storageIdentity,
      deviceId: evidence.instance.deviceId,
      resourceManifest: {
        ...(lease.resourceManifest as Record<string, unknown> | null),
        ...evidence.resourceManifest,
        operationId: evidence.resourceManifest.operationId,
      },
      updatedAt: now,
      versionNo: lease.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, lease.id));
  const [updated] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseConflictError(input.leaseId);
  return updated;
}

export interface ActivateEnvironmentLeaseInput {
  tenantId: string;
  leaseId: string;
  ownershipId: string;
  /** Current Ownership 事务内的复核上下文。 */
  attemptId: string;
  invocationId: string;
  environmentDefinitionRevisionId: string;
  recoveryAnchorDigest?: string | null;
  now?: Date;
}

/**
 * Writer 激活之后的 Lease 交接：只能在 Current Ownership 事务内调用。
 *
 * 复核（repairs/06-environment.md §4，ENV-04）：
 * - Lease 确属本 Invocation/Attempt/Revision/Binding/恢复水位；
 * - `prepared` 证据未过期（Prepared ≤60s）；
 * - Lease 未被释放/丢失（不能靠调用方先前读到的 row 绕过）；
 * - prepared → ready 时才写 `activationOwnershipId`（形状约束由 DB CHECK 兜底）。
 */
export async function activateEnvironmentLease(
  input: ActivateEnvironmentLeaseInput,
  executor: DbOrTx = db,
): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  const [lease] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) throw new EnvironmentLeaseStateError("EnvironmentLease 不存在");
  if (
    lease.readinessState === "ready" &&
    lease.leaseState === "active" &&
    lease.activationOwnershipId === input.ownershipId
  ) {
    return lease;
  }
  if (!["allocated", "active"].includes(lease.leaseState)) {
    throw new EnvironmentLeaseStateError(`EnvironmentLease 已非活跃：${lease.leaseState}`);
  }
  if (lease.readinessState !== "prepared") {
    throw new EnvironmentLeaseStateError("EnvironmentLease 未 Prepared");
  }
  if (lease.invocationId !== input.invocationId) {
    throw new EnvironmentComplianceError("EnvironmentLease 属于其他 Invocation");
  }
  if (lease.attemptId !== input.attemptId) {
    throw new EnvironmentComplianceError("EnvironmentLease 属于其他 Attempt");
  }
  if (lease.environmentDefinitionRevisionId !== input.environmentDefinitionRevisionId) {
    throw new EnvironmentComplianceError("EnvironmentLease 引用其他 EnvironmentRevision");
  }
  const manifest = (lease.resourceManifest ?? {}) as Record<string, unknown>;
  if (typeof manifest.workspaceBindingId !== "string") {
    throw new EnvironmentComplianceError("EnvironmentLease 未关联 WorkspaceBinding");
  }
  const [revision] = await executor
    .select()
    .from(environmentDefinitionRevisionTable)
    .where(
      and(
        eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
        eq(environmentDefinitionRevisionTable.id, lease.environmentDefinitionRevisionId),
      ),
    )
    .limit(1);
  if (!revision) throw new EnvironmentComplianceError("EnvironmentLease 引用的 Revision 不存在");
  assertLeasePreparedEvidence({
    preparedEvidence: lease.preparedEvidence,
    preparedDigest: lease.preparedDigest,
    revisionId: revision.id,
    semanticDigest: revision.semanticDigest,
    attemptId: input.attemptId,
    workspaceBindingId: manifest.workspaceBindingId,
    recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
    now,
  });
  await executor
    .update(environmentLeaseTable)
    .set({
      leaseState: "active",
      readinessState: "ready",
      activationOwnershipId: input.ownershipId,
      lastHeartbeatAt: now,
      versionNo: lease.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(environmentLeaseTable.id, lease.id));
  const [updated] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseStateError(input.leaseId);
  return updated;
}

export async function getEnvironmentLeaseById(tenantId: string, id: string, executor: DbOrTx = db) {
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(and(eq(environmentLeaseTable.tenantId, tenantId), eq(environmentLeaseTable.id, id)))
    .limit(1);
  return row ?? null;
}
export async function getEnvironmentLeaseByAttempt(
  tenantId: string,
  invocationId: string,
  attemptId: string,
  executor: DbOrTx = db,
) {
  const [row] = await executor
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.invocationId, invocationId),
        eq(environmentLeaseTable.attemptId, attemptId),
      ),
    )
    .limit(1);
  return row ?? null;
}
export async function listEnvironmentLeasesByInvocation(tenantId: string, invocationId: string) {
  return db
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.invocationId, invocationId),
      ),
    )
    .orderBy(desc(environmentLeaseTable.createdAt));
}
export async function heartbeatEnvironmentLease(tenantId: string, id: string) {
  const current = await getEnvironmentLeaseById(tenantId, id);
  if (!current || !["allocated", "active"].includes(current.leaseState))
    throw new EnvironmentLeaseStateError(id);
  await db
    .update(environmentLeaseTable)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date(), versionNo: current.versionNo + 1 })
    .where(eq(environmentLeaseTable.id, id));
  return getEnvironmentLeaseById(tenantId, id);
}

/**
 * 直接释放（只用于"确定没有真实资源"的场景，如 NO_PLATFORM_ENVIRONMENT 或测试）。
 *
 * 有真实资源的路径必须走 `scheduleEnvironmentLeaseCleanup` + 清理 Worker：
 * 控制面 `released` 必须对应真实资源释放回执，不能先写 released 再吞掉 Backend 错误。
 */
export async function releaseEnvironmentLease(
  tenantId: string,
  id: string,
  state: Extract<EnvironmentLeaseState, "released" | "expired" | "lost"> = "released",
  executor: DbOrTx = db,
) {
  const current = await getEnvironmentLeaseById(tenantId, id, executor);
  if (!current) return null;
  if (current.leaseState === state) return current;
  const now = new Date();
  await executor
    .update(environmentLeaseTable)
    .set({
      leaseState: state,
      readinessState: "blocked",
      activationOwnershipId: null,
      releasedAt: now,
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, id));
  return getEnvironmentLeaseById(tenantId, id, executor);
}

// ─── 持久清理工作（repairs/06-environment.md §5）─────────────

/**
 * 登记持久清理工作：provision/prepared/activation 失败、Owner 丢失、Invocation terminal
 * 都走这里。Lease 进入 `releasing`（非终态）并携带重试信息，由清理 Worker 真实释放。
 *
 * `immediate: true` → `nextCleanupAt = now`：适用于"失败当下就要尝试一次真实清理"的
 * 调用点（provision 失败、activation 失败）。持久重试仍由 `recordEnvironmentLeaseCleanupFailure`
 * 按退避推进。
 */
export async function scheduleEnvironmentLeaseCleanup(
  input: {
    tenantId: string;
    leaseId: string;
    errorCode: string;
    now?: Date;
    /** 立即到期（第一次清理就在本次调用中尝试）。 */
    immediate?: boolean;
    /** 补充到 resourceManifest 的资源事实（例如已创建但未完成的资源）。 */
    resourceManifestPatch?: Record<string, unknown>;
  },
  executor: DbOrTx = db,
): Promise<EnvironmentLease | null> {
  const now = input.now ?? new Date();
  const current = await getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
  if (!current) return null;
  if (isTerminalLeaseState(current.leaseState)) return current;
  await executor
    .update(environmentLeaseTable)
    .set({
      leaseState: "releasing",
      readinessState: "blocked",
      activationOwnershipId: null,
      lastErrorCode: input.errorCode.slice(0, 64),
      nextCleanupAt: input.immediate
        ? now
        : new Date(now.getTime() + cleanupBackoffMs(current.cleanupCount)),
      cleanupLeaseOwner: null,
      cleanupLeaseExpiresAt: null,
      resourceManifest: input.resourceManifestPatch
        ? {
            ...((current.resourceManifest as Record<string, unknown>) ?? {}),
            ...input.resourceManifestPatch,
          }
        : current.resourceManifest,
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, current.id));
  return getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
}

/** 需要清理且已到重试时间的 Lease（Worker 扫描入口）。 */
export async function listEnvironmentLeasesDueForCleanup(input?: {
  now?: Date;
  limit?: number;
}): Promise<EnvironmentLease[]> {
  const now = input?.now ?? new Date();
  return db
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.leaseState, "releasing"),
        or(
          isNull(environmentLeaseTable.nextCleanupAt),
          lte(environmentLeaseTable.nextCleanupAt, now),
        ),
        or(
          isNull(environmentLeaseTable.cleanupLeaseExpiresAt),
          lte(environmentLeaseTable.cleanupLeaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(asc(environmentLeaseTable.nextCleanupAt))
    .limit(input?.limit ?? 50);
}

/** 认领清理工作（条件 UPDATE，保证多 Worker 不重复清理同一 Lease）。 */
export async function claimEnvironmentLeaseCleanup(input: {
  tenantId: string;
  leaseId: string;
  owner: string;
  now?: Date;
  leaseMs?: number;
}): Promise<EnvironmentLease | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? ENVIRONMENT_CLEANUP_LEASE_MS;
  const [lease] = await db
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease || lease.leaseState !== "releasing") return null;
  if (lease.cleanupLeaseExpiresAt && lease.cleanupLeaseExpiresAt > now) return null;
  if (lease.nextCleanupAt && lease.nextCleanupAt > now) return null;
  await db
    .update(environmentLeaseTable)
    .set({
      cleanupLeaseOwner: input.owner,
      cleanupLeaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
      versionNo: lease.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, lease.id));
  return getEnvironmentLeaseById(input.tenantId, input.leaseId);
}

/** 真实释放成功 → 控制面 `released`（此时才允许写终态）。 */
export async function completeEnvironmentLeaseCleanup(
  input: { tenantId: string; leaseId: string; releasedAt?: Date },
  executor: DbOrTx = db,
): Promise<EnvironmentLease | null> {
  const now = input.releasedAt ?? new Date();
  const current = await getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
  if (!current) return null;
  await executor
    .update(environmentLeaseTable)
    .set({
      leaseState: "released",
      readinessState: "blocked",
      activationOwnershipId: null,
      releasedAt: now,
      cleanupLeaseOwner: null,
      cleanupLeaseExpiresAt: null,
      nextCleanupAt: null,
      cleanupCount: current.cleanupCount + 1,
      lastErrorCode: null,
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, current.id));
  return getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
}

/** 真实释放失败 → 记录错误 + 退避重试（保持 `releasing`，绝不写 released）。 */
export async function recordEnvironmentLeaseCleanupFailure(
  input: { tenantId: string; leaseId: string; errorCode: string; now?: Date },
  executor: DbOrTx = db,
): Promise<EnvironmentLease | null> {
  const now = input.now ?? new Date();
  const current = await getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
  if (!current) return null;
  if (isTerminalLeaseState(current.leaseState)) return current;
  const cleanupCount = current.cleanupCount + 1;
  await executor
    .update(environmentLeaseTable)
    .set({
      leaseState: "releasing",
      readinessState: "blocked",
      cleanupLeaseOwner: null,
      cleanupLeaseExpiresAt: null,
      cleanupCount,
      lastErrorCode: input.errorCode.slice(0, 64),
      nextCleanupAt: new Date(now.getTime() + cleanupBackoffMs(cleanupCount - 1)),
      updatedAt: now,
      versionNo: current.versionNo + 1,
    })
    .where(eq(environmentLeaseTable.id, current.id));
  return getEnvironmentLeaseById(input.tenantId, input.leaseId, executor);
}

/** 按 id 集合统计非终态 Lease 数（诊断）。 */
export async function countActiveEnvironmentLeases(tenantId: string, leaseIds: string[]) {
  if (leaseIds.length === 0) return 0;
  const rows = await db
    .select({ id: environmentLeaseTable.id })
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        inArray(environmentLeaseTable.id, leaseIds),
        eq(environmentLeaseTable.leaseState, "active"),
      ),
    );
  return rows.length;
}
