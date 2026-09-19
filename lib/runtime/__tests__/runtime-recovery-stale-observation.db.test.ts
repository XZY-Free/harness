/**
 * R03 §5：失联/失败处理必须携带 observed tuple，并在根锁内复核。
 *
 * 覆盖三类真实交错（全部走真实 MySQL + 真实仓储/事务路径，无 mock）：
 * - OBS-01 观察到的 Owner 确实过期 → 正常收口：Owner/Session/Invocation 一起落 lost。
 * - OBS-02 同一代际在观察之后**续租**（lease 前移）→ 陈旧观察，不判 lost，Invocation 不变。
 * - OBS-03 代际已被**替换**（新 Owner 接管）→ 陈旧观察，新 Owner 与 Invocation 都不被改动。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  acquireTestRuntimeAuthority,
  createPreparedTakeoverAttempt,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { markInvocationLost, readObservedOwner } from "@/lib/runtime/application/runtime-recovery";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

async function seedAuthority(suffix: string) {
  // resetDatabase 会清掉 bootstrap 行，先恢复默认租户与 Governance/Policy baseline。
  await ensureDefaultTenant();
  const fixture = await seedPreparedRuntimeAttempt();
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  void suffix;
  return { fixture, acquired };
}

/**
 * 把一个仍 active 的代际置为「已过期」。
 *
 * 必须满足 `ExecutionOwnership_lease_expiry_shape`（`leaseExpiresAt > acquiredAt`）：
 * 所以用 `acquiredAt + 1ms` 作为到期时间——仍在 `acquiredAt` 之后，但早已早于 now。
 */
async function expireLease(tenantId: string, ownershipId: string): Promise<void> {
  const owner = await readOwner(tenantId, ownershipId);
  if (!owner) throw new Error(`ExecutionOwnership 不存在（id=${ownershipId}）`);
  const expiredAt = new Date(owner.acquiredAt.getTime() + 1);
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: expiredAt, lastHeartbeatAt: owner.acquiredAt, updatedAt: new Date() })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
}

async function readInvocationState(tenantId: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  return row;
}

async function readOwner(tenantId: string, ownershipId: string) {
  const [row] = await db
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    )
    .limit(1);
  return row;
}

async function readSession(tenantId: string, sessionBindingId: string) {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.id, sessionBindingId),
      ),
    )
    .limit(1);
  return row;
}

describe("Runtime recovery 陈旧观察防护（R03 §5）", () => {
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it("OBS-01: 观察到的 Owner 确实已过期 → Owner/Session/Invocation 一起收口为 lost", async () => {
    const { fixture, acquired } = await seedAuthority("obs-01");
    await expireLease(fixture.tenantId, acquired.ownership.id);
    const observed = await readObservedOwner({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(observed?.ownershipId).toBe(acquired.ownership.id);

    const result = await markInvocationLost({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      reasonCode: "heartbeat_stale",
      observedOwner: observed,
    });

    expect(result.outcome).toBe("lost");
    expect(result.staleReason).toBeUndefined();
    expect(result.sessionBinding?.bindingState).toBe("lost");
    expect((await readOwner(fixture.tenantId, acquired.ownership.id))?.ownershipState).toBe("lost");
    expect((await readSession(fixture.tenantId, acquired.session.id))?.bindingState).toBe("lost");
    expect(
      (await readInvocationState(fixture.tenantId, fixture.invocation.id))?.executionState,
    ).toBe("lost");
  });

  it("OBS-02: 同一代际在观察后已续租 → 陈旧观察，不判 lost，Invocation 不变", async () => {
    const { fixture, acquired } = await seedAuthority("obs-02");
    // 观察时该代际看似已过期。
    await expireLease(fixture.tenantId, acquired.ownership.id);
    const observed = await readObservedOwner({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    const beforeState = (await readInvocationState(fixture.tenantId, fixture.invocation.id))
      ?.executionState;
    // 观察之后 Owner 真实续租（lease/heartbeat 前移）——陈旧扫描必须失效。
    const renewedUntil = new Date(Date.now() + 600_000);
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: renewedUntil, lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
          eq(executionOwnershipTable.id, acquired.ownership.id),
        ),
      );

    const result = await markInvocationLost({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      reasonCode: "heartbeat_stale",
      observedOwner: observed,
    });

    expect(result.outcome).toBe("stale_observation");
    expect(result.staleReason).toBe("owner_renewed");
    expect(result.sessionBinding).toBeNull();
    expect((await readOwner(fixture.tenantId, acquired.ownership.id))?.ownershipState).toBe(
      "active",
    );
    expect((await readSession(fixture.tenantId, acquired.session.id))?.bindingState).not.toBe(
      "lost",
    );
    expect(
      (await readInvocationState(fixture.tenantId, fixture.invocation.id))?.executionState,
    ).toBe(beforeState);
  });

  it("OBS-03: 代际已被替换（新 Owner 接管）→ 只丢弃观察，新 Owner 与 Invocation 都不被改动", async () => {
    const { fixture, acquired } = await seedAuthority("obs-03");
    await expireLease(fixture.tenantId, acquired.ownership.id);
    const observed = await readObservedOwner({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(observed?.ownershipId).toBe(acquired.ownership.id);
    // 新代际真实接管：旧 Owner 过期 → 新 Attempt + 新 Ownership（真实 acquire 路径）。
    const takeoverAttempt = await createPreparedTakeoverAttempt({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    const takeover = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: takeoverAttempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
    });
    expect(takeover.ownership.id).not.toBe(acquired.ownership.id);

    const result = await markInvocationLost({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      reasonCode: "heartbeat_stale",
      observedOwner: observed,
    });

    expect(result.outcome).toBe("stale_observation");
    expect(result.staleReason).toBe("owner_replaced");
    expect(result.sessionBinding).toBeNull();
    // 新 Owner 仍是 Current，且没有被这次陈旧观察收口。
    const newOwner = await readOwner(fixture.tenantId, takeover.ownership.id);
    expect(newOwner?.ownershipState).toBe("active");
    expect(newOwner?.id).toBe(
      (
        await db
          .select({ id: executionOwnershipTable.id })
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, fixture.tenantId),
              eq(executionOwnershipTable.invocationId, fixture.invocation.id),
              eq(executionOwnershipTable.ownershipState, "active"),
            ),
          )
          .limit(1)
      )[0]?.id,
    );
    expect(
      (await readInvocationState(fixture.tenantId, fixture.invocation.id))?.executionState,
    ).not.toBe("lost");
  });
});
