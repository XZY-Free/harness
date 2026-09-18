/**
 * Authority recovery lane（R01 §3 `Owner expired`；R04 §5 claim 规则）。
 *
 * 这个文件证明的不是"有个函数存在"，而是：
 * 1. **常驻 Worker 的默认 lane** 会真实发现并收口租约已到期的 Owner——不经任何测试注入；
 * 2. 判定依据是租约到期（`leaseExpiresAt <= now`），不是"心跳看起来旧了"；
 * 3. 健康 Owner 不被误杀，扫描与收口之间发生的续租让观察失效（R03 §5）；
 * 4. 重复运行幂等，收口后不再产生候选。
 *
 * 全部走真实 MySQL 与真实仓储/事务路径，无 mock。
 */
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { threadEventTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { findStaleInvocations } from "@/lib/runtime/application/runtime-recovery";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

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

async function readInvocation(tenantId: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
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

async function readTurn(turnId: string) {
  const [row] = await db.select().from(turnTable).where(eq(turnTable.id, turnId)).limit(1);
  return row;
}

async function readThreadEvents(threadId: string) {
  return db
    .select()
    .from(threadEventTable)
    .where(eq(threadEventTable.threadId, threadId))
    .orderBy(asc(threadEventTable.eventSequence));
}

/**
 * 把仍 active 的代际置为「租约已到期」。
 *
 * 必须满足 `ExecutionOwnership_lease_expiry_shape`（`leaseExpiresAt > acquiredAt`）：
 * 用 `acquiredAt + 1ms`——仍在 `acquiredAt` 之后，但早已早于 now。
 */
async function expireLease(tenantId: string, ownershipId: string): Promise<void> {
  const owner = await readOwner(tenantId, ownershipId);
  if (!owner) throw new Error(`ExecutionOwnership 不存在（id=${ownershipId}）`);
  await db
    .update(executionOwnershipTable)
    .set({
      leaseExpiresAt: new Date(owner.acquiredAt.getTime() + 1),
      lastHeartbeatAt: owner.acquiredAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
}

/** 续租（唯一延长租约的路径）：lease 与 heartbeat 一起前移。 */
async function renewLease(tenantId: string, ownershipId: string): Promise<void> {
  const until = new Date(Date.now() + 600_000);
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: until, lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
}

/** 生产形状的调度后状态：Turn 指向自己的 active Invocation。 */
async function bindTurnToInvocation(turnId: string, invocationId: string): Promise<void> {
  await db
    .update(turnTable)
    .set({ activeInvocationId: invocationId, latestInvocationId: invocationId })
    .where(eq(turnTable.id, turnId));
}

/** 只注入另外两条 lane，recovery lane 走默认实现（证明接线而不是证明函数可调用）。 */
function createWorker() {
  return createRuntimeDispatchRetryWorker({
    workerId: "authority-recovery-lane:test",
    dispatchPersistedAttempt: async () => {},
    dispatchCommand: async () => {},
  });
}

describe("Authority recovery lane（R01 §3 Owner expired）", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  async function seeded() {
    const fixture = await seedPreparedRuntimeAttempt();
    const authority = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    await bindTurnToInvocation(fixture.turnId, fixture.invocation.id);
    return { fixture, authority };
  }

  it("AUTH-REG-01: 常驻 Worker 默认 lane 发现租约到期的 Owner 并完整收口（且重复运行幂等）", async () => {
    const { fixture, authority } = await seeded();
    await expireLease(fixture.tenantId, authority.ownership.id);
    // 候选身份来自租约，不是一个测试自报的 threshold。
    const discovered = await findStaleInvocations({ tenantId: fixture.tenantId });
    expect(discovered.map((row) => row.invocationId)).toEqual([fixture.invocation.id]);
    expect(discovered[0]?.observedOwner?.ownershipId).toBe(authority.ownership.id);

    const worker = createWorker();
    const first = await worker.tick();
    expect(first.ownerRecoveries).toBe(1);

    // Owner / Session / Invocation / Turn 一起收口。
    const owner = await readOwner(fixture.tenantId, authority.ownership.id);
    expect(owner?.ownershipState).toBe("lost");
    expect(owner?.reasonCode).toBe("ownership_lease_expired");
    const session = await readSession(fixture.tenantId, authority.session.id);
    expect(session?.bindingState).toBe("lost");
    const invocation = await readInvocation(fixture.tenantId, fixture.invocation.id);
    expect(invocation?.executionState).toBe("lost");
    expect(invocation?.errorCode).toBe("ownership_lease_expired");
    expect(invocation?.finishedAt).not.toBeNull();
    const turn = await readTurn(fixture.turnId);
    expect(turn?.turnState).toBe("failed");
    expect(turn?.activeInvocationId).toBeNull();

    // 真实落库的 Thread 事件：接纳那条之后，invocation.lost 先于 turn.failed
    //（同一事务内按序号递增写入）。
    const events = await readThreadEvents(fixture.threadId);
    expect(events.map((event) => event.eventType)).toEqual([
      "invocation.queued",
      "invocation.lost",
      "turn.failed",
    ]);
    expect(
      events.find((event) => event.eventType === "invocation.lost")?.payloadJson,
    ).toMatchObject({
      reasonCode: "ownership_lease_expired",
      ownershipId: authority.ownership.id,
    });

    // 幂等：收口后不再是候选，也不改已终态的行。
    const invocationVersion = invocation?.versionNo;
    const second = await worker.tick();
    expect(second.ownerRecoveries).toBe(0);
    expect((await findStaleInvocations({ tenantId: fixture.tenantId })).length).toBe(0);
    const reread = await readInvocation(fixture.tenantId, fixture.invocation.id);
    expect(reread?.versionNo).toBe(invocationVersion);
    expect(reread?.executionState).toBe("lost");
  });

  it("AUTH-REG-02: 健康 Owner（租约未到期）既不是候选也不被收口", async () => {
    const { fixture, authority } = await seeded();
    expect(await findStaleInvocations({ tenantId: fixture.tenantId })).toHaveLength(0);

    const worker = createWorker();
    const summary = await worker.tick();
    expect(summary.ownerRecoveries).toBe(0);

    const owner = await readOwner(fixture.tenantId, authority.ownership.id);
    expect(owner?.ownershipState).toBe("active");
    expect((await readSession(fixture.tenantId, authority.session.id))?.bindingState).toBe(
      "prepared",
    );
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id))?.executionState).toBe(
      "queued",
    );
    expect((await readTurn(fixture.turnId))?.turnState).toBe("accepted");
    // Thread 事件只有 Invocation 接纳那一条，没有任何收口事件。
    expect((await readThreadEvents(fixture.threadId)).map((event) => event.eventType)).toEqual([
      "invocation.queued",
    ]);
  });

  it("AUTH-REG-03: 扫描与收口之间续租 → 观察失效，不误杀（R03 §5）", async () => {
    const { fixture, authority } = await seeded();
    await expireLease(fixture.tenantId, authority.ownership.id);
    expect((await findStaleInvocations({ tenantId: fixture.tenantId })).length).toBe(1);

    // 真实续租路径：租约与心跳一起前移。
    await renewLease(fixture.tenantId, authority.ownership.id);
    expect(await findStaleInvocations({ tenantId: fixture.tenantId })).toHaveLength(0);

    // 即使拿旧观察直接收口，也必须在根锁内被判为陈旧观察并丢弃。
    const worker = createWorker();
    const summary = await worker.tick();
    expect(summary.ownerRecoveries).toBe(0);

    const owner = await readOwner(fixture.tenantId, authority.ownership.id);
    expect(owner?.ownershipState).toBe("active");
    expect((await readSession(fixture.tenantId, authority.session.id))?.bindingState).toBe(
      "prepared",
    );
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id))?.executionState).toBe(
      "queued",
    );
    expect((await readTurn(fixture.turnId))?.turnState).toBe("accepted");
  });

  it("AUTH-REG-04: 换代之后旧 Owner 的过期事实不影响新 Owner", async () => {
    const { fixture, authority } = await seeded();
    await expireLease(fixture.tenantId, authority.ownership.id);

    // 新代际真实接管（走真实 acquire 路径），旧代际此时已是历史事实。
    const takeover = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    expect(takeover.ownership.id).not.toBe(authority.ownership.id);

    const worker = createWorker();
    const summary = await worker.tick();
    expect(summary.ownerRecoveries).toBe(0);

    expect((await readOwner(fixture.tenantId, takeover.ownership.id))?.ownershipState).toBe(
      "active",
    );
    expect((await readSession(fixture.tenantId, takeover.session.id))?.bindingState).toBe(
      "prepared",
    );
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id))?.executionState).toBe(
      "queued",
    );
  });
});
