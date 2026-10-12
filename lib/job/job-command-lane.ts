/**
 * JobCommand lane（R01 §3 第 8 行、R01 §4）。
 *
 * 事实源：
 * - docs/topic02/nexharness-topic02-closure/repairs/01-production.md §3/§4
 *
 * 规则：
 * - `JobCommand queued / waiting / dispatched(lease 过期)` 都是**已持久**的可发现状态；
 *   初始 API 进程死亡不影响平台侧继续消费这些命令。
 * - 扫描只取候选 ID；领取时在命令自己的事务里按对象所属根重验 due/state/lease。
 * - 完成确认带原 claim 身份：只有仍持有该 lease 的 Worker 才会收口自己领取的那次执行；
 *   被抢走的 lease 不会被旧 Worker 覆盖。
 * - `nextAttemptAt` 由 schema 保证 NOT NULL；但若它被写在"不合理的未来"（超过静默窗口），
 *   仍视为到期候选，避免"已经持久但进程在填 retry 时间前 Crash"的工作永久不可见。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { consumeJobCommand } from "@/lib/job/job-command-consumer";
import { type JobCommand, jobCommandTable } from "@/lib/persistence/schema/job";
import { and, asc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";

/**
 * `nextAttemptAt` 落在如此远的未来即视为"异常时间戳"，按到期处理而不是静默等待。
 * 这些命令通常在进程写完 retry 时间前 Crash 时留下。
 */
export const JOB_COMMAND_STUCK_GRACE_MS = 30_000;

export interface JobCommandClaim {
  command: JobCommand;
  /** 领取身份：完成确认必须带同一个值。 */
  claimId: string;
}

/** 统一的"到期"判据（扫描与领取共用同一语义，避免两套规则漂移）。 */
function isDueNow(
  command: Pick<JobCommand, "commandState" | "nextAttemptAt" | "leaseExpiresAt">,
  now: Date,
): boolean {
  if (command.commandState === "acknowledged" || command.commandState === "rejected") return false;
  const leaseFree = !command.leaseExpiresAt || command.leaseExpiresAt.getTime() <= now.getTime();
  if (!leaseFree) return false;
  if (command.commandState === "dispatched") return true;
  const due = command.nextAttemptAt.getTime() <= now.getTime();
  const stuck = command.nextAttemptAt.getTime() > now.getTime() + JOB_COMMAND_STUCK_GRACE_MS;
  return due || stuck;
}

/** 候选扫描：只取 ID。 */
export async function scanDueJobCommands(input: { now: Date; limit: number }): Promise<string[]> {
  const stuckThreshold = new Date(input.now.getTime() + JOB_COMMAND_STUCK_GRACE_MS);
  const rows = await db
    .select({ id: jobCommandTable.id })
    .from(jobCommandTable)
    .where(
      and(
        inArray(jobCommandTable.commandState, ["queued", "waiting", "dispatched"]),
        // 没有有效 lease：从未被领取（NULL）或 lease 已过期。
        or(isNull(jobCommandTable.leaseExpiresAt), lte(jobCommandTable.leaseExpiresAt, input.now)),
        or(
          // dispatched 的到期只由 lease 决定。
          eq(jobCommandTable.commandState, "dispatched"),
          // queued/waiting 到点，或 nextAttemptAt 落在异常的未来（静默窗口）。
          lte(jobCommandTable.nextAttemptAt, input.now),
          gt(jobCommandTable.nextAttemptAt, stuckThreshold),
        ),
      ),
    )
    .orderBy(asc(jobCommandTable.nextAttemptAt))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

/**
 * 领取一条命令：在命令自己的事务里重验状态与 lease，写 lease 后返回。
 * 已被其他 Worker 有效持有（lease 未过期）时返回 null。
 */
export async function claimJobCommand(input: {
  commandId: string;
  leaseOwner: string;
  leaseDurationMs: number;
  now: Date;
}): Promise<JobCommandClaim | null> {
  const claimId = `${input.leaseOwner}:${randomUUID()}`;
  return db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, input.commandId))
      .for("update")
      .limit(1);
    if (!command) return null;
    if (!isDueNow(command, input.now)) return null;
    await tx
      .update(jobCommandTable)
      .set({
        commandState: "dispatched",
        leaseOwner: claimId,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseDurationMs),
        deliveryCount: command.deliveryCount + 1,
        versionNo: command.versionNo + 1,
        updatedAt: input.now,
      })
      .where(eq(jobCommandTable.id, command.id));
    const [claimed] = await tx
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, command.id))
      .limit(1);
    if (!claimed) throw new Error("JobCommand 领取后回查失败");
    return { command: claimed, claimId };
  });
}

/**
 * 收口时释放**自己**的 lease。被抢走的 lease 不会被覆盖（claimId 不匹配即影响 0 行）。
 */
export async function releaseJobCommandClaim(input: {
  commandId: string;
  claimId: string;
  now: Date;
}): Promise<void> {
  await db
    .update(jobCommandTable)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: input.now })
    .where(
      and(eq(jobCommandTable.id, input.commandId), eq(jobCommandTable.leaseOwner, input.claimId)),
    );
}

export interface JobCommandLaneSummary {
  scanned: number;
  consumed: number;
  waiting: number;
  rejected: number;
  deferred: number;
  failed: number;
}

/**
 * 消费一轮到期命令。
 *
 * - 单条失败不阻断同轮其它命令（`failed` 计数并保留 lease，由 lease 过期提供退避）。
 * - 成功收口（含 waiting/rejected）后立即释放自己的 lease，避免无谓等待。
 */
export async function runDueJobCommands(input: {
  leaseOwner: string;
  leaseDurationMs: number;
  limit: number;
  now?: Date;
}): Promise<JobCommandLaneSummary> {
  const now = input.now ?? new Date();
  const candidates = await scanDueJobCommands({ now, limit: input.limit });
  const summary: JobCommandLaneSummary = {
    scanned: candidates.length,
    consumed: 0,
    waiting: 0,
    rejected: 0,
    deferred: 0,
    failed: 0,
  };
  for (const commandId of candidates) {
    const claim = await claimJobCommand({
      commandId,
      leaseOwner: input.leaseOwner,
      leaseDurationMs: input.leaseDurationMs,
      now: new Date(),
    });
    if (!claim) {
      summary.deferred += 1;
      continue;
    }
    try {
      const result = await consumeJobCommand({
        tenantId: claim.command.tenantId,
        commandId: claim.command.id,
      });
      if (
        result.outcome === "terminal_applied" ||
        result.outcome === "terminal_replayed" ||
        result.outcome === "cancelled" ||
        result.outcome === "retry_created"
      ) {
        summary.consumed += 1;
      } else if (
        result.outcome === "waiting_external" ||
        result.outcome === "waiting_invocations"
      ) {
        summary.waiting += 1;
      } else {
        summary.rejected += 1;
      }
      await releaseJobCommandClaim({
        commandId: claim.command.id,
        claimId: claim.claimId,
        now: new Date(),
      });
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
