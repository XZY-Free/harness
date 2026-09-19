/**
 * AUTH-01..09（R03 / R04 / R08）：当前执行权（ExecutionOwnership）的完整语义与并发安全。
 *
 * 编号严格对应 `docs/topic02/nexharness-topic02-closure/acceptance/auth.md` 的 9 条场景与
 * 「必须断言」。所有事实都在**真实 MySQL** 上产生并回读；并发用例使用第二条真实连接
 * （独立 pool），并在事务内回读 `CONNECTION_ID()`，把"两个独立连接"变成可断言的事实，
 * 而不是靠"同一个 pool 借出了两条连接"这种实现细节推断。
 *
 * 与 `execution-ownership.db.test.ts`（FENCE-* 系列）的分工：
 * FENCE-* 验证单点围栏事实（一次 Acquire 只能有一个赢家、单活唯一约束、Token 失效等）。
 * AUTH-* 验证**按阶段/按根线性化**的完整语义——Renew 必须按 Owner phase 判定、终态
 * Invocation 必须拒绝一切新执行权、失联结论必须是"陈旧观察只丢弃"、跨 Invocation 关闭
 * 必须被拒、W→I 交接与 I 根终态并发时不得出现反向锁。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DbOrTx, db } from "@/lib/db/client";
import { buildDrizzle, resetDatabase } from "@/lib/db/test/mysql-harness";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnership,
  acquireExecutionOwnershipInTransaction,
  closeExecutionOwnership,
  getActiveExecutionOwnership,
  renewExecutionOwnership,
  renewExecutionOwnershipInTransaction,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  type ExecutionOwnership,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { workspaceWriteLock } from "@/lib/persistence/schema/workspace-lock";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  findStaleInvocations,
  markInvocationLost,
  readObservedOwner,
} from "@/lib/runtime/application/runtime-recovery";
import { failAttemptAndInvokeRecoveryAuthority } from "@/lib/runtime/retry/dispatch-queued-invocation-attempt";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { type WorkspaceBackend, createWorkspaceBackend } from "@/lib/workspace/workspace-backend";
import { computeWorkspaceContractDigest } from "@/lib/workspace/workspace-contract";
import { createWorkspaceHostBroker } from "@/lib/workspace/workspace-host-server";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import {
  type AcquireWorkspaceWriteLockResult,
  type ReserveWorkspaceWriterOutcome,
  activateWorkspaceWriter,
  claimWorkspaceWriterRelease,
  reserveWorkspaceWriter,
  reserveWorkspaceWriterInTransaction,
} from "@/lib/workspace/workspace-write-lock-queries";
import {
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { runWorkspaceWriterRelease } from "@/lib/workspace/workspace-writer-release";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

const INGRESS_CAPABILITIES = ["event_stream"];

const filesystemSemantics = {
  kind: "desktop",
  caseSensitive: true,
  symlinks: true,
  permissions: true,
  hardlinks: true,
  specialFiles: false,
  xattrsAcl: true,
  mtime: "preserved",
} as const;

type Fixture = Awaited<ReturnType<typeof seedPreparedRuntimeAttempt>>;
type Acquired = Awaited<ReturnType<typeof acquireTestRuntimeAuthority>>;

// ─── 第二条真实连接 ────────────────────────────────────────────────────────
//
// 并发义务要求"两个独立 MySQL 连接"。这里显式建第二条 pool，并在事务内回读
// `CONNECTION_ID()`，把"两条连接"从实现细节变成可断言的事实。

let second: ReturnType<typeof buildDrizzle> | null = null;

function secondDb(): typeof db {
  if (!second) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL 未注入（globalSetup 未运行？）");
    second = buildDrizzle(url);
  }
  return second.db as unknown as typeof db;
}

async function connectionIdOf(executor: { execute: (query: string) => unknown }): Promise<number> {
  const [rows] = (await executor.execute("SELECT CONNECTION_ID() AS id")) as unknown as [
    Record<string, unknown>[],
  ];
  return Number(rows[0]?.id);
}

/** 真实屏障：所有参与方都到达后一起放行（不靠 sleep、也不靠"先后顺序碰巧"）。 */
function createBarrier(parties: number) {
  let arrived = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await gate;
  };
}

// ─── Authority 辅助 ────────────────────────────────────────────────────────

async function readOwner(tenantId: string, ownershipId: string): Promise<ExecutionOwnership> {
  const [current] = await db
    .select()
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownershipId),
      ),
    );
  if (!current) throw new Error(`Owner 不存在：${ownershipId}`);
  return current;
}

async function readAttempt(tenantId: string, attemptId: string) {
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(
      and(eq(invocationAttemptTable.tenantId, tenantId), eq(invocationAttemptTable.id, attemptId)),
    );
  if (!row) throw new Error(`Attempt 不存在：${attemptId}`);
  return row;
}

async function countActiveOwners(tenantId: string, invocationId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(executionOwnershipTable)
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.invocationId, invocationId),
        eq(executionOwnershipTable.ownershipState, "active"),
      ),
    );
  return Number(row?.total ?? 0);
}

async function readInvocation(tenantId: string, invocationId: string) {
  const [row] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)));
  if (!row) throw new Error(`Invocation 不存在：${invocationId}`);
  return row;
}

/** 让某个 Owner 的租约真正过期（同时满足 `leaseExpiresAt > acquiredAt` 的 CHECK）。 */
async function expireOwner(tenantId: string, ownership: ExecutionOwnership): Promise<Date> {
  const expiredAt = new Date(ownership.acquiredAt.getTime() + 1);
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: expiredAt, updatedAt: new Date() })
    .where(
      and(
        eq(executionOwnershipTable.tenantId, tenantId),
        eq(executionOwnershipTable.id, ownership.id),
      ),
    );
  return expiredAt;
}

/** 为同一 Invocation 准备下一个合法 Attempt（换实例必须新建 Attempt）。 */
async function seedReplacementAttempt(fixture: Fixture): Promise<string> {
  const attempt = await createAttempt({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
  });
  const evidence = {
    kind: "auth-replacement-candidate",
    invocationId: fixture.invocation.id,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return attempt.id;
}

/** 逻辑执行已在远端运行——与 Owner 自身是否还在 dispatch 窗口无关。 */
async function markInvocationRunning(fixture: Fixture) {
  await db
    .update(invocationTable)
    .set({ executionState: "running", updatedAt: new Date() })
    .where(
      and(
        eq(invocationTable.tenantId, fixture.tenantId),
        eq(invocationTable.id, fixture.invocation.id),
      ),
    );
}

async function setOwnershipFields(
  ownershipId: string,
  values: Partial<typeof executionOwnershipTable.$inferInsert>,
) {
  await db
    .update(executionOwnershipTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(executionOwnershipTable.id, ownershipId));
}

// ─── Workspace / Writer 辅助（AUTH-07/08/09）───────────────────────────────

const checkpointPolicy = {
  safePointTimeoutSeconds: 120,
  chunkBytes: 4_194_304,
  maxTotalBytes: "10737418240",
  maxEntries: 100_000,
  trigger: "before_suspend_and_explicit" as const,
  retention: "retain_while_referenced" as const,
};

async function createManagedBinding(input: { root: string }) {
  const probe = await createWorkspaceHostBroker({ root: input.root }).probeIdentity();
  const logical = await createWorkspace({
    tenantId: TENANT_ID,
    workspaceKey: `auth-${randomUUID()}`,
    displayName: "AUTH fixture",
  });
  const binding = await createWorkspaceBinding({
    tenantId: TENANT_ID,
    workspaceId: logical.id,
    continuityMode: "CHECKPOINT_RESTORABLE",
    bindingType: "sandbox",
    deviceId: null,
    locationRef: `managed://auth-${randomUUID()}`,
    storageScopeDigest: probe.scopeDigest,
    backendKind: "managed_host",
    hostIdentity: probe.hostIdentity,
    storageIdentity: probe.storageIdentity,
    accessMode: "read_write",
    filesystemSemantics,
    checkpointPolicy,
    contractDigest: computeWorkspaceContractDigest({
      bindingId: "fixture",
      continuityMode: "CHECKPOINT_RESTORABLE",
      storageScopeDigest: probe.scopeDigest,
      hostIdentity: probe.hostIdentity,
      storageIdentity: probe.storageIdentity,
      backendKind: "managed_host",
      filesystemSemantics,
      checkpointPolicy,
    }),
    createdBy: "test-service",
  });
  return { binding, probe };
}

/** 记录本用例创建的临时根，afterAll 统一清理。 */
let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "snowharness-authority-"));
  roots.push(created);
  return created;
}

async function readLock(lockId: string, executor: DbOrTx = db) {
  const [row] = await executor
    .select()
    .from(workspaceWriteLock)
    .where(and(eq(workspaceWriteLock.tenantId, TENANT_ID), eq(workspaceWriteLock.id, lockId)));
  return row ?? null;
}

async function countLocksForScope(storageScopeDigest: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`COUNT(*)` })
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, TENANT_ID),
        eq(workspaceWriteLock.storageScopeDigest, storageScopeDigest),
      ),
    );
  return Number(row?.total ?? 0);
}

/**
 * 经**真实 Ingress**把一个 Invocation 推到 executing。
 *
 * 时序与生产一致：Start 在派发前就固定激活证据（此时 phase 仍是 `dispatching`），
 * `execution.started` 被接纳时才由 applyLifecycle 推到 executing。
 */
async function pushIngressStarted(input: { fixture: Fixture; acquired: Acquired }) {
  const { fixture, acquired } = input;
  // 镜像生产激活事务（`runtime-start.ts`）：`executionPhase` 仍是 dispatching，同一次写入里
  // 固定 **workspaceWriterGeneration** + activationEvidence/Digest/activatedAt。缺前者会让
  // Ingress 的 Authority 复核（正确地）判 WorkspaceWriterNotFenced —— 平台执行必须被真实
  // Writer 围栏住，不能只有一份"我激活过了"的自述。
  const [activeLock] = await db
    .select({ writerGeneration: workspaceWriteLock.writerGeneration })
    .from(workspaceWriteLock)
    .where(
      and(
        eq(workspaceWriteLock.tenantId, TENANT_ID),
        eq(workspaceWriteLock.holderOwnershipId, acquired.ownership.id),
        eq(workspaceWriteLock.lockState, "active"),
      ),
    )
    .limit(1);
  const activationEvidence = {
    kind: "auth-ingress-activated",
    ownershipId: acquired.ownership.id,
    writerGeneration: activeLock?.writerGeneration ?? null,
  };
  await setOwnershipFields(acquired.ownership.id, {
    workspaceWriterGeneration: activeLock?.writerGeneration ?? null,
    activationEvidence,
    activationDigest: protocolDigest(activationEvidence),
    activatedAt: new Date(),
  });
  const semanticRequest = { invocationId: fixture.invocation.id, fixture: "auth-ingress" };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `runtime-session:${acquired.session.id}`;
  const remoteExecutionRef = `runtime-execution:${fixture.invocation.id}`;
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: INGRESS_CAPABILITIES,
  });
  await applyRuntimeSessionDispatchForTest(TENANT_ID, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  await ingressRuntimeEvents({
    tenantId: TENANT_ID,
    invocationId: fixture.invocation.id,
    batch: {
      protocolVersion: 3,
      authority: acquired.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: "1",
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: acquired.session.startIntentKey,
            semanticRequestDigest,
            remoteSessionRef,
            remoteExecutionRef,
            capabilitiesDigest,
          },
        },
      ],
    },
  });
  const resultDigest = protocolDigest({ fixture: "auth-ingress", terminal: true });
  return {
    /** 经真实 Ingress 提交终态（sequence=2，紧跟 execution.started）。 */
    complete: () =>
      ingressRuntimeEvents({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: acquired.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: "2",
              type: "execution.completed",
              schemaVersion: 1,
              payload: { resultRef: "artifact://auth/result", resultDigest },
            },
          ],
        },
      }),
  };
}

describe("ExecutionAuthority semantics（R03/R04/R08）", () => {
  beforeAll(() => {
    process.env.WORKLOAD_SIGNING_KEY_ID = "test-execution-authority-key";
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
    roots = [];
  });

  afterAll(async () => {
    await second?.pool.end();
    second = null;
    for (const created of roots) {
      await rm(created, { recursive: true, force: true }).catch(() => undefined);
    }
    roots = [];
  });

  // ── AUTH-01 ───────────────────────────────────────────────────────────────
  it("AUTH-01: 旧 Attempt 的失败处理延迟到新 Owner 已健康接管——陈旧失败不把新 Owner/Invocation 置 lost", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 失败处理的观察事实在**旧 Owner 还活着**的时候就被捕获。
    const staleObservation = await readObservedOwner({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(staleObservation?.ownershipId).toBe(first.ownership.id);

    // 旧代际租约到期 → 新 Attempt 经真实 Acquire 接管，且处于健康状态。
    await expireOwner(fixture.tenantId, first.ownership);
    const takeover = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: await seedReplacementAttempt(fixture),
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    expect(takeover.ownership.leaseEpoch).toBe(first.ownership.leaseEpoch + 1);
    const healthy = await readOwner(fixture.tenantId, takeover.ownership.id);
    expect(healthy.ownershipState).toBe("active");

    // (a) 迟到结论携带的是**旧 tuple**：根锁内复核必须判为已被替换，只丢弃。
    const delayed = await markInvocationLost({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      reasonCode: "old_attempt_dispatch_failed",
      observedOwner: staleObservation,
    });
    expect(delayed.outcome).toBe("stale_observation");
    expect(delayed.staleReason).toBe("owner_replaced");
    expect(delayed.invocationLostEvent).toBeNull();
    expect(delayed.turnFailedEvent).toBeNull();
    // 新 Owner 逐字段不动，Invocation 也不是终态。
    expect(await readOwner(fixture.tenantId, takeover.ownership.id)).toEqual(healthy);
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id)).executionState).toBe(
      "queued",
    );

    // (b) 生产入口：旧 Attempt 的失败收口走 `failAttemptAndInvokeRecoveryAuthority`
    // （内部重新读当前 Owner）。新 Owner 健康 → 仍必须只丢弃，不把整个 Invocation 判 lost。
    const failedAttempt = await failAttemptAndInvokeRecoveryAuthority({
      tenantId: fixture.tenantId,
      attempt: fixture.attempt,
      invocation: fixture.invocation,
      errorCode: "RuntimeDispatchFailed",
      errorSummary: "auth-01 delayed failure",
      now: new Date(),
    });
    expect(failedAttempt.id).toBe(fixture.attempt.id);
    expect(await readOwner(fixture.tenantId, takeover.ownership.id)).toEqual(healthy);
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id)).executionState).toBe(
      "queued",
    );
    // 旧 Attempt 只被自己收口（接管时已判 lost），不越权动新代际。
    expect((await readAttempt(fixture.tenantId, fixture.attempt.id)).attemptState).toBe("lost");
    expect(await countActiveOwners(fixture.tenantId, fixture.invocation.id)).toBe(1);
  });

  // ── AUTH-02 ───────────────────────────────────────────────────────────────
  it("AUTH-02: stale 扫描得到 Owner1 后其 Heartbeat 先续租——失联事务复核 expiry，不误杀健康 Owner", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const original = acquired.ownership;

    // 扫描的判定时刻与收口的判定时刻**不是同一个 DB 时刻**（生产里扫描默认用 Node 时钟
    // `new Date()`，续租与收口用 DB 时钟）。把扫描的 now 注入为领先值即可复现该偏差：
    // 扫描按它自己的时刻认为该行已到期，而按 DB 时刻它可以合法续租。
    const scanNow = new Date(original.leaseExpiresAt.getTime() + 1_000);
    const candidates = await findStaleInvocations({ tenantId: fixture.tenantId, now: scanNow });
    const observed =
      candidates.find((row) => row.invocationId === fixture.invocation.id)?.observedOwner ?? null;
    expect(observed?.ownershipId).toBe(original.id);

    // 在这份观察被收口之前，Owner1 通过真实续租把租约与心跳一起前移。
    const renewed = await renewExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: original.id,
      attemptId: original.attemptId,
      leaseEpoch: original.leaseEpoch,
    });
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(observed!.leaseExpiresAt.getTime());
    expect(renewed.lastHeartbeatAt.getTime()).toBeGreaterThan(observed!.lastHeartbeatAt.getTime());

    // 迟到的失联收口：根锁内复核 expiry → 观察已失效，不判 lost。
    const result = await markInvocationLost({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      reasonCode: "dispatch_retry_exhausted",
      observedOwner: observed,
    });
    expect(result.outcome).toBe("stale_observation");
    expect(result.staleReason).toBe("owner_renewed");
    const survived = await readOwner(fixture.tenantId, original.id);
    expect(survived).toEqual(renewed);
    expect(survived.ownershipState).toBe("active");
    expect((await readInvocation(fixture.tenantId, fixture.invocation.id)).executionState).toBe(
      "queued",
    );

    // 反向确认这个 Owner 确实健康：按**真实 DB 时刻**扫描时它不是候选。
    expect(await findStaleInvocations({ tenantId: fixture.tenantId })).toEqual([]);

    // 而真正过期的 Owner 仍必须被判为候选——"复核 expiry"不能把收口能力一起削弱。
    await expireOwner(fixture.tenantId, survived);
    const expired = await findStaleInvocations({ tenantId: fixture.tenantId });
    expect(expired.map((row) => row.invocationId)).toContain(fixture.invocation.id);
  });

  // ── AUTH-03 ───────────────────────────────────────────────────────────────
  it("AUTH-03: 逻辑 Invocation 仍 running 而新 Owner 处于 dispatching——按 Owner phase 拒绝，不因 Invocation running 无限续租", async () => {
    /** 造一个"逻辑执行已经在跑、但 Owner 仍在 dispatch 窗口且 deadline 已过"的代际。 */
    const seedWindowOwner = async (phase: "activating" | "dispatching") => {
      const fixture = await seedPreparedRuntimeAttempt();
      const acquired = await acquireTestRuntimeAuthority({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      await markInvocationRunning(fixture);
      await setOwnershipFields(acquired.ownership.id, {
        executionPhase: phase,
        // 平台端点一直可达 → 心跳持续续租，把 lease 顶过了固定的 dispatch deadline。
        dispatchDeadline: new Date(acquired.ownership.acquiredAt.getTime() - 1_000),
        leaseExpiresAt: new Date(acquired.ownership.acquiredAt.getTime() + 60_000),
      });
      return {
        fixture,
        acquired,
        before: await readOwner(fixture.tenantId, acquired.ownership.id),
      };
    };

    for (const phase of ["dispatching", "activating"] as const) {
      const window = await seedWindowOwner(phase);
      await expect(
        renewExecutionOwnership({
          tenantId: window.fixture.tenantId,
          invocationId: window.fixture.invocation.id,
          ownershipId: window.acquired.ownership.id,
          attemptId: window.acquired.ownership.attemptId,
          leaseEpoch: window.acquired.ownership.leaseEpoch,
        }),
      ).rejects.toMatchObject({ code: "OwnershipExpired" });
      // 拒绝就是拒绝：不留任何心跳/租约痕迹。
      expect(await readOwner(window.fixture.tenantId, window.acquired.ownership.id)).toEqual(
        window.before,
      );
    }

    // 反证：Invocation 同样 running、dispatchDeadline 同样已过，但 Owner 已进入 executing
    // ——续租必须成立。判定依据是 Owner phase，不是 Invocation 状态。
    const executingFixture = await seedPreparedRuntimeAttempt();
    const executing = await acquireTestRuntimeAuthority({
      tenantId: executingFixture.tenantId,
      invocationId: executingFixture.invocation.id,
      attemptId: executingFixture.attempt.id,
      runtimeRevisionId: executingFixture.binding.runtimeRevisionId,
      phase: "executing",
    });
    await setOwnershipFields(executing.ownership.id, {
      dispatchDeadline: new Date(executing.ownership.acquiredAt.getTime() - 1_000),
    });
    const executingBefore = await readOwner(executingFixture.tenantId, executing.ownership.id);
    // 前置事实显式核对：两个分支的 Invocation 都是 running，差异只在 Owner phase。
    expect(
      (await readInvocation(executingFixture.tenantId, executingFixture.invocation.id))
        .executionState,
    ).toBe("running");

    const renewed = await renewExecutionOwnership({
      tenantId: executingFixture.tenantId,
      invocationId: executingFixture.invocation.id,
      ownershipId: executing.ownership.id,
      attemptId: executing.ownership.attemptId,
      leaseEpoch: executing.ownership.leaseEpoch,
    });
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(
      executingBefore.leaseExpiresAt.getTime(),
    );
    expect(renewed.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
      executingBefore.lastHeartbeatAt.getTime(),
    );
    expect(renewed.versionNo).toBe(executingBefore.versionNo + 1);
  });

  // ── AUTH-04 ───────────────────────────────────────────────────────────────
  it("AUTH-04: terminal Invocation 请求 Acquire/Renew 一律拒绝，不留下新 active Owner", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 经唯一终态入口提交终态（与生产 Cancel 路径同一写入路径）。
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        nextState: "cancelled",
        errorCode: "InvocationCancelled",
        errorSummary: "auth-04",
      }),
    );
    const terminal = await readInvocation(fixture.tenantId, fixture.invocation.id);
    expect(terminal.executionState).toBe("cancelled");

    // (a) Acquire：必须 fail closed，且不推进 lastOwnershipEpoch、不新建任何 Owner 行。
    await expect(
      acquireExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "late-runtime",
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    // (b) Renew：终态 Invocation 上残留的活跃 Owner 不得靠续租一直吊着。
    await expect(
      renewExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        ownershipId: acquired.ownership.id,
        attemptId: acquired.ownership.attemptId,
        leaseEpoch: acquired.ownership.leaseEpoch,
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    const after = await readInvocation(fixture.tenantId, fixture.invocation.id);
    expect(after.lastOwnershipEpoch).toBe(terminal.lastOwnershipEpoch);
    expect(after.versionNo).toBe(terminal.versionNo);
    // 只有夹具那一个 Owner 行，且仍是原本那一代（没有被"最后一次写入"顶掉）。
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.id).toBe(acquired.ownership.id);
    expect(await countActiveOwners(fixture.tenantId, fixture.invocation.id)).toBe(1);
  });

  // ── AUTH-05 ───────────────────────────────────────────────────────────────
  it("AUTH-05: 对 Invocation A 提交同租户但属于 Invocation B 的 ownershipId 关闭——拒绝，B 的 Owner 不变", async () => {
    const a = await seedPreparedRuntimeAttempt();
    const b = await seedPreparedRuntimeAttempt();
    const ownerA = await acquireTestRuntimeAuthority({
      tenantId: a.tenantId,
      invocationId: a.invocation.id,
      attemptId: a.attempt.id,
      runtimeRevisionId: a.binding.runtimeRevisionId,
    });
    const ownerB = await acquireTestRuntimeAuthority({
      tenantId: b.tenantId,
      invocationId: b.invocation.id,
      attemptId: b.attempt.id,
      runtimeRevisionId: b.binding.runtimeRevisionId,
    });
    // 同租户：这不是租户过滤能挡住的情况。
    expect(a.tenantId).toBe(b.tenantId);
    expect(ownerA.ownership.invocationId).not.toBe(ownerB.ownership.invocationId);
    const bBefore = await readOwner(b.tenantId, ownerB.ownership.id);
    const aBefore = await readOwner(a.tenantId, ownerA.ownership.id);

    // (a) 用 A 作根、提交 B 的 ownershipId。
    await expect(
      closeExecutionOwnership({
        tenantId: a.tenantId,
        invocationId: a.invocation.id,
        ownershipId: ownerB.ownership.id,
        attemptId: ownerB.ownership.attemptId,
        leaseEpoch: ownerB.ownership.leaseEpoch,
        state: "revoked",
        reasonCode: "cross_invocation_close",
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });

    // B 的 Owner 逐字段不变，A 的 Owner 也不受牵连。
    expect(await readOwner(b.tenantId, ownerB.ownership.id)).toEqual(bBefore);
    expect(await readOwner(a.tenantId, ownerA.ownership.id)).toEqual(aBefore);
    expect(bBefore.ownershipState).toBe("active");

    // (b) 归属性对但代际 tuple 不对，同样拒绝。
    await expect(
      closeExecutionOwnership({
        tenantId: a.tenantId,
        invocationId: a.invocation.id,
        ownershipId: ownerA.ownership.id,
        attemptId: ownerA.ownership.attemptId,
        leaseEpoch: ownerA.ownership.leaseEpoch + 5,
        state: "revoked",
        reasonCode: "wrong_epoch",
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    expect(await readOwner(a.tenantId, ownerA.ownership.id)).toEqual(aBefore);

    // (c) 对照：正确的完整 tuple 才能关闭，且只关闭 A 自己那一代。
    const closed = await closeExecutionOwnership({
      tenantId: a.tenantId,
      invocationId: a.invocation.id,
      ownershipId: ownerA.ownership.id,
      attemptId: ownerA.ownership.attemptId,
      leaseEpoch: ownerA.ownership.leaseEpoch,
      state: "revoked",
      reasonCode: "auth_05_control",
    });
    expect(closed.ownershipState).toBe("revoked");
    expect(await readOwner(b.tenantId, ownerB.ownership.id)).toEqual(bBefore);
  });

  // ── AUTH-06 ───────────────────────────────────────────────────────────────
  it("AUTH-06: 两个独立 MySQL 连接并发 Acquire/Takeover/Renew——按统一根线性化，最多一个 Current Owner", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const invocationId = fixture.invocation.id;
    const revisionId = fixture.binding.runtimeRevisionId;

    /** 在一条**独立的真实事务**里跑一次 Acquire 读改写：先到屏障，再进入 I 根锁。 */
    const runAcquire = (executor: typeof db, attemptId: string, barrier: () => Promise<void>) =>
      executor.transaction(async (tx) => {
        const connectionId = await connectionIdOf(tx);
        await barrier();
        const result = await acquireExecutionOwnershipInTransaction(tx, {
          tenantId: fixture.tenantId,
          invocationId,
          attemptId,
          runtimeRevisionId: revisionId,
          acquiredByType: "service",
          acquiredById: "auth-06",
        });
        return { connectionId, result };
      });

    const connA = secondDb();
    const connB = db;
    expect(new Set([await connectionIdOf(connA), await connectionIdOf(connB)]).size).toBe(2);

    // (a) 空闲 Invocation 上两个连接同时 Acquire：I 根行锁把它们串行化，只能产生一个活动 Owner。
    const acquireBarrier = createBarrier(2);
    const attemptIds = [fixture.attempt.id, await seedReplacementAttempt(fixture)];
    const acquireResults = await Promise.allSettled([
      runAcquire(connA, attemptIds[0]!, acquireBarrier),
      runAcquire(connB, attemptIds[1]!, acquireBarrier),
    ]);
    const acquireWon = acquireResults.filter(
      (row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof runAcquire>>> =>
        row.status === "fulfilled",
    );
    const acquireLost = acquireResults.filter((row) => row.status === "rejected");
    expect(acquireWon).toHaveLength(1);
    expect(acquireLost).toHaveLength(1);
    expect((acquireLost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "HealthyOwnerExists",
    });
    expect(await countActiveOwners(fixture.tenantId, invocationId)).toBe(1);
    const winner = acquireWon[0]!.value.result.ownership;
    expect(winner.leaseEpoch).toBe(1);

    // (b) 过期代际上两个连接同时 Takeover：仍只有一个新代际胜出，
    // lastOwnershipEpoch 恰好 +1（不丢更新、也不双授权）。
    await expireOwner(fixture.tenantId, winner);
    const epochBefore = (await readInvocation(fixture.tenantId, invocationId)).lastOwnershipEpoch;
    const takeoverAttempts = [
      await seedReplacementAttempt(fixture),
      await seedReplacementAttempt(fixture),
    ];
    const takeoverBarrier = createBarrier(2);
    const takeoverResults = await Promise.allSettled([
      runAcquire(connA, takeoverAttempts[0]!, takeoverBarrier),
      runAcquire(connB, takeoverAttempts[1]!, takeoverBarrier),
    ]);
    const takeoverWon = takeoverResults.filter(
      (row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof runAcquire>>> =>
        row.status === "fulfilled",
    );
    expect(takeoverWon).toHaveLength(1);
    expect(takeoverResults.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(takeoverWon[0]!.value.result.takeover).toBe(true);
    expect(await countActiveOwners(fixture.tenantId, invocationId)).toBe(1);
    expect((await readInvocation(fixture.tenantId, invocationId)).lastOwnershipEpoch).toBe(
      epochBefore + 1,
    );
    const current = takeoverWon[0]!.value.result.ownership;
    expect(current.leaseEpoch).toBe(epochBefore + 1);

    // (c) 两个连接同时 Renew 同一代际：同样线性化，两次都落库，不丢更新。
    const beforeRenew = await readOwner(fixture.tenantId, current.id);
    const renewBarrier = createBarrier(2);
    const runRenew = (executor: typeof db, barrier: () => Promise<void>) =>
      executor.transaction(async (tx) => {
        const connectionId = await connectionIdOf(tx);
        await barrier();
        return {
          connectionId,
          row: await renewExecutionOwnershipInTransaction(tx, {
            tenantId: fixture.tenantId,
            invocationId,
            ownershipId: current.id,
            attemptId: current.attemptId,
            leaseEpoch: current.leaseEpoch,
          }),
        };
      });
    const renewResults = await Promise.all([
      runRenew(connA, renewBarrier),
      runRenew(connB, renewBarrier),
    ]);
    expect(new Set(renewResults.map((row) => row.connectionId)).size).toBe(2);
    const afterRenew = await readOwner(fixture.tenantId, current.id);
    // 两次续租都生效：versionNo +2、代际不变——不是"两边各读 N 再各写 N+1"。
    expect(afterRenew.versionNo).toBe(beforeRenew.versionNo + 2);
    expect(afterRenew.leaseEpoch).toBe(beforeRenew.leaseEpoch);
    expect(afterRenew.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(
      beforeRenew.leaseExpiresAt.getTime(),
    );
    expect(afterRenew.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await countActiveOwners(fixture.tenantId, invocationId)).toBe(1);
  });

  // ── AUTH-07 ───────────────────────────────────────────────────────────────
  it("AUTH-07: W→I 交接与 I 根终态同时进行——没有 I→W 反向锁，终态写持久清理，交接复验后拒绝或安全完成", async () => {
    const root = await makeRoot();
    const { binding, probe } = await createManagedBinding({ root });
    const backend: WorkspaceBackend = createWorkspaceBackend(createWorkspaceHostBroker({ root }));
    const scope = probe.scopeDigest;

    /** 激活一个**真实** Writer（真实 Broker、真实 grant）。 */
    const activateRealWriter = async (fixture: Fixture) => {
      const acquired = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        // Session 必须冻结**发布的能力证据**：Ingress 会按它重算 expected digest。
        runtimeCapabilitiesJson: INGRESS_CAPABILITIES,
      });
      const candidate = await prepareWorkspaceCandidate({
        attemptId: fixture.attempt.id,
        binding,
        backend,
        root,
        operationId: `auth-07:${fixture.attempt.id}`,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
      });
      if (!candidate) throw new Error("candidate missing");
      const activated = await activatePreparedWorkspaceWriter({
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        ownership: acquired.ownership,
        authority: acquired.authority,
        candidate,
      });
      return { acquired, activated };
    };

    // ── (a) 终态先行：I 根终态提交后，对旧代际的交接必须被复验拒绝 ──
    const first = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    const run = await activateRealWriter(first);
    const lockBefore = await readLock(run.activated.lockId);
    expect(lockBefore?.lockState).toBe("active");
    expect(lockBefore?.writerGeneration).toBe(1);
    expect(lockBefore?.backendGrantRef).toBe(run.activated.grant.grantRef);

    const lifecycle = await pushIngressStarted({ fixture: first, acquired: run.acquired });
    await lifecycle.complete();
    expect((await readInvocation(TENANT_ID, first.invocation.id)).executionState).toBe("completed");

    // 终态事务**没有**在 I 锁下动 W 行：槽位仍是 active、保留真实 grant 与回执。
    const afterTerminal = await readLock(run.activated.lockId);
    expect(afterTerminal?.lockState).toBe("active");
    expect(afterTerminal?.writerGeneration).toBe(1);
    expect(afterTerminal?.backendGrantRef).toBe(run.activated.grant.grantRef);
    expect(afterTerminal?.backendReceipt).not.toBeNull();
    // 而 Authority 已被**同一事务**失效——这才是释放 lane 的持久发现依据。
    expect(await readOwner(TENANT_ID, run.acquired.ownership.id)).toMatchObject({
      ownershipState: "released",
      reasonCode: "execution_terminal",
    });

    // 释放 lane 按 W→I 顺序接管：领取时复验"父 Owner 已失权"，然后真实撤销该代际 Writer。
    const release = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: run.activated.lockId,
      leaseOwner: "auth-07-lane",
      deps: { resolveHost: async () => backend.host },
    });
    expect(release.outcome).toBe("released");
    const released = await readLock(run.activated.lockId);
    expect(released?.lockState).toBe("released");
    expect(released?.writerGeneration).toBe(1);
    const receipt = released?.releaseReceipt as {
      stopped?: boolean;
      processGroupEmpty?: boolean;
    };
    expect(receipt.stopped).toBe(true);
    expect(receipt.processGroupEmpty).toBe(true);

    // 交接复验：拿已被失效的老代际 tuple 去激活同一 scope 的预留行 → 必须拒绝，
    // 且不落下伪造的 Backend 回执。
    const lateAttemptId = await seedReplacementAttempt(first);
    const lateReserved = expectReserved(
      await reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: scope,
        invocationId: first.invocation.id,
        attemptId: lateAttemptId,
        ownershipId: run.acquired.ownership.id,
        workspaceBindingId: binding.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        backendOperationId: `auth-07-late:${lateAttemptId}`,
      }),
    );
    await expect(
      db.transaction((tx) =>
        activateWorkspaceWriter(
          {
            tenantId: TENANT_ID,
            storageScopeDigest: scope,
            invocationId: first.invocation.id,
            attemptId: lateAttemptId,
            lockId: lateReserved.lock.id,
            writerGeneration: lateReserved.writerGeneration,
            ownershipId: run.acquired.ownership.id,
            leaseEpoch: run.acquired.ownership.leaseEpoch,
            backendGrantRef: "grant-should-not-land",
            backendOperationId: `auth-07-late:${lateAttemptId}`,
          },
          tx,
        ),
      ),
    ).rejects.toThrow("Workspace writer 的父 Owner 已失权");
    const rejected = await readLock(lateReserved.lock.id);
    expect(rejected?.lockState).toBe("reserved");
    expect(rejected?.backendGrantRef).toBeNull();

    // ── (b) 交接先行：新代际完成接管后才提交 I 根终态 ──
    const second = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    const secondRun = await activateRealWriter(second);
    const generationBeforeHandover = (await readLock(secondRun.activated.lockId))!.writerGeneration;
    // 旧代际失权（释放 lane 会收口物理 Writer），新代际在 W 路径复核后接管 generation+1。
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: second.invocation.id,
      ownershipId: secondRun.acquired.ownership.id,
      attemptId: secondRun.acquired.ownership.attemptId,
      leaseEpoch: secondRun.acquired.ownership.leaseEpoch,
      state: "lost",
      reasonCode: "handover",
    });
    // A07 决策四：父 Owner 失权后仍占着 `active` 的行**不得被直接覆盖** —— 必须由释放 lane
    // 拿到真实停止回执并写成 `released`，下一代才被分配。
    const handoverRelease = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: secondRun.activated.lockId,
      leaseOwner: "auth-07-handover-release",
      deps: { resolveHost: async () => backend.host },
    });
    expect(handoverRelease.outcome).toBe("released");
    const handoverAttemptId = await seedReplacementAttempt(second);
    const handoverOwner = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: second.invocation.id,
      attemptId: handoverAttemptId,
      runtimeRevisionId: second.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: INGRESS_CAPABILITIES,
    });
    const handoverCandidate = await prepareWorkspaceCandidate({
      attemptId: handoverAttemptId,
      binding,
      backend,
      root,
      operationId: `auth-07-handover:${handoverAttemptId}`,
      runtimeRevisionId: second.binding.runtimeRevisionId,
    });
    if (!handoverCandidate) throw new Error("handover candidate missing");
    const handover = await activatePreparedWorkspaceWriter({
      tenantId: TENANT_ID,
      invocationId: second.invocation.id,
      attemptId: handoverAttemptId,
      ownership: handoverOwner.ownership,
      authority: handoverOwner.authority,
      candidate: handoverCandidate,
    });
    // 交接是"安全完成"而不是被拒绝：generation 严格递增。
    expect(handover.writerGeneration).toBe(generationBeforeHandover + 1);
    // 交接完成之后才提交终态：I 根终态同样不碰 W 行。
    const handoverLifecycle = await pushIngressStarted({
      fixture: second,
      acquired: handoverOwner,
    });
    await handoverLifecycle.complete();
    expect((await readInvocation(TENANT_ID, second.invocation.id)).executionState).toBe(
      "completed",
    );
    const afterHandoverTerminal = await readLock(handover.lockId);
    expect(afterHandoverTerminal?.lockState).toBe("active");
    expect(afterHandoverTerminal?.writerGeneration).toBe(handover.writerGeneration);
    expect(afterHandoverTerminal?.backendGrantRef).toBe(handover.grant.grantRef);
    expect(await readOwner(TENANT_ID, handoverOwner.ownership.id)).toMatchObject({
      ownershipState: "released",
      reasonCode: "execution_terminal",
    });

    // (c) 段要在**同一个物理 scope** 上再起一代：仍必须先把交接代际真实停下
    // （A07 决策四：`active` 行不得被覆盖；只有 `released` 才允许分配下一代）。
    const handoverTerminalRelease = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: handover.lockId,
      leaseOwner: "auth-07-handover-terminal-release",
      deps: { resolveHost: async () => backend.host },
    });
    expect(handoverTerminalRelease.outcome).toBe("released");
    expect((await readLock(handover.lockId))?.lockState).toBe("released");

    // ── (c) 真并发：同一 Invocation 上 I 根终态与 W→I 交接同时进行 ──
    const racing = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    const racingRun = await activateRealWriter(racing);
    const racingLifecycle = await pushIngressStarted({
      fixture: racing,
      acquired: racingRun.acquired,
    });
    const racingLockBefore = await readLock(racingRun.activated.lockId);
    expect(racingLockBefore?.lockState).toBe("active");
    const racingLeaseOwner = "auth-07-racing-lane";

    const raceBarrier = createBarrier(2);
    const race = await Promise.allSettled([
      (async () => {
        await raceBarrier();
        // I 根终态：真实 Ingress 终态事务（I 根锁 → 失效 Authority → 关 Session → 写持久清理事实）。
        return racingLifecycle.complete();
      })(),
      (async () => {
        await raceBarrier();
        // W→I 交接：先锁 WorkspaceWriteLock（scope），再按 Invocation → Attempt → Ownership
        // 复核"父 Owner 是否仍健康"。这是释放/交接 lane 的真实领取入口。
        return claimWorkspaceWriterRelease({
          tenantId: TENANT_ID,
          lockId: racingRun.activated.lockId,
          leaseOwner: racingLeaseOwner,
          now: new Date(),
        });
      })(),
    ]);

    // 没有死锁：两条路径都在预算内结束（若存在 I→W 反向锁，MySQL 会给 1213 或挂到锁等待超时）。
    for (const result of race) {
      if (result.status === "rejected") {
        const reason = result.reason as { code?: string; errno?: number; name?: string };
        expect(reason?.errno).not.toBe(1213);
        expect(reason?.code).not.toBe("ER_LOCK_DEADLOCK");
        throw new Error(`并发路径不应失败：${reason?.name ?? String(reason)}`);
      }
    }
    // I 根终态一定提交成功（终态是唯一入口，不允许被交接挤掉）。
    expect(race[0]!.status).toBe("fulfilled");
    expect((await readInvocation(TENANT_ID, racing.invocation.id)).executionState).toBe(
      "completed",
    );
    // 交接侧按统一根线性化：要么在终态之前判"父 Owner 仍健康"而跳过、要么在终态之后成功领取。
    // 两种结果都必须落在持久状态上，不存在"两边都以为自己是当前代际"。
    const claim = (
      race[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof claimWorkspaceWriterRelease>>>
    ).value;
    if (claim.outcome === "skipped") {
      expect(claim.reason).toBe("healthy_owner");
    } else {
      expect(claim.outcome).toBe("claimed");
    }
    // 终态不变式：终态之后不存在"仍被 active Owner 持有"的槽位。
    expect((await readOwner(TENANT_ID, racingRun.acquired.ownership.id)).ownershipState).not.toBe(
      "active",
    );
    const locks = await db
      .select()
      .from(workspaceWriteLock)
      .where(
        and(
          eq(workspaceWriteLock.tenantId, TENANT_ID),
          eq(workspaceWriteLock.storageScopeDigest, scope),
        ),
      );
    expect(locks).toHaveLength(1);
    const racingRow = locks[0]!;
    // 终态没有把 W 行改成/改成过任何"第三方"归属：holder 仍是刚被失效的那一代，
    // 只是状态停在 active（交接侧判"仍健康"而跳过）或 releasing（交接侧已领取）。
    expect(racingRow.holderOwnershipId).toBe(racingRun.acquired.ownership.id);
    expect(["active", "releasing"]).toContain(racingRow.lockState);
    // 终态写的持久清理事实可被正式 lane 完整收口：真实撤销 Writer + released 回执。
    const laneResult = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: racingRow.id,
      leaseOwner: racingLeaseOwner,
      deps: { resolveHost: async () => backend.host },
    });
    expect(laneResult.outcome).toBe("released");
    const releasedRow = await readLock(racingRow.id);
    expect(releasedRow?.lockState).toBe("released");
    expect(releasedRow?.writerGeneration).toBe(racingLockBefore?.writerGeneration);
    const racingReceipt = releasedRow?.releaseReceipt as {
      stopped?: boolean;
      processGroupEmpty?: boolean;
    };
    expect(racingReceipt.stopped).toBe(true);
    expect(racingReceipt.processGroupEmpty).toBe(true);
  });

  // ── AUTH-08 ───────────────────────────────────────────────────────────────
  it("AUTH-08: 两个真实连接同时预留已释放物理 scope——generation 串行增加、不丢更新、不双授权，所有写在同一 Tx", async () => {
    const root = await makeRoot();
    const { binding, probe } = await createManagedBinding({ root });
    const backend: WorkspaceBackend = createWorkspaceBackend(createWorkspaceHostBroker({ root }));
    const scope = probe.scopeDigest;
    const connA = secondDb();

    /** 造一个**真正 released** 的槽位：预留 → 生产释放 lane 收口（holder 不存在 ⇒ 父 Owner 已失权）。 */
    const reserved = expectReserved(
      await reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: scope,
        invocationId: randomUUID(),
        attemptId: randomUUID(),
        ownershipId: randomUUID(),
        workspaceBindingId: binding.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    const seededRelease = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: reserved.lock.id,
      leaseOwner: "auth-08-seed",
      deps: { resolveHost: async () => backend.host },
    });
    expect(seededRelease.outcome).toBe("released");
    const seeded = await readLock(reserved.lock.id);
    expect(seeded?.lockState).toBe("released");
    expect(seeded?.holderOwnershipId).toBeNull();
    expect(seeded?.leaseExpiresAt).toBeNull();

    const reserveInput = (ownershipId: string) => ({
      tenantId: TENANT_ID,
      storageScopeDigest: scope,
      invocationId: randomUUID(),
      attemptId: randomUUID(),
      ownershipId,
      workspaceBindingId: binding.id,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });

    // (a) 所有写都在同一个 Tx：提交之前，另一条真实连接看不到新 generation。
    const singleTx = await connA.transaction(async (tx) => {
      const result = expectReserved(
        await reserveWorkspaceWriterInTransaction(tx, reserveInput(randomUUID())),
      );
      // 事务内：本连接已看到新 generation。
      expect((await readLock(result.lock.id, tx))?.writerGeneration).toBe(result.writerGeneration);
      // 事务外（另一条真实连接）：必须还是旧 generation —— 证明这不是两条自动提交写。
      const outsideDuringTx = await readLock(result.lock.id);
      expect(outsideDuringTx?.writerGeneration).toBe(seeded!.writerGeneration);
      expect(outsideDuringTx?.lockState).toBe("released");
      return result.writerGeneration;
    });
    expect(singleTx).toBe(seeded!.writerGeneration + 1);
    expect((await readLock(reserved.lock.id))?.writerGeneration).toBe(seeded!.writerGeneration + 1);

    // (b) 两个真实连接同时预留同一已释放 scope：行锁串行化，generation 严格递增不丢更新。
    const generationBefore = (await readLock(reserved.lock.id))!.writerGeneration;
    const versionBefore = (await readLock(reserved.lock.id))!.versionNo;
    const holderIds = [randomUUID(), randomUUID()];
    const barrier = createBarrier(2);
    const reserveOn = (executor: typeof db, ownershipId: string) =>
      executor.transaction(async (tx) => {
        const connectionId = await connectionIdOf(tx);
        await barrier();
        const result = expectReserved(
          await reserveWorkspaceWriterInTransaction(tx, reserveInput(ownershipId)),
        );
        return { connectionId, generation: result.writerGeneration, ownershipId };
      });

    const results = await Promise.all([
      reserveOn(connA, holderIds[0]!),
      reserveOn(db, holderIds[1]!),
    ]);
    // 两条连接确实不同。
    expect(new Set(results.map((row) => row.connectionId)).size).toBe(2);
    // generation 串行增加：恰好 +1 与 +2，互不相同。
    expect(results.map((row) => row.generation).sort((left, right) => left - right)).toEqual([
      generationBefore + 1,
      generationBefore + 2,
    ]);

    const finalRow = await readLock(reserved.lock.id);
    // 不丢更新：两次预留的 versionNo 增量都落库。
    expect(finalRow?.versionNo).toBe(versionBefore + 2);
    // 不双授权：最终只有一个 holder tuple，且恰好是拿到较大 generation 的那一次。
    expect(finalRow?.writerGeneration).toBe(generationBefore + 2);
    expect(finalRow?.holderOwnershipId).toBe(
      results.find((row) => row.generation === generationBefore + 2)!.ownershipId,
    );
    expect(finalRow?.lockState).toBe("reserved");
    // 一个物理 scope 只有一行槽位。
    expect(await countLocksForScope(scope)).toBe(1);
  });

  // ── AUTH-09 ───────────────────────────────────────────────────────────────
  it("AUTH-09: Owner 正常续租但 Writer slot 中 expiry 是旧值，另 Invocation 尝试抢占——不得抢健康 Writer，Backend 和 DB 代际一致", async () => {
    const root = await makeRoot();
    const { binding, probe } = await createManagedBinding({ root });
    const backend: WorkspaceBackend = createWorkspaceBackend(createWorkspaceHostBroker({ root }));
    const scope = probe.scopeDigest;

    const fixture = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const candidate = await prepareWorkspaceCandidate({
      attemptId: fixture.attempt.id,
      binding,
      backend,
      root,
      operationId: `auth-09:${fixture.attempt.id}`,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    if (!candidate) throw new Error("candidate missing");
    const activated = await activatePreparedWorkspaceWriter({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      ownership: acquired.ownership,
      authority: acquired.authority,
      candidate,
    });
    const lockBefore = await readLock(activated.lockId);
    expect(lockBefore?.lockState).toBe("active");
    expect(lockBefore?.holderOwnershipId).toBe(acquired.ownership.id);

    // Owner 正常续租：心跳与租约一起前移，但**没有任何路径**去刷新 slot 上的 leaseExpiresAt
    // ——槽位里留下的是一个旧值。这正是 R04 §4 禁止用 slot 上上次写入的 leaseExpiresAt
    // 判断"父 Owner 是否还健康"的原因。
    const renewed = await renewExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      ownershipId: acquired.ownership.id,
      attemptId: acquired.ownership.attemptId,
      leaseEpoch: acquired.ownership.leaseEpoch,
    });
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(lockBefore!.leaseExpiresAt!.getTime());

    // 另一个 Invocation 尝试抢占同一物理 scope：必须被拒（不能抢健康 Writer）。
    const other = await seedPreparedRuntimeAttempt({ workspaceBinding: binding });
    await expect(
      reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: scope,
        invocationId: other.invocation.id,
        attemptId: other.attempt.id,
        ownershipId: "other-invocation-ownership",
        workspaceBindingId: binding.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow("父 Owner 仍然健康");

    // 抢占失败不留任何写入：行逐字段不变（包括那个"看起来旧"的 leaseExpiresAt）。
    expect(await readLock(activated.lockId)).toEqual(lockBefore);
    expect(await countLocksForScope(scope)).toBe(1);

    // Backend 与 DB 的代际一致：DB 行的 generation 在 Backend 上就是同一个真实 Writer。
    const grant = await backend.host.getWriter(scope, lockBefore!.writerGeneration);
    expect(grant).not.toBeNull();
    expect(grant?.writerGeneration).toBe(lockBefore!.writerGeneration);
    expect(grant?.grantRef).toBe(lockBefore!.backendGrantRef);
    expect(grant?.ownershipId).toBe(acquired.ownership.id);
    expect(grant?.invocationId).toBe(fixture.invocation.id);
    // 尚未授予的代际在 Backend 上不存在：不允许出现"DB 说有、Backend 没有"的错位。
    expect(await backend.host.getWriter(scope, lockBefore!.writerGeneration + 1)).toBeNull();

    // 父 Owner 真的失权之后，同一个抢占才被允许，且拿到的是 Backend 真实代际链上的下一格。
    await closeExecutionOwnership({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      ownershipId: acquired.ownership.id,
      attemptId: acquired.ownership.attemptId,
      leaseEpoch: acquired.ownership.leaseEpoch,
      state: "lost",
      reasonCode: "auth-09",
    });
    // A07 决策四：`active` 行 + 父 Owner 已失权时**不得直接覆盖**，否则旧 Writer 的
    // 定位就丢了。本轮只能可靠登记释放，并如实回报 release_pending。
    const pending = await reserveWorkspaceWriter({
      tenantId: TENANT_ID,
      storageScopeDigest: scope,
      invocationId: other.invocation.id,
      attemptId: other.attempt.id,
      ownershipId: "other-invocation-ownership",
      workspaceBindingId: binding.id,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(pending.outcome).toBe("release_pending");
    if (pending.outcome !== "release_pending") throw new Error("unreachable");
    expect(pending.reason).toBe("previous_writer_not_stopped");
    // 义务已登记，而原 holder tuple / Backend 回执 / 定位字段一个都没被抹掉。
    const pendingRow = await readLock(activated.lockId);
    expect(pendingRow?.lockState).toBe("releasing");
    expect(pendingRow?.releaseReasonCode).toBe("writer_holder_ownership_lost");
    expect(pendingRow?.writerGeneration).toBe(lockBefore!.writerGeneration);
    expect(pendingRow?.holderInvocationId).toBe(fixture.invocation.id);
    expect(pendingRow?.holderOwnershipId).toBe(acquired.ownership.id);
    expect(pendingRow?.backendGrantRef).toBe(lockBefore!.backendGrantRef);
    expect(pendingRow?.leaseExpiresAt).not.toBeNull();
    // 释放 lane 真实停止上一代（Backend 上确实还存在该 writer），行才进入 `released`。
    const releasedOutcome = await runWorkspaceWriterRelease({
      tenantId: TENANT_ID,
      lockId: activated.lockId,
      leaseOwner: "auth-09-release",
      deps: { resolveHost: async () => backend.host },
    });
    expect(releasedOutcome.outcome).toBe("released");
    expect((await readLock(activated.lockId))?.lockState).toBe("released");
    expect(await backend.host.getWriter(scope, lockBefore!.writerGeneration)).toBeNull();

    // 只有到这一步才分配下一代，且拿到 Backend 真实代际链上的下一格。
    const taken = expectReserved(
      await reserveWorkspaceWriter({
        tenantId: TENANT_ID,
        storageScopeDigest: scope,
        invocationId: other.invocation.id,
        attemptId: other.attempt.id,
        ownershipId: "other-invocation-ownership",
        workspaceBindingId: binding.id,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(taken.writerGeneration).toBe(lockBefore!.writerGeneration + 1);
    expect((await readLock(activated.lockId))?.holderInvocationId).toBe(other.invocation.id);
  });
});

/**
 * A07 决策四：预留的成功出口现在是**显式 outcome**。测试里凡是"预期预留成功"的地方都必须
 * 穿过这个断言，避免直接读联合体上可能表示 `release_pending` 的字段。
 */
function expectReserved(outcome: ReserveWorkspaceWriterOutcome): AcquireWorkspaceWriteLockResult {
  if (outcome.outcome !== "reserved") {
    throw new Error(`预期预留成功，实际得到 release_pending（${outcome.reason}）`);
  }
  return outcome;
}
