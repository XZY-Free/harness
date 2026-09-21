import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import {
  EnvironmentComplianceError,
  EnvironmentLeaseConflictError,
  EnvironmentLeaseStateError,
  EnvironmentPreparationClaimSupersededError,
} from "@/lib/environment/environment-errors";
import { capabilitiesMeet, unmetCapabilities } from "@/lib/environment/environment-instance-spec";
import {
  type EnvironmentPreparedEvidence,
  assertEnvironmentPreparedEvidence,
  assertLeasePreparedEvidence,
  environmentPreparedEvidenceDigest,
} from "@/lib/environment/environment-prepared-evidence";
import {
  type AttemptPreparationClaim,
  assertAttemptPreparationClaimHeldInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { lockInvocationRootIfExists } from "@/lib/executions/persistence/execution-ownership-store";
import {
  ENVIRONMENT_LEASE_TERMINAL_STATES,
  type EnvironmentLease,
  type EnvironmentLeaseState,
  environmentLeaseTable,
} from "@/lib/persistence/schema/environment";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import { InvocationAttemptStateConflictError } from "@/lib/runtime/errors";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

export {
  EnvironmentComplianceError,
  EnvironmentInstanceOperationError,
  EnvironmentLeaseConflictError,
  EnvironmentLeaseStateError,
  EnvironmentPreparationClaimSupersededError,
} from "@/lib/environment/environment-errors";

/** Prepared→ready 的清理重试退避（毫秒），按 cleanupCount 指数增长，上限 5 分钟。 */
export const ENVIRONMENT_CLEANUP_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** 清理工作租约时长（毫秒）：超出即视为该 Worker 已死，允许他人重新认领。 */
export const ENVIRONMENT_CLEANUP_LEASE_MS = 60_000 as const;
/**
 * A01-03：本模块所有**多语句**操作的强制事务类型。
 *
 * Lease 的生命周期操作（创建、准备、激活、重新准备、释放、清理登记）都不是单条语句：
 * 它们要"先锁行读当前版本 → 条件判定 → 条件写 → 回读"。若这些语句各自落在全局 `db` 上，
 * 每一条都是独立 autocommit 事务，行锁在第一条语句结束时即释放 —— 版本 CAS、状态转换表、
 * 证据自洽校验都会退化成"读了再写"的竞态窗口。
 *
 * 因此这里区分两类 API：
 * - `xxxInTransaction(tx, input)`：真实事务内部方法，参数类型即事务类型，不接受全局 `db`；
 * - `xxx(input)`：公共入口，自己开启事务后调用前者。
 */
export type LeaseTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

/** 只有这两种 readiness 才持有「本 Attempt 的实例已建好并通过核验」的 Prepared 证据。 */
const PREPARED_READINESS_STATES = ["prepared", "ready"] as const;

/**
 * Lease 是否已具备可复用的 Prepared 事实。
 *
 * `ready` 不是"另一种状态"，而是**同一份 Prepared 事实 + Workspace Writer 已激活**
 * （schema CHECK 要求 `ready` 必带 preparedEvidence/preparedDigest）。因此
 * "同 Attempt Transport Retry 复用既有实例"与"Resume 前复验既有实例"都必须接受两者：
 * - `prepareEnvironmentLease` 只接受 `unresolved` / `preparing`，对已备妥的 Lease 再次
 *   写入会 fail closed，一次合法的同 Attempt 重投会被判成终态失败；
 * - 复制一份 `prepared` 专用判断就会与 `revalidate` 的两状态判断分叉成两个版本。
 */
export function isPreparedReadinessState(state: string): boolean {
  return PREPARED_READINESS_STATES.includes(state as (typeof PREPARED_READINESS_STATES)[number]);
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

/** 公共入口：自开事务（Revision 校验 + INSERT + 回读必须原子）。 */
export async function createEnvironmentLease(
  input: CreateEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  return db.transaction((tx) => createEnvironmentLeaseInTransaction(tx, input));
}

/** 生产准备路径：来源 claim 复核与 Lease 建立处于同一 I → A → Lease 事务。 */
export async function createEnvironmentLeaseForPreparationClaim(
  input: CreateEnvironmentLeaseInput & { preparationClaim: AttemptPreparationClaim },
): Promise<EnvironmentLease> {
  return db.transaction(async (tx) => {
    if (
      !(await lockInvocationRootIfExists(
        tx,
        input.preparationClaim.tenantId,
        input.preparationClaim.invocationId,
      ))
    ) {
      throw new EnvironmentPreparationClaimSupersededError("准备 claim 的 Invocation 不存在");
    }
    await assertAttemptPreparationClaimHeldInTransaction(tx, input.preparationClaim);
    return createEnvironmentLeaseInTransaction(tx, input);
  });
}

export async function createEnvironmentLeaseInTransaction(
  tx: LeaseTx,
  input: CreateEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  const [revision] = await tx
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
  await tx.insert(environmentLeaseTable).values({
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
  const [row] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, id))
    .limit(1);
  if (!row) throw new EnvironmentLeaseConflictError("EnvironmentLease 创建后回查失败");
  return row;
}

/** Attempt 已有的非终态 Lease（同 Attempt Transport Retry 必须复用它）。单条 SELECT：纯读。 */
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
  /**
   * A05：本次完成所依据的准备 claim（只有 `reprepare` 路径提供）。
   *
   * 真实 IO 在事务外，回来时准备槽可能已经被另一个合法准备者接管。提供本字段时，
   * 写入 Prepared 证据前必须在**同一事务内**复核"我仍是当前准备者"；否则迟到的旧
   * 完成会覆盖新代际的证据（甚至把继任者的实例释放掉）。不提供即沿用既有行为
   * （首次准备、测试夹具）。
   */
  preparationClaim: AttemptPreparationClaim;
}

/**
 * 实例已真实建立并核验通过 → Lease 进入 `prepared`。
 *
 * 注意语义边界（repairs/06-environment.md §4）：`prepared` 只说明**实例准备好**，
 * 不代表 Writer 已激活。`readinessState=ready` 与 `activationOwnershipId` 只能在
 * 当前 Ownership 事务内、Workspace Writer 激活之后写（见 activateEnvironmentLease）。
 */
/** 公共入口：自开事务（状态复核 + Revision/能力核对 + 证据写入必须原子）。 */
export async function prepareEnvironmentLease(
  input: PrepareEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  return db.transaction(async (tx) => {
    if (
      !(await lockInvocationRootIfExists(
        tx,
        input.preparationClaim.tenantId,
        input.preparationClaim.invocationId,
      ))
    ) {
      throw new EnvironmentPreparationClaimSupersededError("准备 claim 的 Invocation 不存在");
    }
    return prepareEnvironmentLeaseInTransaction(tx, input);
  });
}

export async function prepareEnvironmentLeaseInTransaction(
  tx: LeaseTx,
  input: PrepareEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  // A05：IO 返回后的 claim CAS。必须先锁 Attempt（本模块锁序：Attempt → Lease），
  // 否则"读到自己是当前准备者"与"写入证据"之间会被接管事务插进来，迟到的旧完成
  // 就会盖掉继任者已经建立好的证据与激活。
  try {
    await assertAttemptPreparationClaimHeldInTransaction(tx, input.preparationClaim);
  } catch (error) {
    throw new EnvironmentPreparationClaimSupersededError(
      `准备 claim 已换手：旧完成不得提交 Prepared 证据（${String(error)}）`,
    );
  }
  const [lease] = await tx
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
  const [revision] = await tx
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
  await tx
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
  const [updated] = await tx
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
/**
 * 公共入口：自开事务。
 *
 * 生产路径**不应**走这里 —— Writer 激活必须在 Current Ownership 事务内与本函数同事务提交，
 * 因此 `runtime-start` 直接调用 `activateEnvironmentLeaseInTransaction(tx, input)`。
 * 本入口只服务"独立落库"的既有调用点（测试夹具与合规性用例）。
 */
export async function activateEnvironmentLease(
  input: ActivateEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  return db.transaction((tx) => activateEnvironmentLeaseInTransaction(tx, input));
}

export async function activateEnvironmentLeaseInTransaction(
  tx: LeaseTx,
  input: ActivateEnvironmentLeaseInput,
): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  const [lease] = await tx
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
  const [revision] = await tx
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
  await tx
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
  const [updated] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseStateError(input.leaseId);
  return updated;
}

/**
 * A05：把 Lease 交还到"可重新准备"的形状，并把恢复水位推进到**本次 Resume 的锚点**。
 *
 * 为什么必须有这一步（而不是"给调用方的 if 多加一个字符串"）：
 * - 暂停（`execution.suspended`）会把 Lease 打成 `readinessState=preparing` +
 *   `activationOwnershipId=null`，而 Resume 的 Start 事务内 `activateEnvironmentLease`
 *   只接受 `prepared`；
 * - Resume 使用**新的**恢复锚点（`recovery.anchorDigest`），而 `activateEnvironmentLease`
 *   要求 Prepared 证据的 `candidate.recoveryAnchorDigest` 与它逐字相等 —— 沿用 Start 时
 *   写入的旧证据必然以"恢复 Anchor 已变化，Prepared 证据失效"被拒。
 *
 * 语义边界：本函数只做**状态与水位**的交接（清掉上一代际的 Writer 激活、写入新水位），
 * 不产生任何符合性证据 —— 证据仍必须由 `reprepare` 真实回读实例后经
 * `prepareEnvironmentLease` 写入。实例此刻已不存在时，`backend.create` 会按稳定
 * operationId 幂等重建，而不是把"没有实例"自报成 prepared。
 */
/** 公共入口：自开事务（行锁读 + 条件写 + 回读必须原子，否则交接会被并发覆盖）。 */
export async function beginEnvironmentLeaseReprepare(input: {
  preparationClaim: AttemptPreparationClaim;
  leaseId: string;
  /** 本次 Resume 的恢复水位摘要；`null` 表示本次执行不从 Checkpoint/恢复水位承接。 */
  recoveryAnchorDigest?: string | null;
  now?: Date;
}): Promise<EnvironmentLease> {
  return db.transaction((tx) => beginEnvironmentLeaseReprepareInTransaction(tx, input));
}

export async function beginEnvironmentLeaseReprepareInTransaction(
  tx: LeaseTx,
  input: {
    preparationClaim: AttemptPreparationClaim;
    leaseId: string;
    recoveryAnchorDigest?: string | null;
    now?: Date;
  },
): Promise<EnvironmentLease> {
  const now = input.now ?? new Date();
  const attempt = await assertAttemptPreparationClaimHeldInTransaction(tx, input.preparationClaim);
  const tenantId = input.preparationClaim.tenantId;
  const [lease] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, tenantId),
        eq(environmentLeaseTable.id, input.leaseId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) throw new EnvironmentLeaseConflictError(input.leaseId);
  if (
    lease.invocationId !== input.preparationClaim.invocationId ||
    lease.attemptId !== attempt.id
  ) {
    throw new EnvironmentLeaseConflictError("EnvironmentLease 与准备领取不匹配");
  }
  if (attempt.preparationState === "prepared") {
    return lease;
  }
  if (!["allocated", "active"].includes(lease.leaseState)) {
    throw new EnvironmentLeaseStateError(`EnvironmentLease 已非活跃：${lease.leaseState}`);
  }
  const manifest = (lease.resourceManifest ?? {}) as Record<string, unknown>;
  // A01-03：交接必须是"锁内读到的版本"为条件的写（compare-and-set 语义），而不是仅按 id 的
  // 无条件 UPDATE。这里在**同一真实事务**里持 `FOR UPDATE` 行锁完成读 → 判定 → 写 → 回读；
  // 条件里的 `versionNo` 是显式断言：它一旦不等就说明本事务并未真正串行化该行
  // （行锁失效/被绕过），此时静默覆盖会把一次 Resume 绑定到错误的 `recoveryAnchorDigest`
  // 上，因此必须显式失败而不是继续。
  const nextVersionNo = lease.versionNo + 1;
  const [result] = await tx
    .update(environmentLeaseTable)
    .set({
      readinessState: "preparing",
      activationOwnershipId: null,
      resourceManifest: {
        ...manifest,
        recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
      },
      versionNo: nextVersionNo,
      updatedAt: now,
    })
    .where(
      and(
        eq(environmentLeaseTable.id, lease.id),
        eq(environmentLeaseTable.versionNo, lease.versionNo),
      ),
    );
  if ((result?.affectedRows ?? 0) !== 1) {
    throw new EnvironmentLeaseConflictError(
      `${input.leaseId}: 交接期间 EnvironmentLease 版本已被并发推进`,
    );
  }
  const [updated] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(eq(environmentLeaseTable.id, lease.id))
    .limit(1);
  if (!updated) throw new EnvironmentLeaseConflictError(input.leaseId);
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
/**
 * Lease 心跳续期（独立落库入口，无事务调用方）。
 *
 * A01-03：读状态 + 条件写 + 回读在一个真实事务里完成；写以锁内读到的 `versionNo` 为条件，
 * 该条件是对「本事务确实串行化了该行」的断言（并发心跳/激活不得互相覆盖版本与心跳时间）。
 */
export async function heartbeatEnvironmentLease(tenantId: string, id: string) {
  return db.transaction((tx) => heartbeatEnvironmentLeaseInTransaction(tx, tenantId, id));
}

export async function heartbeatEnvironmentLeaseInTransaction(
  tx: LeaseTx,
  tenantId: string,
  id: string,
) {
  const [current] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(and(eq(environmentLeaseTable.tenantId, tenantId), eq(environmentLeaseTable.id, id)))
    .for("update")
    .limit(1);
  if (!current || !["allocated", "active"].includes(current.leaseState))
    throw new EnvironmentLeaseStateError(id);
  const now = new Date();
  const [result] = await tx
    .update(environmentLeaseTable)
    .set({ lastHeartbeatAt: now, updatedAt: now, versionNo: current.versionNo + 1 })
    .where(
      and(eq(environmentLeaseTable.id, id), eq(environmentLeaseTable.versionNo, current.versionNo)),
    );
  if ((result?.affectedRows ?? 0) !== 1) throw new EnvironmentLeaseConflictError(id);
  return getEnvironmentLeaseById(tenantId, id, tx);
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
): Promise<EnvironmentLease | null> {
  return db.transaction((tx) => releaseEnvironmentLeaseInTransaction(tx, tenantId, id, state));
}

export async function releaseEnvironmentLeaseInTransaction(
  tx: LeaseTx,
  tenantId: string,
  id: string,
  state: Extract<EnvironmentLeaseState, "released" | "expired" | "lost"> = "released",
): Promise<EnvironmentLease | null> {
  const current = await getEnvironmentLeaseById(tenantId, id, tx);
  if (!current) return null;
  if (current.leaseState === state) return current;
  const now = new Date();
  const nextVersionNo = current.versionNo + 1;
  const [result] = await tx
    .update(environmentLeaseTable)
    .set({
      leaseState: state,
      readinessState: "blocked",
      activationOwnershipId: null,
      releasedAt: now,
      updatedAt: now,
      versionNo: nextVersionNo,
    })
    .where(
      and(eq(environmentLeaseTable.id, id), eq(environmentLeaseTable.versionNo, current.versionNo)),
    );
  if ((result?.affectedRows ?? 0) !== 1) throw new EnvironmentLeaseConflictError(id);
  return getEnvironmentLeaseById(tenantId, id, tx);
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
export interface ScheduleEnvironmentLeaseCleanupInput {
  tenantId: string;
  leaseId: string;
  errorCode: string;
  now?: Date;
  /** 立即到期（第一次清理就在本次调用中尝试）。 */
  immediate?: boolean;
  /** 补充到 resourceManifest 的资源事实（例如已创建但未完成的资源）。 */
  resourceManifestPatch?: Record<string, unknown>;
}

/** 公共入口：自开事务（状态判定 + 条件写 + 回读必须原子）。 */
export async function scheduleEnvironmentLeaseCleanup(
  input: ScheduleEnvironmentLeaseCleanupInput,
): Promise<EnvironmentLease | null> {
  return db.transaction((tx) => scheduleEnvironmentLeaseCleanupInTransaction(tx, input));
}

export async function scheduleEnvironmentLeaseCleanupInTransaction(
  tx: LeaseTx,
  input: ScheduleEnvironmentLeaseCleanupInput,
): Promise<EnvironmentLease | null> {
  const now = input.now ?? new Date();
  const current = await getEnvironmentLeaseById(input.tenantId, input.leaseId, tx);
  if (!current) return null;
  // A08 8.1：只有 `released` 是"真实资源已释放"的事实。
  //
  // `lost` / `expired` 只是**逻辑**收口（失权、超时），它们仍可能指向真实运行中的容器。
  // 把它们一并当作"已释放"提前返回，正是审查报告指出的"逻辑收口不等于实际资源释放"：
  // 任一出口只要先写了 `lost`，该 Lease 就再也进不了 `releasing` 扫描，真实资源永久泄漏。
  // 因此这里只对 `released` 幂等短路，其余状态一律登记（或保持）持久清理工作。
  if (current.leaseState === "released") return current;
  await tx
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
  return getEnvironmentLeaseById(input.tenantId, input.leaseId, tx);
}

/**
 * 资源准备失败的清理登记：准备 claim 核对与 Lease→releasing 写入在同一事务。
 * 迟到工作只得到 not_claimed，不能仅凭共享 leaseId 清理继任者正在使用的实例。
 */
export async function scheduleEnvironmentLeaseCleanupForPreparationClaim(input: {
  claim: AttemptPreparationClaim;
  leaseId: string;
  errorCode: string;
  now?: Date;
  resourceManifestPatch?: Record<string, unknown>;
}): Promise<{ outcome: "scheduled" | "not_claimed"; lease: EnvironmentLease | null }> {
  try {
    return await db.transaction(async (tx) => {
      await assertAttemptPreparationClaimHeldInTransaction(tx, input.claim);
      const lease = await scheduleEnvironmentLeaseCleanupInTransaction(tx, {
        tenantId: input.claim.tenantId,
        leaseId: input.leaseId,
        errorCode: input.errorCode,
        immediate: true,
        ...(input.now ? { now: input.now } : {}),
        ...(input.resourceManifestPatch
          ? { resourceManifestPatch: input.resourceManifestPatch }
          : {}),
      });
      return { outcome: "scheduled" as const, lease };
    });
  } catch (error) {
    if (
      error instanceof InvocationAttemptStateConflictError &&
      error.attemptedAction === "PreparationClaimSuperseded"
    ) {
      return {
        outcome: "not_claimed",
        lease: await getEnvironmentLeaseById(input.claim.tenantId, input.leaseId),
      };
    }
    throw error;
  }
}

/**
 * A08 8.1：**正式生命周期出口**登记真实清理工作。
 *
 * 出口（Invocation 终态、Owner 失权/接管）只决定"这个 Attempt 的实例不该继续存在"，
 * 它**不能**同时声明"实例已经不存在"——审查报告的判据是：不把"已失权"写成"物理已释放"。
 * 因此出口统一走这里：把 Lease 推进到非终态的 `releasing`，把真实释放留给清理 Worker
 * 经 Backend 回执确认后才写 `released`。
 *
 * 用 Attempt 定位 Lease（而不是靠 `activationOwnershipId`）：`prepared` 但尚未激活的
 * Lease 同样可能已经建好了真实容器，靠激活指针会漏掉它。
 */
export interface RegisterEnvironmentLeaseCleanupForAttemptInput {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  errorCode: string;
  now?: Date;
}

/** 公共入口：自开事务（按 Attempt 定位 + 登记清理必须原子）。 */
export async function registerEnvironmentLeaseCleanupForAttempt(
  input: RegisterEnvironmentLeaseCleanupForAttemptInput,
): Promise<EnvironmentLease | null> {
  return db.transaction((tx) => registerEnvironmentLeaseCleanupForAttemptInTransaction(tx, input));
}

export async function registerEnvironmentLeaseCleanupForAttemptInTransaction(
  tx: LeaseTx,
  input: RegisterEnvironmentLeaseCleanupForAttemptInput,
): Promise<EnvironmentLease | null> {
  const [lease] = await tx
    .select()
    .from(environmentLeaseTable)
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.tenantId),
        eq(environmentLeaseTable.invocationId, input.invocationId),
        eq(environmentLeaseTable.attemptId, input.attemptId),
      ),
    )
    .for("update")
    .limit(1);
  if (!lease) return null;
  return scheduleEnvironmentLeaseCleanupInTransaction(tx, {
    tenantId: input.tenantId,
    leaseId: lease.id,
    errorCode: input.errorCode,
    immediate: true,
    ...(input.now ? { now: input.now } : {}),
  });
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

/**
 * A08 8.2：清理工作的**领取令牌**。
 *
 * 审查报告指出：此前是"全局 db 的 `SELECT … FOR UPDATE`"+"另一个全局 `db.update` 仅按 id 更新"，
 * 两条独立语句各属一个 autocommit 事务，行锁在第一条结束时就释放了 —— 于是两个 Worker
 * 可以都读到"可领取"并都继续执行，完成/失败回写也不带任何本轮身份，旧执行者能覆盖
 * 新领取者的结论。这里把领取收敛为**一个事务内的一次条件 UPDATE**，并把该次写入的
 * `versionNo` 作为令牌本体：后续每一步写入都必须逐字带回 `(owner, versionNo)`，
 * 迟到的旧执行者拿不到令牌，就无法把自己的结论写到别人的领取上。
 */
export interface EnvironmentLeaseCleanupClaim {
  tenantId: string;
  leaseId: string;
  owner: string;
  /** 领取当次写入的 `versionNo`（令牌本体）。 */
  claimVersionNo: number;
  /** 本次领取的到期时刻；超时后允许他人接管。 */
  leaseExpiresAt: Date;
}

/** 该 Lease 上的这一轮领取是否仍由该令牌持有。 */
function isCleanupClaimHeld(lease: EnvironmentLease, claim: EnvironmentLeaseCleanupClaim): boolean {
  return lease.cleanupLeaseOwner === claim.owner && lease.versionNo === claim.claimVersionNo;
}

/**
 * 认领清理工作：单事务内的条件 UPDATE。
 *
 * 条件必须在**同一条写入语句的同一事务内**复核（不能靠先前读到的 row，也不能靠
 * "前一条语句加过锁"）：`releasing` + 已到期 + 上一轮领取已失效。
 * 返回 `null` = "本轮不该由我处理"（不可领取 / 未到期 / 已被他人领取），
 * 调用方不得据此写任何结论。
 */
export async function claimEnvironmentLeaseCleanup(input: {
  tenantId: string;
  leaseId: string;
  owner: string;
  now?: Date;
  leaseMs?: number;
}): Promise<{ lease: EnvironmentLease; claim: EnvironmentLeaseCleanupClaim } | null> {
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? ENVIRONMENT_CLEANUP_LEASE_MS;
  return db.transaction(async (tx) => {
    const [lease] = await tx
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
    const claimVersionNo = lease.versionNo + 1;
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const [result] = await tx
      .update(environmentLeaseTable)
      .set({
        cleanupLeaseOwner: input.owner,
        cleanupLeaseExpiresAt: leaseExpiresAt,
        versionNo: claimVersionNo,
        updatedAt: now,
      })
      // CAS：锁内读到的版本必须仍是当前版本，否则说明本轮身份不是由我先写入的。
      .where(
        and(
          eq(environmentLeaseTable.id, lease.id),
          eq(environmentLeaseTable.versionNo, lease.versionNo),
        ),
      );
    if ((result?.affectedRows ?? 0) !== 1) return null;
    return {
      lease: {
        ...lease,
        cleanupLeaseOwner: input.owner,
        cleanupLeaseExpiresAt: leaseExpiresAt,
        versionNo: claimVersionNo,
      },
      claim: {
        tenantId: input.tenantId,
        leaseId: lease.id,
        owner: input.owner,
        claimVersionNo,
        leaseExpiresAt,
      },
    };
  });
}

/**
 * 真实释放成功 → 控制面 `released`（此时才允许写终态）。
 *
 * 必须携带本轮领取令牌：令牌不在（已被他人接管 / 领取早已过期而他人重领）时，
 * 返回 `not_claimed` 且**不写任何东西** —— 迟到的完成结论不得覆盖新领取者的结论。
 */
export async function completeEnvironmentLeaseCleanup(input: {
  claim: EnvironmentLeaseCleanupClaim;
  releasedAt?: Date;
}): Promise<{ outcome: "released" | "not_claimed"; lease: EnvironmentLease | null }> {
  const now = input.releasedAt ?? new Date();
  const [result] = await db
    .update(environmentLeaseTable)
    .set({
      leaseState: "released",
      readinessState: "blocked",
      activationOwnershipId: null,
      releasedAt: now,
      cleanupLeaseOwner: null,
      cleanupLeaseExpiresAt: null,
      nextCleanupAt: null,
      cleanupCount: sql`${environmentLeaseTable.cleanupCount} + 1`,
      lastErrorCode: null,
      updatedAt: now,
      versionNo: sql`${environmentLeaseTable.versionNo} + 1`,
    })
    .where(
      and(
        eq(environmentLeaseTable.tenantId, input.claim.tenantId),
        eq(environmentLeaseTable.id, input.claim.leaseId),
        eq(environmentLeaseTable.leaseState, "releasing"),
        eq(environmentLeaseTable.cleanupLeaseOwner, input.claim.owner),
        eq(environmentLeaseTable.versionNo, input.claim.claimVersionNo),
      ),
    );
  const lease = await getEnvironmentLeaseById(input.claim.tenantId, input.claim.leaseId);
  if ((result?.affectedRows ?? 0) !== 1) return { outcome: "not_claimed", lease };
  return { outcome: "released", lease };
}

/**
 * 真实释放失败 → 记录错误 + 退避重试（保持 `releasing`，绝不写 released）。
 *
 * 同样必须携带本轮领取令牌：令牌不在时返回 `not_claimed` 且不写 ——
 * 否则一个迟到失败的旧执行者会把新领取者刚设好的重试时机与错误码抹掉。
 */
export async function recordEnvironmentLeaseCleanupFailure(input: {
  claim: EnvironmentLeaseCleanupClaim;
  errorCode: string;
  now?: Date;
}): Promise<{ outcome: "scheduled" | "not_claimed"; lease: EnvironmentLease | null }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [lease] = await tx
      .select()
      .from(environmentLeaseTable)
      .where(
        and(
          eq(environmentLeaseTable.tenantId, input.claim.tenantId),
          eq(environmentLeaseTable.id, input.claim.leaseId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lease) return { outcome: "not_claimed" as const, lease: null };
    if (!isCleanupClaimHeld(lease, input.claim)) {
      return { outcome: "not_claimed" as const, lease };
    }
    if (lease.leaseState !== "releasing") return { outcome: "not_claimed" as const, lease };
    const cleanupCount = lease.cleanupCount + 1;
    const [result] = await tx
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
        versionNo: lease.versionNo + 1,
      })
      .where(
        and(
          eq(environmentLeaseTable.id, lease.id),
          eq(environmentLeaseTable.versionNo, lease.versionNo),
        ),
      );
    if ((result?.affectedRows ?? 0) !== 1) return { outcome: "not_claimed" as const, lease };
    return {
      outcome: "scheduled" as const,
      lease: await getEnvironmentLeaseById(input.claim.tenantId, input.claim.leaseId, tx),
    };
  });
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
