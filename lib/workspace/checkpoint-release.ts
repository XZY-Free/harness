/**
 * 安全点解冻的持久工作（R09 §2 步骤 8）。
 *
 * 「解冻 Runtime 和 Backend 是持久命令/工作」——不能只在 `finally` 里调用一次然后
 * `.catch(() => undefined)`。本模块的语义：
 *
 * - Checkpoint 提交（或候选受控放弃）后 Gate 进入 `releasing`，并持久记录两条腿：
 *   `runtime`（Runtime 侧安全点释放）与 `backend`（Broker 文件 Generation 解冻）。
 * - **两条腿都确认之后** Gate 才回到 `open`；只要还有一条未确认，Gate 继续 fail-closed，
 *   不放行新决策/新 Action/新写入——因为文件 Generation 可能仍然冻结。
 * - 进程在解冻途中 Crash 时，`recoverPendingCheckpointReleases` 作为维护 lane 按
 *   `checkpointIntentId` 续做。Backend 腿可由平台自己完成（幂等）；Runtime 腿若原
 *   Ownership 已消失（终态/失去 active），则没有可解冻的 Runtime，据实记为已确认。
 */
import { db } from "@/lib/db/client";
import { getAuthorityDatabaseTime } from "@/lib/executions/persistence/execution-ownership-store";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { resolveManagedWorkspaceResources } from "@/lib/workspace/managed-workspace-host";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import type { SafePointReceipt, WorkspaceHost } from "@/lib/workspace/workspace-host";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";

export type CheckpointReleaseLegState = "pending" | "confirmed";

export interface CheckpointReleaseLegs {
  runtime: CheckpointReleaseLegState;
  backend: CheckpointReleaseLegState;
}

interface CheckpointReleaseRecord extends CheckpointReleaseLegs {
  registeredAt?: number;
  updatedAt?: number;
  freeze?: SafePointReceipt;
  checkpointId?: string;
}

const RELEASE_GRACE_MS = 60_000;

function readReleaseRecord(value: unknown): CheckpointReleaseRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const release = (value as { release?: unknown }).release;
  if (!release || typeof release !== "object" || Array.isArray(release)) return null;
  const record = release as Record<string, unknown>;
  if (record.runtime !== "pending" && record.runtime !== "confirmed") return null;
  if (record.backend !== "pending" && record.backend !== "confirmed") return null;
  return {
    runtime: record.runtime,
    backend: record.backend,
  };
}

function readFreezeFromEvidence(value: unknown): SafePointReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const freeze = (value as { freeze?: unknown }).freeze;
  if (!freeze || typeof freeze !== "object" || Array.isArray(freeze)) return null;
  const candidate = freeze as Partial<SafePointReceipt>;
  if (typeof candidate.checkpointIntentId !== "string") return null;
  return candidate as SafePointReceipt;
}

/** 登记 Runtime 腿待确认。必须在真正解冻之前落库，否则 Crash 后无从得知要解冻什么。 */
export async function registerCheckpointRuntimeReleasePending(input: {
  tenantId: string;
  invocationId: string;
  checkpointIntentId: string;
}): Promise<CheckpointReleaseLegs> {
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation || invocation.checkpointIntentId !== input.checkpointIntentId)
      throw new Error("CheckpointStale");
    const legs = readReleaseRecord(invocation.checkpointPreparedEvidence) ?? {
      runtime: "pending" as const,
      backend: "pending" as const,
    };
    const now = await getAuthorityDatabaseTime(tx);
    await tx
      .update(invocationTable)
      .set({
        checkpointPreparedEvidence: {
          ...(invocation.checkpointPreparedEvidence as Record<string, unknown>),
          release: { ...legs, runtime: "pending", registeredAt: now.getTime() },
        },
        versionNo: invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
    return { ...legs, runtime: "pending" };
  });
}

/**
 * 确认 Runtime 腿并（在 Backend 腿也确认后）解除 Gate。
 *
 * 由 dispatcher 在 `releaseSafePoint` 成功之后调用；失败时不得调用，
 * Backend/维护 lane 会看到仍是 pending 并保持 Gate fail-closed。
 */
export async function confirmCheckpointRuntimeRelease(input: {
  tenantId: string;
  invocationId: string;
  checkpointIntentId: string;
}): Promise<CheckpointReleaseLegs> {
  return updateReleaseLegs(input, (legs) => ({ ...legs, runtime: "confirmed" }));
}

/**
 * 只记录失败原因，不改动两条腿的状态。
 *
 * Runtime 解冻失败时 Gate 必须保持 `releasing`，但失败原因要可见（可观测性），
 * 供控制面判断是否需要重发 Runtime 侧释放命令。
 */
export async function recordCheckpointReleaseFailure(input: {
  tenantId: string;
  invocationId: string;
  checkpointIntentId: string;
  reasonCode: string;
}): Promise<CheckpointReleaseLegs> {
  return updateReleaseLegs(input, (legs) => legs, input.reasonCode);
}

/**
 * 完成 Backend 腿：真正调用 Broker 解冻，然后按两条腿的状态决定 Gate。
 *
 * 解冻失败**不吞异常**：记 `backend: pending` + 原因，Gate 保持 `releasing`，
 * 由维护 lane 重试。Checkpoint 本身是已提交的持久事实，因此这里不向上抛（否则
 * 调用方会误以为 Checkpoint 失败），但解冻结果一定被持久化并可见。
 */
export async function confirmCheckpointBackendRelease(input: {
  tenantId: string;
  invocationId: string;
  checkpointIntentId: string;
  freeze: SafePointReceipt | null;
  backend: WorkspaceBackend;
}): Promise<CheckpointReleaseLegs> {
  let failureCode: string | null = null;
  if (input.freeze) {
    try {
      await releaseBackendFreeze(input.backend.host, input.freeze);
    } catch (error) {
      failureCode = error instanceof Error ? error.message : "BackendReleaseFailed";
      console.error(
        `Checkpoint Backend 解冻失败（intent ${input.checkpointIntentId}），Gate 保持 releasing 等待维护 lane：${failureCode}`,
      );
    }
  }
  if (failureCode) {
    return updateReleaseLegs(input, (legs) => ({ ...legs, backend: "pending" }), failureCode);
  }
  return updateReleaseLegs(input, (legs) => ({ ...legs, backend: "confirmed" }));
}

/**
 * Broker 解冻是幂等的外部工作：安全点文件保留，附加一条 released 标记。
 * 重复调用不会破坏已确认的状态，这正是 Crash 后续做所需。
 */
async function releaseBackendFreeze(host: WorkspaceHost, freeze: SafePointReceipt): Promise<void> {
  await host.releaseFreeze(freeze);
}

async function updateReleaseLegs(
  input: { tenantId: string; invocationId: string; checkpointIntentId: string },
  apply: (legs: CheckpointReleaseRecord) => CheckpointReleaseRecord,
  failureCode?: string,
): Promise<CheckpointReleaseLegs> {
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation || invocation.checkpointIntentId !== input.checkpointIntentId)
      throw new Error("CheckpointStale");
    const evidence = (invocation.checkpointPreparedEvidence ?? {}) as Record<string, unknown>;
    const current = readReleaseRecord(evidence) ?? {
      runtime: "pending" as const,
      backend: "pending" as const,
    };
    const next = apply(current);
    const now = await getAuthorityDatabaseTime(tx);
    const bothConfirmed = next.runtime === "confirmed" && next.backend === "confirmed";
    await tx
      .update(invocationTable)
      .set({
        checkpointPreparedEvidence: {
          ...evidence,
          release: {
            ...next,
            ...(failureCode ? { failureCode } : {}),
            updatedAt: now.getTime(),
          },
        },
        ...(bothConfirmed
          ? {
              checkpointGate: "open",
              checkpointIntentId: null,
              checkpointOwnerId: null,
              checkpointDeadline: null,
            }
          : {}),
        versionNo: invocation.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(invocationTable.id, invocation.id));
    return next;
  });
}

export interface CheckpointReleaseRecoveryReport {
  examined: number;
  /** Backend 腿被本次维护收口（或原本就已确认）的行数。 */
  backendReleased: number;
  /** 仍在等 Runtime 腿的行数（Gate 保持 releasing）。 */
  awaitingRuntime: number;
  /** Runtime 腿因原 Owner 消失而据实关闭的行数。 */
  runtimeClosed: number;
  gateOpened: number;
  failures: Array<{ invocationId: string; reasonCode: string }>;
}

/**
 * 维护 lane：续做被 Crash/失败打断的解冻。
 *
 * 扫描 `checkpointGate = 'releasing'` 且超过 grace 的 Invocation（跨租户），按
 * `checkpointIntentId` 重建解冻工作。Backend 腿由本函数幂等续做；Runtime 腿只有在
 * 原 Ownership 已消失（Invocation 终态 / 无 active Ownership）时才据实关闭——
 * 有活的 Runtime 却宣称已解冻是伪造证据。
 */
export async function recoverPendingCheckpointReleases(
  input: {
    limit?: number;
    graceMs?: number;
    now?: Date;
    /** 测试/受管部署可注入 Backend 解析；默认走受管 Host 生产解析。 */
    resolveBackend?: (binding: WorkspaceBinding) => Promise<WorkspaceBackend>;
  } = {},
): Promise<CheckpointReleaseRecoveryReport> {
  const limit = input.limit ?? 50;
  const graceMs = input.graceMs ?? RELEASE_GRACE_MS;
  const cutoff = new Date((input.now ?? (await getAuthorityDatabaseTime(db))).getTime() - graceMs);
  const pending = await db
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.checkpointGate, "releasing"), lt(invocationTable.updatedAt, cutoff)),
    )
    .orderBy(asc(invocationTable.updatedAt))
    .limit(limit);
  const report: CheckpointReleaseRecoveryReport = {
    examined: pending.length,
    backendReleased: 0,
    awaitingRuntime: 0,
    runtimeClosed: 0,
    gateOpened: 0,
    failures: [],
  };
  for (const invocation of pending) {
    const checkpointIntentId = invocation.checkpointIntentId;
    if (!checkpointIntentId) {
      report.failures.push({
        invocationId: invocation.id,
        reasonCode: "ReleasingWithoutIntent",
      });
      continue;
    }
    const [activeOwner] = await db
      .select({ id: executionOwnershipTable.id })
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, invocation.tenantId),
          eq(executionOwnershipTable.invocationId, invocation.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .limit(1);
    const runtimeGone =
      !activeOwner ||
      invocation.executionState === "completed" ||
      invocation.executionState === "failed" ||
      invocation.executionState === "cancelled" ||
      invocation.executionState === "lost";
    const freeze = readFreezeFromEvidence(invocation.checkpointPreparedEvidence);
    try {
      if (freeze) {
        const [binding] = await db
          .select()
          .from(executionBindingTable)
          .where(
            and(
              eq(executionBindingTable.tenantId, invocation.tenantId),
              eq(executionBindingTable.invocationId, invocation.id),
            ),
          )
          .limit(1);
        if (!binding) throw new Error("WorkspaceNotReady");
        const workspaceBinding = await getWorkspaceBindingById(
          invocation.tenantId,
          binding.workspaceBindingId,
        );
        if (!workspaceBinding) throw new Error("WorkspaceNotReady");
        const backend = input.resolveBackend
          ? await input.resolveBackend(workspaceBinding)
          : createWorkspaceBackend((await resolveManagedWorkspaceResources(workspaceBinding)).host);
        await releaseBackendFreeze(backend.host, freeze);
      }
      report.backendReleased += 1;
      if (runtimeGone) {
        await db
          .update(invocationTable)
          .set({
            checkpointGate: "open",
            checkpointIntentId: null,
            checkpointOwnerId: null,
            checkpointDeadline: null,
            updatedAt: await getAuthorityDatabaseTime(db),
            versionNo: invocation.versionNo + 1,
          })
          .where(
            and(
              eq(invocationTable.tenantId, invocation.tenantId),
              eq(invocationTable.id, invocation.id),
              eq(invocationTable.checkpointIntentId, checkpointIntentId),
            ),
          );
        report.runtimeClosed += 1;
        report.gateOpened += 1;
      } else {
        report.awaitingRuntime += 1;
      }
    } catch (error) {
      report.failures.push({
        invocationId: invocation.id,
        reasonCode: error instanceof Error ? error.message : "ReleaseRecoveryFailed",
      });
    }
  }
  return report;
}

/** 解冻维护 lane 的稳定角色名（生产拓扑注册用）。 */
export const CHECKPOINT_RELEASE_LANE_ROLE = "checkpoint-release";

export interface StuckCheckpointGateReport {
  examined: number;
  abandoned: number;
  failures: Array<{ invocationId: string; reasonCode: string }>;
}

/**
 * 维护 lane：收口"卡住的安全点 Gate"（R05 §5 的 `stuck gate`）。
 *
 * 安全点请求后进程 Crash、或候选未提交就丢失，会留下 `quiescing`/`frozen` 的 Gate。
 * 超过 deadline 之后它们既不能提交也不能永久持有写入屏障，必须按 §2
 * 「记录明确放弃与清理意图」受控放弃；已取到 freeze 的候选转入 `releasing` 交给解冻 lane。
 */
export async function recoverStuckCheckpointGates(
  input: {
    limit?: number;
    graceMs?: number;
    now?: Date;
    abandon?: (params: {
      tenantId: string;
      invocationId: string;
      ownershipId: string;
      checkpointIntentId: string;
      reasonCode: string;
      freeze?: SafePointReceipt;
    }) => Promise<void>;
  } = {},
): Promise<StuckCheckpointGateReport> {
  const { abandonFilesystemCheckpoint } = await import("@/lib/workspace/checkpoint-producer");
  const abandon = input.abandon ?? abandonFilesystemCheckpoint;
  const now = input.now ?? (await getAuthorityDatabaseTime(db));
  const graceMs = input.graceMs ?? RELEASE_GRACE_MS;
  // R05 §5 要求维护 lane 处理「prepared 无 retry timestamp」这类**缺失时间戳**的状态；
  // 安全点 Gate 同理：`checkpointDeadline` 是可空列，若某条路径只置了 gate 而没置 deadline，
  // `deadline < now` 在 SQL 三值逻辑下恒为 NULL，这一行会被**永久漏扫**并一直持有写入屏障。
  // 因此无 deadline 的 Gate 以 `updatedAt` + grace 作为兜底判据，而不是假设它不可能出现。
  const graceCutoff = new Date(now.getTime() - graceMs);
  const stuck = await db
    .select()
    .from(invocationTable)
    .where(
      and(
        inArray(invocationTable.checkpointGate, ["quiescing", "frozen"]),
        or(
          lt(invocationTable.checkpointDeadline, now),
          and(
            isNull(invocationTable.checkpointDeadline),
            lt(invocationTable.updatedAt, graceCutoff),
          ),
        ),
      ),
    )
    .orderBy(asc(invocationTable.updatedAt))
    .limit(input.limit ?? 50);
  const report: StuckCheckpointGateReport = { examined: stuck.length, abandoned: 0, failures: [] };
  for (const invocation of stuck) {
    if (!invocation.checkpointIntentId || !invocation.checkpointOwnerId) {
      report.failures.push({ invocationId: invocation.id, reasonCode: "GateWithoutOwner" });
      continue;
    }
    const freeze = readFreezeFromEvidence(invocation.checkpointPreparedEvidence);
    try {
      await abandon({
        tenantId: invocation.tenantId,
        invocationId: invocation.id,
        ownershipId: invocation.checkpointOwnerId,
        checkpointIntentId: invocation.checkpointIntentId,
        reasonCode: "CheckpointStale",
        ...(freeze ? { freeze } : {}),
      });
      report.abandoned += 1;
    } catch (error) {
      report.failures.push({
        invocationId: invocation.id,
        reasonCode: error instanceof Error ? error.message : "StuckGateAbandonFailed",
      });
    }
  }
  return report;
}

/**
 * 一条维护 tick 覆盖 R05 §5 命名的两类状态：`releasing` 资源与 `stuck gate`。
 * 顺序固定：先收口卡住的 Gate（可能产生新的 releasing），再续做解冻。
 */
export async function runCheckpointMaintenanceLane(
  input: {
    limit?: number;
    graceMs?: number;
    now?: Date;
    resolveBackend?: (binding: WorkspaceBinding) => Promise<WorkspaceBackend>;
  } = {},
): Promise<{
  stuckGates: StuckCheckpointGateReport;
  releases: CheckpointReleaseRecoveryReport;
}> {
  const stuckGates = await recoverStuckCheckpointGates(input);
  const releases = await recoverPendingCheckpointReleases(input);
  return { stuckGates, releases };
}
