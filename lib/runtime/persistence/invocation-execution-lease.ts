import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { and, eq } from "drizzle-orm";

export const INVOCATION_EXECUTION_LEASE_MS = 60_000;

/**
 * 在锁住父 Invocation 的事务中获取执行权。新鲜 active lease 不被抢占；过期 lease
 * 标记 lost 后才能新建 epoch，防止首次 Loop 与 Continuation Worker 双跑。
 */
export async function tryAcquireInvocationExecutionLease(params: {
  tenantId: string;
  invocationId: string;
  ownerRef: string;
  now?: Date;
}): Promise<{ id: string } | null> {
  const now = params.now ?? new Date();
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select({ id: invocationTable.id })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.id, params.invocationId),
          eq(invocationTable.tenantId, params.tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (!invocation) return null;
    const rows = await tx
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.invocationId, params.invocationId))
      .for("update");
    const active = rows.find((row) => row.ownershipState === "active");
    if (active) {
      const lastAliveAt = active.lastHeartbeatAt ?? active.acquiredAt;
      if (lastAliveAt.getTime() + INVOCATION_EXECUTION_LEASE_MS > now.getTime()) return null;
      await tx
        .update(executionOwnershipTable)
        .set({ ownershipState: "lost", releasedAt: now })
        .where(
          and(
            eq(executionOwnershipTable.id, active.id),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        );
    }
    const id = randomUUID();
    const nextEpoch = rows.reduce((max, row) => Math.max(max, row.leaseEpoch), 0) + 1;
    await tx.insert(executionOwnershipTable).values({
      id,
      invocationId: params.invocationId,
      deviceId: null,
      environmentLeaseId: null,
      ownershipState: "active",
      leaseEpoch: nextEpoch,
      acquiredAt: now,
      lastHeartbeatAt: now,
    });
    // ownerRef 只进入调用侧结构化日志，不复用 deviceId 冒充设备身份。
    void params.ownerRef;
    return { id };
  });
}

export async function renewInvocationExecutionLease(params: {
  invocationId: string;
  leaseId: string;
  now?: Date;
}): Promise<boolean> {
  const result = await db
    .update(executionOwnershipTable)
    .set({ lastHeartbeatAt: params.now ?? new Date() })
    .where(
      and(
        eq(executionOwnershipTable.id, params.leaseId),
        eq(executionOwnershipTable.invocationId, params.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    );
  return result[0].affectedRows === 1;
}

export async function releaseInvocationExecutionLease(params: {
  invocationId: string;
  leaseId: string;
  now?: Date;
}): Promise<void> {
  const result = await db
    .update(executionOwnershipTable)
    .set({ ownershipState: "released", releasedAt: params.now ?? new Date() })
    .where(
      and(
        eq(executionOwnershipTable.id, params.leaseId),
        eq(executionOwnershipTable.invocationId, params.invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    );
  if (result[0].affectedRows !== 1) throw new Error("INVOCATION_EXECUTION_LEASE_LOST");
}
