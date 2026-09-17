/**
 * Workspace Writer 物理释放 lane（R04 §3 / §5）。
 *
 * I 根事务（Runtime Ingress 终态/暂停、Owner 关闭、takeover）**只**失效 Authority、
 * 关闭 Session；Writer 的物理撤销由本模块的持久 lane 按 W→I 顺序处理：
 *
 * 1. 扫描只取候选 ID（`scanWorkspaceWriteLocksNeedingRelease`）；
 * 2. 领取时重新读对象自身状态并复验"父 Owner 已失权"（`claimWorkspaceWriterRelease`）；
 * 3. 事务外调用 Backend 真实停止并排空该代际 Writer，取得可核验回执；
 * 4. 回到 W→I 事务提交 `released` 并保留回执；若期间已被新 generation 接管，
 *    则**不改本行**（Backend 接管流程本身已停止旧 Writer）只回报 `superseded`。
 *
 * 可见性来自持久状态，不依赖任何定时器：进程在写 `releaseNextAttemptAt` 之前 Crash，
 * 该行下一轮仍会被扫到。失败保持 `releasing` + 退避，超限打日志告警（dead-letter 语义）。
 */
import { logger } from "@/lib/logger";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { resolveManagedWorkspaceHost } from "@/lib/workspace/managed-workspace-host";
import type { WorkspaceHost } from "@/lib/workspace/workspace-host";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import {
  WORKSPACE_RELEASE_BACKOFF_MS,
  WORKSPACE_RELEASE_RECHECK_MS,
  claimWorkspaceWriterRelease,
  completeWorkspaceWriterRelease,
  recordWorkspaceWriterReleaseFailure,
  releaseWorkspaceWriterClaim,
  scanWorkspaceWriteLocksNeedingRelease,
} from "@/lib/workspace/workspace-write-lock-queries";

/** 超过该尝试次数仍无法回收 → dead-letter 告警（不静默）。 */
export const WORKSPACE_RELEASE_DEAD_LETTER_ATTEMPTS = WORKSPACE_RELEASE_BACKOFF_MS.length + 1;

export type WorkspaceWriterReleaseOutcome =
  | { outcome: "released"; lockId: string; reasonCode: string }
  | { outcome: "superseded"; lockId: string; reasonCode: string }
  | {
      outcome: "retry_scheduled";
      lockId: string;
      errorCode: string;
      releaseAttemptCount: number;
    }
  | {
      outcome: "skipped";
      lockId: string;
      reason: "not_found" | "already_released" | "healthy_owner" | "claimed_elsewhere";
    };

export interface WorkspaceWriterReleaseDeps {
  now?: Date;
  /** 受管 WorkspaceHost 解析（缺省走生产解析：RPC / env root）。 */
  resolveHost?: (binding: WorkspaceBinding) => Promise<WorkspaceHost>;
}

async function defaultResolveHost(binding: WorkspaceBinding): Promise<WorkspaceHost> {
  return resolveManagedWorkspaceHost(binding);
}

/** 处理一条 Writer 释放工作。幂等：可被任意 Worker 在任意时刻重复调用。 */
export async function runWorkspaceWriterRelease(input: {
  tenantId: string;
  lockId: string;
  leaseOwner: string;
  deps?: WorkspaceWriterReleaseDeps;
}): Promise<WorkspaceWriterReleaseOutcome> {
  const now = input.deps?.now ?? new Date();
  const claim = await claimWorkspaceWriterRelease({
    tenantId: input.tenantId,
    lockId: input.lockId,
    leaseOwner: input.leaseOwner,
    now,
  });
  if (claim.outcome === "skipped") {
    await releaseWorkspaceWriterClaim({
      tenantId: input.tenantId,
      lockId: input.lockId,
      leaseOwner: input.leaseOwner,
      now,
      nextAttemptAt: new Date(now.getTime() + WORKSPACE_RELEASE_RECHECK_MS),
    }).catch(() => undefined);
    return { outcome: "skipped", lockId: input.lockId, reason: claim.reason };
  }
  const lock = claim.lock;
  const reasonCode = lock.releaseReasonCode ?? "writer_owner_no_longer_current";
  if (!lock.workspaceBindingId || (!lock.backendGrantRef && !lock.backendOperationId)) {
    // 从未真正授予过 Writer（预留后未走到 Backend 激活）：控制面直接收口。
    await completeWorkspaceWriterRelease({
      tenantId: input.tenantId,
      lockId: lock.id,
      leaseOwner: input.leaseOwner,
      reasonCode,
      releaseReceipt: { mode: "no_backend_writer", releasedAt: now.toISOString() },
      now,
    });
    return { outcome: "released", lockId: lock.id, reasonCode };
  }
  try {
    const binding = await getWorkspaceBindingById(input.tenantId, lock.workspaceBindingId);
    if (!binding) {
      throw new Error("WorkspaceBindingMissing");
    }
    const host = await (input.deps?.resolveHost ?? defaultResolveHost)(binding);
    const evidence = await host.revokeWriterGeneration(
      lock.storageScopeDigest,
      lock.writerGeneration,
    );
    if (!evidence.stopped || !evidence.processGroupEmpty) {
      throw new Error("WorkspaceWriterStopUnverified");
    }
    const completed = await completeWorkspaceWriterRelease({
      tenantId: input.tenantId,
      lockId: lock.id,
      leaseOwner: input.leaseOwner,
      reasonCode,
      releaseReceipt: evidence,
      now,
    });
    if (completed.outcome === "not_owner") {
      return { outcome: "skipped", lockId: lock.id, reason: "claimed_elsewhere" };
    }
    return {
      outcome: completed.outcome === "superseded" ? "superseded" : "released",
      lockId: lock.id,
      reasonCode,
    };
  } catch (error) {
    const errorCode = error instanceof Error ? error.name : "WorkspaceWriterReleaseFailed";
    await recordWorkspaceWriterReleaseFailure({
      tenantId: input.tenantId,
      lockId: lock.id,
      leaseOwner: input.leaseOwner,
      errorCode,
      now,
    });
    if (claim.releaseAttemptCount >= WORKSPACE_RELEASE_DEAD_LETTER_ATTEMPTS) {
      logger.error("[workspace-writer-release] Writer 释放反复失败，进入告警（dead-letter）", {
        tenantId: input.tenantId,
        lockId: lock.id,
        releaseAttemptCount: claim.releaseAttemptCount,
        errorCode,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      outcome: "retry_scheduled",
      lockId: lock.id,
      errorCode,
      releaseAttemptCount: claim.releaseAttemptCount,
    };
  } finally {
    // 领取权无论结果如何都要归还，避免崩溃前的长尾占用。
    // 失败退避已由 recordWorkspaceWriterReleaseFailure 写入，这里不覆盖。
    await releaseWorkspaceWriterClaim({
      tenantId: input.tenantId,
      lockId: input.lockId,
      leaseOwner: input.leaseOwner,
      now,
    }).catch(() => undefined);
  }
}

/** 单轮：按持久状态发现并处理所有到期 Writer 释放工作。 */
export async function runDueWorkspaceWriterReleases(input: {
  leaseOwner: string;
  limit?: number;
  now?: Date;
  tenantId?: string;
  deps?: WorkspaceWriterReleaseDeps;
}): Promise<{
  scanned: number;
  released: number;
  superseded: number;
  retried: number;
  skipped: number;
}> {
  const now = input.now ?? new Date();
  const limit = input.limit ?? 20;
  const candidates = await scanWorkspaceWriteLocksNeedingRelease({
    now,
    limit,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
  let released = 0;
  let superseded = 0;
  let retried = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const outcome = await runWorkspaceWriterRelease({
      tenantId: candidate.tenantId,
      lockId: candidate.lockId,
      leaseOwner: input.leaseOwner,
      ...(input.deps ? { deps: input.deps } : {}),
    });
    if (outcome.outcome === "released") released += 1;
    else if (outcome.outcome === "superseded") superseded += 1;
    else if (outcome.outcome === "retry_scheduled") retried += 1;
    else skipped += 1;
  }
  return { scanned: candidates.length, released, superseded, retried, skipped };
}
