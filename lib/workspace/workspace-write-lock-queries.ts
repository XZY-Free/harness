/**
 * 物理 scope 的 Workspace Writer 协调槽（R04 §2/§3/§4）。
 *
 * 两个方向严格分开：
 *
 * - **W→I 路径**（`reserveWorkspaceWriter` → `activateWorkspaceWriter`）：先锁
 *   WorkspaceWriteLock（scope），再按 Invocation → Attempt → Ownership 复核 Current
 *   Ownership。父 Owner 是否仍然健康必须在 W 路径中真实查行，**不能**用 slot 上写入的
 *   `leaseExpiresAt` 推断。
 * - **I→W 禁止**：任何已持有 I 根锁的事务都不得触碰本表。I 侧只失效 Authority / 关闭
 *   Session，物理撤销由持久释放 lane（`workspace-writer-release.ts`）按 W→I 顺序完成。
 *
 * 释放工作的可见性来自持久状态本身，不依赖任何内存定时器：进程在写
 * `releaseNextAttemptAt` 之前 Crash，该行下一轮仍会被扫到。
 */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { isMysqlTransactionContentionError } from "@/lib/db/mysql-error";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  type WorkspaceWriteLock,
  type WorkspaceWriteLockState,
  workspaceWriteLock,
} from "@/lib/persistence/schema/workspace-lock";
import type { WorkspaceWriterIdentity } from "@/lib/workspace/workspace-host";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

export class WorkspaceWriterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceWriterNotFenced";
  }
}

export interface AcquireWorkspaceWriteLockParams {
  tenantId: string;
  storageScopeDigest: string;
  invocationId: string;
  attemptId: string;
  ownershipId: string;
  workspaceBindingId: string;
  leaseExpiresAt: Date;
  backendGrantRef?: string | null;
  backendEvidence?: unknown;
  /**
   * 稳定 Backend operationId：同一次逻辑激活的所有重试共用它。
   * 事务外 Backend 已成功但 DB 确认失败时，靠它查回既有回执而不是重复开 Writer。
   */
  backendOperationId?: string | null;
  /** Backend 实际回执（真实旧 Writer 停止/排空证据）。 */
  backendReceipt?: unknown;
}

function holderStates() {
  return inArray(workspaceWriteLock.lockState, ["reserved", "active"] as WorkspaceWriteLockState[]);
}

/**
 * 父 Owner 是否仍然健康（R04 §4）。
 *
 * 必须在 W 路径中调用：调用方已持有该 scope 的 WorkspaceWriteLock 行，之后按
 * Invocation → Attempt → Ownership 的固定顺序取锁（真实行存在 + `ownershipState='active'`
 * + 用数据库时间判定的 Lease 未过期）。**不能**用 slot 上写入的 `leaseExpiresAt` 推断：
 * 心跳只会前移 Ownership 自己的租约，没有任何路径会去刷新 slot 上的旧值。
 */
export async function isHolderOwnershipHealthy(
  input: {
    tenantId: string;
    holderInvocationId: string | null;
    holderAttemptId: string | null;
    holderOwnershipId: string | null;
    now: Date;
  },
  executor: DbOrTx = db,
): Promise<boolean> {
  if (!input.holderInvocationId || !input.holderAttemptId || !input.holderOwnershipId) return false;
  const [invocation] = await executor
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.tenantId, input.tenantId),
        eq(invocationTable.id, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!invocation) return false;
  const [attempt] = await executor
    .select({ id: invocationAttemptTable.id })
    .from(invocationAttemptTable)
    .where(
      and(
        eq(invocationAttemptTable.tenantId, input.tenantId),
        eq(invocationAttemptTable.id, input.holderAttemptId),
        eq(invocationAttemptTable.invocationId, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!attempt) return false;
  const [owner] = await executor
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.holderOwnershipId),
        eq(executionOwnershipTable.invocationId, input.holderInvocationId),
      ),
    )
    .for("update")
    .limit(1);
  return Boolean(owner && owner.ownershipState === "active" && owner.leaseExpiresAt > input.now);
}

/**
 * 从持久行投影出撤销/失败补偿所需的**精确归属身份**（A07 决策五）。
 *
 * `backendOperationId` 不是可选装饰：它由 `workspaceWriterActivationOperationId` 派生，
 * 把 binding / scope / attempt / ownership / epoch 全部传递绑定，因此是身份的承重字段 ——
 * 少了它就等于退回"按 generation 停别人"。
 *
 * 缺任一字段返回 `null`：调用方必须据此**放弃物理停止**（fail closed），而不是猜。
 */
export function workspaceWriterIdentityFromLock(
  lock: WorkspaceWriteLock,
): WorkspaceWriterIdentity | null {
  const { holderInvocationId, holderAttemptId, holderOwnershipId, backendOperationId } = lock;
  if (!holderInvocationId || !holderAttemptId || !holderOwnershipId || !backendOperationId) {
    return null;
  }
  return {
    tenantId: lock.tenantId,
    scopeDigest: lock.storageScopeDigest,
    writerGeneration: lock.writerGeneration,
    invocationId: holderInvocationId,
    attemptId: holderAttemptId,
    ownershipId: holderOwnershipId,
    operationId: backendOperationId,
  };
}

export interface AcquireWorkspaceWriteLockResult {
  outcome: "reserved";
  lock: WorkspaceWriteLock;
  writerGeneration: number;
}

/** 已登记释放、但物理停止尚未确认时 `reserveWorkspaceWriter` 的显式结果。 */
export interface WorkspaceReleasePending {
  outcome: "release_pending";
  lock: WorkspaceWriteLock;
  /**
   * - `release_in_progress`：该 scope 已有在办的释放工作（`releasing`），本行不得被覆盖；
   * - `previous_writer_not_stopped`：旧 holder 已失权但仍是 `active`；本轮已把释放义务
   *   可靠登记进持久状态，必须等真实停止证据成立（行变 `released`）后才能分配下一代。
   */
  reason: "release_in_progress" | "previous_writer_not_stopped";
}

export type ReserveWorkspaceWriterOutcome =
  | AcquireWorkspaceWriteLockResult
  | WorkspaceReleasePending;

/**
 * `WorkspaceWriteLock` 预留事务的真实事务类型。
 *
 * 由 `db.transaction` 的回调参数推导而来，因此调用方在编译期就必须把一个**真实事务**
 * 交进来。这正是 A07 决策四要消灭的形态：`executor: DbOrTx = db` 的默认值会把
 * "取 scope 行锁"与"条件 UPDATE"拆成两条自动提交语句，两者之间没有任何互斥。
 */
export type WorkspaceWriteLockTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 并发冲突时整事务重试的次数上限（回滚 → 重读 → 重新决策）。 */
export const WORKSPACE_RESERVE_CONTENTION_RETRIES = 3;

function sameHolderTuple(
  lock: WorkspaceWriteLock,
  input: AcquireWorkspaceWriteLockParams,
): boolean {
  return (
    lock.holderInvocationId === input.invocationId &&
    lock.holderAttemptId === input.attemptId &&
    lock.holderOwnershipId === input.ownershipId &&
    lock.workspaceBindingId === input.workspaceBindingId
  );
}

/** W→I 的第一步：先锁 scope 行（tenant + storageScopeDigest 唯一）。 */
async function readScopeLock(
  tx: WorkspaceWriteLockTx,
  input: { tenantId: string; storageScopeDigest: string },
): Promise<WorkspaceWriteLock | undefined> {
  const [row] = await tx
    .select()
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, input.tenantId),
        eq(workspaceWriteLock.storageScopeDigest, input.storageScopeDigest),
      ),
    )
    .for("update")
    .limit(1);
  return row;
}

async function readLockById(tx: WorkspaceWriteLockTx, lockId: string): Promise<WorkspaceWriteLock> {
  const [row] = await tx
    .select()
    .from(workspaceWriteLock)
    .where(eq(workspaceWriteLock.id, lockId))
    .limit(1);
  if (!row) throw new WorkspaceWriterConflictError("Workspace writer 预留后回查失败");
  return row;
}

/**
 * 在同一事务内把已确认无人使用的 scope 推进到下一代预留。
 *
 * 前提由调用方保证，只有两种情况：
 * - 上一代已被释放 lane 在真实停止回执成立后写成 `released`；
 * - 上一代是 `reserved` 且从未走到激活 —— 物理 Writer 只能由 Broker 在自己的
 *   `activateWriter` 临界区内启动，而 Broker 只在更旧代际确认停止后才放行下一代
 *   （A07 决策二），因此该槽位不存在"仍在运行却失去定位"的旧写者。
 *
 * 保留 `releaseReceipt`：它是上一代真实停止的历史证据，不属于本次预留可清空的工作字段。
 */
async function allocateNextGeneration(
  tx: WorkspaceWriteLockTx,
  current: WorkspaceWriteLock,
  input: AcquireWorkspaceWriteLockParams,
  now: Date,
): Promise<AcquireWorkspaceWriteLockResult> {
  const writerGeneration = current.writerGeneration + 1;
  await tx
    .update(workspaceWriteLock)
    .set({
      writerGeneration,
      lockState: "reserved",
      holderInvocationId: input.invocationId,
      holderAttemptId: input.attemptId,
      holderOwnershipId: input.ownershipId,
      workspaceBindingId: input.workspaceBindingId,
      backendGrantRef: input.backendGrantRef ?? null,
      backendEvidence: input.backendEvidence ?? null,
      backendOperationId: input.backendOperationId ?? null,
      backendReceipt: input.backendReceipt ?? null,
      leaseExpiresAt: input.leaseExpiresAt,
      releaseReasonCode: null,
      releaseNextAttemptAt: null,
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      releaseErrorCode: null,
      versionNo: current.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(workspaceWriteLock.id, current.id));
  return { outcome: "reserved", lock: await readLockById(tx, current.id), writerGeneration };
}

/**
 * 旧 holder 已失权却仍占着 `active` 槽位：**先可靠登记释放**，本轮不分配新代。
 *
 * 这是 A07-05/06 的核心：直接覆盖该行会让"原待停止工作"失去定位。这里只把义务写进
 * 持久状态（`releasing` + reasonCode），holder tuple、Backend 回执与定位字段**全部保留**；
 * 物理停止由释放 lane（A08）按 W→I 顺序完成。只有它写出 `released` 之后，
 * 下一代才会在 `allocateNextGeneration` 里被分配。
 */
async function registerReleaseForLostHolder(
  tx: WorkspaceWriteLockTx,
  current: WorkspaceWriteLock,
  now: Date,
): Promise<WorkspaceReleasePending> {
  await tx
    .update(workspaceWriteLock)
    .set({
      lockState: "releasing",
      releaseReasonCode: "writer_holder_ownership_lost",
      releaseNextAttemptAt: null,
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      releaseErrorCode: null,
      versionNo: current.versionNo + 1,
      updatedAt: now,
    })
    .where(eq(workspaceWriteLock.id, current.id));
  return {
    outcome: "release_pending",
    lock: await readLockById(tx, current.id),
    reason: "previous_writer_not_stopped",
  };
}

/**
 * W→I 顺序的**强制事务**预留（A07 决策四）。
 *
 * 锁顺序固定为 `WorkspaceWriteLock(scope) → Invocation → Attempt → Ownership`：
 * 只有在拿到 scope 行锁之后，才通过 `isHolderOwnershipHealthy` 真实读取
 * Invocation → Attempt → Ownership 三行。本函数**没有**默认全局 `db` 的出口，
 * 因此"取行锁"与"条件 UPDATE"在类型上就不可能落到两个自动提交事务里。
 *
 * 并发唯一键冲突不在这里吞掉：它必须冒泡到事务边界，由 `reserveWorkspaceWriter`
 * 回滚**整个**预留事务后重读，而不是对旧结果覆盖写。
 */
export async function reserveWorkspaceWriterInTransaction(
  tx: WorkspaceWriteLockTx,
  input: AcquireWorkspaceWriteLockParams,
): Promise<ReserveWorkspaceWriterOutcome> {
  const now = new Date();
  const current = await readScopeLock(tx, input);

  if (!current) {
    // scope 行不存在：靠已有同租户 scope 唯一约束插入首代。并发方的插入会被唯一约束
    // 挡住，由外层回滚整个事务后重读 —— 绝不 `ON DUPLICATE KEY UPDATE` 覆盖另一方。
    const id = randomUUID();
    await tx.insert(workspaceWriteLock).values({
      id,
      tenantId: input.tenantId,
      storageScopeDigest: input.storageScopeDigest,
      writerGeneration: 1,
      lockState: "reserved",
      holderInvocationId: input.invocationId,
      holderAttemptId: input.attemptId,
      holderOwnershipId: input.ownershipId,
      workspaceBindingId: input.workspaceBindingId,
      backendGrantRef: input.backendGrantRef ?? null,
      backendEvidence: input.backendEvidence ?? null,
      backendOperationId: input.backendOperationId ?? null,
      backendReceipt: input.backendReceipt ?? null,
      leaseExpiresAt: input.leaseExpiresAt,
      releaseReasonCode: null,
      releaseAttemptCount: 0,
      versionNo: 1,
      createdAt: now,
      updatedAt: now,
    });
    const lock = await readLockById(tx, id);
    return { outcome: "reserved", lock, writerGeneration: lock.writerGeneration };
  }

  if (current.lockState === "released") {
    // `released` 只能由释放 lane 在真实停止回执成立后写出 → 上一代确已不存在可写者。
    return allocateNextGeneration(tx, current, input, now);
  }
  if (current.lockState === "releasing") {
    // 释放义务在办：既不抹掉义务与回执，也不抢下一代。
    return { outcome: "release_pending", lock: current, reason: "release_in_progress" };
  }
  // 到这里状态只剩 `reserved` / `active`。
  if (sameHolderTuple(current, input)) {
    // 同一精确 holder 的幂等重放：返回原 generation，且**不写任何状态**
    // —— 尤其不能把 `active` 打回 `reserved`。
    return { outcome: "reserved", lock: current, writerGeneration: current.writerGeneration };
  }
  // R04 §4：接管条件是"父 Owner 已经失权"，不是"slot 上写的 leaseExpiresAt 到期"。
  const healthy = await isHolderOwnershipHealthy(
    {
      tenantId: input.tenantId,
      holderInvocationId: current.holderInvocationId,
      holderAttemptId: current.holderAttemptId,
      holderOwnershipId: current.holderOwnershipId,
      now,
    },
    tx,
  );
  if (healthy) {
    throw new WorkspaceWriterConflictError(
      "Workspace writer 的父 Owner 仍然健康，不得抢占该 generation",
    );
  }
  if (current.lockState === "active") {
    // `active` 意味着该代际的物理 Writer 可能仍在运行，直接覆盖会丢掉它的定位。
    return registerReleaseForLostHolder(tx, current, now);
  }
  return allocateNextGeneration(tx, current, input, now);
}

/**
 * 预留（或重放同一 holder tuple 的预留）的唯一默认入口：**自己开事务**。
 *
 * 并发唯一键/死锁冲突 → 回滚整个预留事务 → 重读 → 重新决策，最多重试
 * `WORKSPACE_RESERVE_CONTENTION_RETRIES` 次。非并发冲突（例如"父 Owner 仍然健康"）
 * 直接冒泡，不重试、不降级。
 */
export async function reserveWorkspaceWriter(
  input: AcquireWorkspaceWriteLockParams,
): Promise<ReserveWorkspaceWriterOutcome> {
  let lastContention: unknown;
  for (let attempt = 0; attempt < WORKSPACE_RESERVE_CONTENTION_RETRIES; attempt += 1) {
    try {
      return await db.transaction((tx) => reserveWorkspaceWriterInTransaction(tx, input));
    } catch (error) {
      if (!isMysqlTransactionContentionError(error)) throw error;
      lastContention = error;
    }
  }
  throw new WorkspaceWriterConflictError(
    `Workspace writer 预留并发冲突，回滚重读 ${WORKSPACE_RESERVE_CONTENTION_RETRIES} 次后仍未取得：${
      lastContention instanceof Error ? lastContention.message : String(lastContention)
    }`,
  );
}

/**
 * W→I 顺序的 Writer 激活（R04 §2/§4）。
 *
 * 先锁 WorkspaceWriteLock（scope），再按 Invocation → Attempt → Ownership 复核
 * Current Ownership 与 generation/leaseEpoch，最后才提交 Write-Activated。
 * 事务内不执行任何外部副作用，且**强制**由调用方传入真实事务（与预留同一条 W→I 顺序）。
 *
 * A07 决策四的下半段：数据库原子预留成功后才出站请求 Broker；回包必须携带**完整预留
 * 身份** `(tenant, scope, lockId, writerGeneration, invocation, attempt, ownership,
 * leaseEpoch, operationId)` 才能落库。迟到回包或不同 operation 的回包一律拒绝，
 * 绝不改写当前槽位。
 */
export async function activateWorkspaceWriter(
  input: {
    tenantId: string;
    storageScopeDigest: string;
    invocationId: string;
    attemptId: string;
    lockId: string;
    writerGeneration: number;
    ownershipId: string;
    leaseEpoch: number;
    backendGrantRef: string;
    backendEvidence?: unknown;
    backendOperationId?: string | null;
    backendReceipt?: unknown;
    now?: Date;
  },
  tx: WorkspaceWriteLockTx,
): Promise<WorkspaceWriteLock> {
  const now = input.now ?? new Date();
  const [lock] = await tx
    .select()
    .from(workspaceWriteLock)
    .where(
      and(eq(workspaceWriteLock.tenantId, input.tenantId), eq(workspaceWriteLock.id, input.lockId)),
    )
    .for("update")
    .limit(1);
  if (
    !lock ||
    lock.lockState !== "reserved" ||
    lock.writerGeneration !== input.writerGeneration ||
    lock.storageScopeDigest !== input.storageScopeDigest ||
    lock.holderInvocationId !== input.invocationId ||
    lock.holderAttemptId !== input.attemptId ||
    lock.holderOwnershipId !== input.ownershipId
  ) {
    throw new WorkspaceWriterConflictError("Workspace writer 预留不匹配");
  }
  const healthy = await isHolderOwnershipHealthy(
    {
      tenantId: input.tenantId,
      holderInvocationId: input.invocationId,
      holderAttemptId: input.attemptId,
      holderOwnershipId: input.ownershipId,
      now,
    },
    tx,
  );
  if (!healthy) throw new WorkspaceWriterConflictError("Workspace writer 的父 Owner 已失权");
  // 精确身份的最后一项：回包必须属于**本次** Backend operation。顺序放在持有者健康度之后，
  // 是因为两者都是"不得落库"的理由，而失权是更早、更本质的判定。
  if ((lock.backendOperationId ?? null) !== (input.backendOperationId ?? null)) {
    throw new WorkspaceWriterConflictError("Workspace writer 的 Backend operation 身份不一致");
  }
  const [owner] = await tx
    .select({ leaseEpoch: executionOwnershipTable.leaseEpoch })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, input.tenantId),
        eq(executionOwnershipTable.id, input.ownershipId),
      ),
    )
    .for("update")
    .limit(1);
  if (!owner || owner.leaseEpoch !== input.leaseEpoch) {
    throw new WorkspaceWriterConflictError("Workspace writer 的 Owner 代际已变化");
  }
  await tx
    .update(workspaceWriteLock)
    .set({
      lockState: "active",
      backendGrantRef: input.backendGrantRef,
      backendEvidence: input.backendEvidence ?? lock.backendEvidence,
      backendOperationId: input.backendOperationId ?? lock.backendOperationId,
      backendReceipt: input.backendReceipt ?? lock.backendReceipt,
      releaseReasonCode: null,
      releaseNextAttemptAt: null,
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      releaseErrorCode: null,
      updatedAt: now,
      versionNo: lock.versionNo + 1,
    })
    .where(eq(workspaceWriteLock.id, lock.id));
  const [active] = await tx
    .select()
    .from(workspaceWriteLock)
    .where(eq(workspaceWriteLock.id, lock.id))
    .limit(1);
  if (!active) throw new WorkspaceWriterConflictError("Workspace writer 激活后回查失败");
  return active;
}

/**
 * 写一条**持久**的物理释放请求（R04 §3「写持久资源清理请求」）。
 *
 * 只改控制面状态，不触碰 Backend，也不清空 Backend 定位字段（§7：不能先清空回执定位
 * 再失去清理能力）。物理 stop/drain 由释放 lane 完成。幂等：重复请求保留首个 reasonCode。
 */
export async function requestWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  reasonCode: string;
  /** 限定 holder：只有当前 holder 就是该 Ownership 时才写请求（防止误标他人槽位）。 */
  ownershipId?: string;
  now?: Date;
}): Promise<WorkspaceWriteLock | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return null;
    if (input.ownershipId && lock.holderOwnershipId !== input.ownershipId) return lock;
    if (lock.lockState === "released" || lock.lockState === "releasing") return lock;
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseReasonCode: input.reasonCode,
        // 可见性来自 lockState；立即到期让正式 Worker 下一轮就处理，不再等退避。
        releaseNextAttemptAt: null,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    const [requested] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(eq(workspaceWriteLock.id, lock.id))
      .limit(1);
    return requested ?? null;
  });
}

export async function getActiveLocksByInvocation(
  tenantId: string,
  invocationId: string,
  executor: DbOrTx = db,
): Promise<WorkspaceWriteLock[]> {
  return executor
    .select()
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, tenantId),
        eq(workspaceWriteLock.holderInvocationId, invocationId),
        holderStates(),
      ),
    );
}

// ── 物理释放 lane 的持久状态（R04 §3）───────────────────────────────────────

/** 释放重试退避（与 Environment Lease 清理同构）。 */
export const WORKSPACE_RELEASE_BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
/** 领取权时长：过期 Worker 不能覆盖新 claim 的结果。 */
export const WORKSPACE_RELEASE_LEASE_MS = 60_000;

export function workspaceReleaseBackoffMs(attemptCount: number): number {
  const index = Math.max(0, attemptCount - 1);
  return WORKSPACE_RELEASE_BACKOFF_MS[index] ?? 300_000;
}

export interface WorkspaceWriteLockReleaseCandidate {
  tenantId: string;
  lockId: string;
  lockState: WorkspaceWriteLockState;
}

/**
 * 扫描需要物理释放的 Writer（R04 §3/§5：**只取候选 ID**）。
 *
 * 候选包含两类：显式释放请求（`releasing`）与"仍被持有但父 Owner 已失权"的槽位。
 * 后者在这一步**不做**健康判断——健康复核在领取事务里按对象自身状态重做，
 * 因此"扫描后、领取前"发生的新 Owner 接管不会被误释放。
 */
export async function scanWorkspaceWriteLocksNeedingRelease(input: {
  now: Date;
  limit: number;
  tenantId?: string;
}): Promise<WorkspaceWriteLockReleaseCandidate[]> {
  const dueNow = or(
    isNull(workspaceWriteLock.releaseNextAttemptAt),
    lte(workspaceWriteLock.releaseNextAttemptAt, input.now),
  );
  const leaseFree = or(
    isNull(workspaceWriteLock.releaseLeaseExpiresAt),
    lte(workspaceWriteLock.releaseLeaseExpiresAt, input.now),
  );
  return (
    db
      .select({
        tenantId: workspaceWriteLock.tenantId,
        lockId: workspaceWriteLock.id,
        lockState: workspaceWriteLock.lockState,
      })
      .from(workspaceWriteLock)
      .where(
        and(
          ...(input.tenantId ? [eq(workspaceWriteLock.tenantId, input.tenantId)] : []),
          inArray(workspaceWriteLock.lockState, [
            "reserved",
            "active",
            "releasing",
          ] as WorkspaceWriteLockState[]),
          dueNow,
          leaseFree,
        ),
      )
      // A08 8.3：**释放工作优先于"健康 Owner 复检"**，否则批次会被健康槽位长期占满。
      //
      // 候选集里有两类行，性质完全不同：
      // - `releasing`：已由某个出口确定必须物理释放，是**义务**；
      // - `reserved` / `active`：只是"可能有失权残留"的嫌疑行，需要逐行复验父 Owner 健康度，
      //   是**可选的搭车复检**（这一轮没做，下一轮仍会做）。
      //
      // 但它们的 `releaseNextAttemptAt` 分布恰好相反：`releasing` 总有到期时间，而健康 active
      // 行通常是 NULL —— MySQL 的 ASC 排序把 NULL 排在最前，于是只要健康 active 行数超过批次
      // 上限，后排**已到期**的 releasing 行就永远排在批次之外（领取时又只是跳过健康行，
      // 不产生任何分页进度）。把 `releasing` 显式排在前面，义务就不会被嫌疑行的复检挤掉；
      // 嫌疑行自身靠 `releaseWorkspaceWriterClaim` 写的复检时间轮转，不会互相饿死。
      .orderBy(
        desc(sql`${workspaceWriteLock.lockState} = 'releasing'`),
        asc(workspaceWriteLock.releaseNextAttemptAt),
        asc(workspaceWriteLock.updatedAt),
      )
      .limit(input.limit)
  );
}

/**
 * 领取一条释放工作（W→I 顺序）。
 *
 * 候选 ID 来自扫描，但这里必须重新读对象自身状态并复验"父 Owner 已失权"，
 * 因此扫描与领取之间发生的新 Owner 接管不会被误释放。
 */
export async function claimWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  now: Date;
  leaseDurationMs?: number;
}): Promise<
  | { outcome: "claimed"; lock: WorkspaceWriteLock; releaseAttemptCount: number }
  | {
      outcome: "skipped";
      reason: "not_found" | "already_released" | "healthy_owner" | "claimed_elsewhere";
    }
> {
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return { outcome: "skipped" as const, reason: "not_found" as const };
    if (lock.lockState === "released")
      return { outcome: "skipped" as const, reason: "already_released" as const };
    if (
      lock.releaseLeaseExpiresAt &&
      lock.releaseLeaseExpiresAt > input.now &&
      lock.releaseLeaseOwner !== input.leaseOwner
    ) {
      return { outcome: "skipped" as const, reason: "claimed_elsewhere" as const };
    }
    if (lock.lockState === "reserved" || lock.lockState === "active") {
      const healthy = await isHolderOwnershipHealthy(
        {
          tenantId: input.tenantId,
          holderInvocationId: lock.holderInvocationId,
          holderAttemptId: lock.holderAttemptId,
          holderOwnershipId: lock.holderOwnershipId,
          now: input.now,
        },
        tx,
      );
      if (healthy) return { outcome: "skipped" as const, reason: "healthy_owner" as const };
    }
    const releaseAttemptCount = lock.releaseAttemptCount + 1;
    const leaseExpiresAt = new Date(
      input.now.getTime() + (input.leaseDurationMs ?? WORKSPACE_RELEASE_LEASE_MS),
    );
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseReasonCode: lock.releaseReasonCode ?? "writer_owner_no_longer_current",
        releaseAttemptCount,
        releaseNextAttemptAt: null,
        releaseLeaseOwner: input.leaseOwner,
        releaseLeaseExpiresAt: leaseExpiresAt,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    const [claimed] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(eq(workspaceWriteLock.id, lock.id))
      .limit(1);
    if (!claimed) return { outcome: "skipped" as const, reason: "not_found" as const };
    return { outcome: "claimed" as const, lock: claimed, releaseAttemptCount };
  });
}

/**
 * 完成一条释放工作。
 *
 * - 该 generation 仍是本行 holder → 写 `released` 并保留真实 stop/drain 回执；
 * - 期间已被新 generation 接管 → Backend 的接管流程本身已停止旧 Writer，
 *   因此**不再改本行**（否则会杀掉新 Writer），只回报 `superseded`。
 */
export async function completeWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  releaseReceipt: unknown;
  reasonCode: string;
  now: Date;
}): Promise<{ outcome: "released" | "superseded" | "not_owner" }> {
  return db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock) return { outcome: "not_owner" as const };
    if (lock.lockState === "released") return { outcome: "released" as const };
    if (lock.releaseLeaseOwner && lock.releaseLeaseOwner !== input.leaseOwner)
      return { outcome: "not_owner" as const };
    // 已被新 generation 接管：Backend 的接管流程本身已停止旧 Writer，因此**完全不改本行**
    // ——连回执也不写，否则会把上一个 generation 的停止证据挂到新 Writer 的槽位上。
    if (lock.lockState === "reserved" || lock.lockState === "active") {
      return { outcome: "superseded" as const };
    }
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "released",
        holderInvocationId: null,
        holderAttemptId: null,
        holderOwnershipId: null,
        workspaceBindingId: null,
        backendGrantRef: null,
        backendEvidence: null,
        backendOperationId: null,
        backendReceipt: null,
        leaseExpiresAt: null,
        releaseReasonCode: input.reasonCode,
        releaseReceipt: input.releaseReceipt,
        releaseNextAttemptAt: null,
        releaseLeaseOwner: null,
        releaseLeaseExpiresAt: null,
        releaseErrorCode: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
    return { outcome: "released" as const };
  });
}

/** 释放失败：保持 `releasing` + 退避重试，释放领取权让其他 Worker 可接管。 */
export async function recordWorkspaceWriterReleaseFailure(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  errorCode: string;
  now: Date;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [lock] = await tx
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, input.tenantId),
          eq(workspaceWriteLock.id, input.lockId),
        ),
      )
      .for("update")
      .limit(1);
    if (!lock || lock.lockState === "released") return;
    if (lock.releaseLeaseOwner && lock.releaseLeaseOwner !== input.leaseOwner) return;
    // 可见性由 lockState 保证；`releaseNextAttemptAt` 只推迟下一次尝试。
    await tx
      .update(workspaceWriteLock)
      .set({
        lockState: "releasing",
        releaseErrorCode: input.errorCode,
        releaseNextAttemptAt: new Date(
          input.now.getTime() + workspaceReleaseBackoffMs(lock.releaseAttemptCount),
        ),
        releaseLeaseOwner: null,
        releaseLeaseExpiresAt: null,
        versionNo: lock.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(workspaceWriteLock.id, lock.id));
  });
}

/**
 * 回收扫描周期（R04 §5）。
 *
 * "父 Owner 仍然健康"的行每轮都会被重新核验一次（释放工作的可见性不能依赖任何人主动
 * 写请求），但这个核验本身有成本：跳过之后把它推到下一次复检，避免每轮都重复抢占扫描
 * 配额。失败退避由 `recordWorkspaceWriterReleaseFailure` 独立控制，不与之混用。
 */
export const WORKSPACE_RELEASE_RECHECK_MS = 30_000;

/**
 * 归还领取权。
 *
 * `nextAttemptAt` 语义：给出时写入"下次尝试时间"；`undefined` 表示**不改动**该字段
 * （失败退避已由 `recordWorkspaceWriterReleaseFailure` 写好，不能被这里抹掉）。
 */
export async function releaseWorkspaceWriterClaim(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  now: Date;
  nextAttemptAt?: Date | null;
}): Promise<void> {
  await db
    .update(workspaceWriteLock)
    .set({
      releaseLeaseOwner: null,
      releaseLeaseExpiresAt: null,
      ...(input.nextAttemptAt !== undefined ? { releaseNextAttemptAt: input.nextAttemptAt } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workspaceWriteLock.tenantId, input.tenantId),
        eq(workspaceWriteLock.id, input.lockId),
        // 只在本 Worker 仍持有领取权、或本行根本没有领取者时更新：
        // 绝不覆盖其他 Worker 的有效 claim。
        or(
          isNull(workspaceWriteLock.releaseLeaseOwner),
          eq(workspaceWriteLock.releaseLeaseOwner, input.leaseOwner),
        ),
      ),
    );
}
