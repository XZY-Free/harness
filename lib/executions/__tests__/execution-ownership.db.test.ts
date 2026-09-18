import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createEnvironmentDefinition,
  getEnvironmentRevisionById,
} from "@/lib/environment/environment-definition-store";
import { ENVIRONMENT_PREPARED_TTL_MS } from "@/lib/environment/environment-prepared-evidence";
import type { EnvironmentRevisionInput } from "@/lib/environment/environment-revision";
import { seedPreparedEnvironmentLease } from "@/lib/environment/test-support/seed-prepared-environment-lease";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnership,
  closeExecutionOwnership,
  getActiveExecutionOwnership,
  getAuthorityDatabaseTime,
  renewExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { decodeWorkloadToken, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  isTokenRevoked,
  revokeWorkloadToken,
} from "@/lib/identity/workload-token-revocation-queries";
import {
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { handleRuntimeHeartbeat } from "@/lib/runtime/application/runtime-heartbeat";
import { resolveRuntimePrincipal } from "@/lib/runtime/route-helpers";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/** R02 §4：Acquire 侧环境前置复验所需的最小 Revision 输入。 */
function environmentRevisionInput(
  overrides: Partial<EnvironmentRevisionInput> = {},
): EnvironmentRevisionInput {
  return {
    environmentType: "sandbox",
    filesystemPolicyJson: { writeRoots: ["workspace"] },
    networkPolicyJson: { egress: "deny_all" },
    resourceLimitsJson: { cpu: 2, memoryMb: 2048 },
    secretPolicyJson: { inject: "none" },
    executionTarget: { kind: "container", image: "snowharness/test:latest" },
    requiredCapabilities: { isolation: true },
    createdByType: "user",
    createdById: "test-admin",
    ...overrides,
  };
}

describe("ExecutionOwnership database fencing", () => {
  let originalSigningKeyId: string | undefined;

  beforeAll(() => {
    originalSigningKeyId = process.env.WORKLOAD_SIGNING_KEY_ID;
    process.env.WORKLOAD_SIGNING_KEY_ID = "test-ownership-fencing-key";
  });

  afterAll(() => {
    if (originalSigningKeyId === undefined) process.env.WORKLOAD_SIGNING_KEY_ID = undefined;
    else process.env.WORKLOAD_SIGNING_KEY_ID = originalSigningKeyId;
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("FENCE-01/FENCE-08: concurrent acquire leaves one healthy current owner", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    await expect(
      acquireExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "racing-runtime",
      }),
    ).rejects.toMatchObject({ code: "HealthyOwnerExists" });
    expect(
      (
        await getActiveExecutionOwnership({
          tenantId: fixture.tenantId,
          invocationId: fixture.invocation.id,
        })
      )?.id,
    ).toBe(first.ownership.id);
  });

  it("FENCE-03/FENCE-04: expired generation cannot renew and takeover fences it", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    await expect(
      renewExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        ownershipId: first.ownership.id,
        attemptId: fixture.attempt.id,
        leaseEpoch: first.ownership.leaseEpoch,
      }),
    ).rejects.toMatchObject({ code: "OwnershipExpired" });
    const replacementAttempt = await createAttempt({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    const evidence = { kind: "replacement", attemptId: replacementAttempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: replacementAttempt.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    const replacement = await acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: replacementAttempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "replacement-runtime",
    });
    expect(replacement.takeover).toBe(true);
    expect(replacement.ownership.leaseEpoch).toBe(first.ownership.leaseEpoch + 1);
    const [stale] = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.id, first.ownership.id),
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
        ),
      );
    expect(stale?.ownershipState).toBe("lost");
  });

  async function prepareReplacementAttempt(
    fixture: Awaited<ReturnType<typeof seedPreparedRuntimeAttempt>>,
    acquiredById: string,
  ) {
    const attempt = await createAttempt({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    const evidence = { kind: "candidate", acquiredById, attemptId: attempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedInTransaction(tx, {
        attemptId: attempt.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    return attempt;
  }

  it("FENCE-02: a healthy heartbeat renews the lease without touching epoch or producer state", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const before = first.ownership.leaseExpiresAt.getTime();
    const [invocationBefore] = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    const renewed = await renewExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: first.ownership.id,
      attemptId: fixture.attempt.id,
      leaseEpoch: first.ownership.leaseEpoch,
    });
    expect(renewed.leaseEpoch).toBe(first.ownership.leaseEpoch);
    expect(renewed.versionNo).toBe((invocationBefore?.versionNo ?? 1) + 1);
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(renewed.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
      first.ownership.lastHeartbeatAt.getTime(),
    );
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.id).toBe(first.ownership.id);
  });

  it("FENCE-05: two racing candidates for the same invocation leave exactly one active owner", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const candidateB = await prepareReplacementAttempt(fixture, "racing-candidate-b");
    const acquireA = acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "racing-candidate-a",
    });
    const acquireB = acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: candidateB.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "racing-candidate-b",
    });
    const settled = await Promise.allSettled([acquireA, acquireB]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "HealthyOwnerExists" });
    const rows = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
          eq(executionOwnershipTable.invocationId, fixture.invocation.id),
        ),
      );
    expect(rows.filter((r) => r.ownershipState === "active")).toHaveLength(1);
  });

  it("FENCE-06: renew-first keeps a healthy owner; takeover-first fences the old renew", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const candidateB = await prepareReplacementAttempt(fixture, "renew-vs-takeover");
    // 串行序 A：Renew 先合法提交，旧 epoch 恢复健康 → 随后 Takeover 必须被健康 Owner 拒绝。
    const renewed = await renewExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: first.ownership.id,
      attemptId: fixture.attempt.id,
      leaseEpoch: first.ownership.leaseEpoch,
    });
    expect(renewed.leaseEpoch).toBe(first.ownership.leaseEpoch);
    await expect(
      acquireExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: candidateB.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "renew-vs-takeover",
      }),
    ).rejects.toMatchObject({ code: "HealthyOwnerExists" });
    // 串行序 B：Takeover 先建立 epoch2 → 旧 epoch 的 Renew 被拒绝且不复活。
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    const candidateC = await prepareReplacementAttempt(fixture, "takeover-vs-renew");
    await acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: candidateC.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "takeover-vs-renew",
    });
    await expect(
      renewExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        ownershipId: first.ownership.id,
        attemptId: fixture.attempt.id,
        leaseEpoch: first.ownership.leaseEpoch,
      }),
    ).rejects.toThrow();
    const rows = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
          eq(executionOwnershipTable.invocationId, fixture.invocation.id),
        ),
      );
    expect(rows.filter((r) => r.ownershipState === "active")).toHaveLength(1);
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.leaseEpoch).toBe(first.ownership.leaseEpoch + 1);
    const stale = rows.find((r) => r.id === first.ownership.id);
    expect(stale?.ownershipState).toBe("lost");
  });

  it("FENCE-07: racing release and takeover produce a single unique grant without resurrecting epochs", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    const candidateB = await prepareReplacementAttempt(fixture, "takeover-vs-release");
    const releasePromise = closeExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: first.ownership.id,
      state: "released",
      reasonCode: "test_release",
    });
    const takeoverPromise = acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: candidateB.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "takeover-vs-release",
    });
    const [releaseResult, takeoverResult] = await Promise.allSettled([
      releasePromise,
      takeoverPromise,
    ]);
    expect(releaseResult.status).toBe("fulfilled");
    const rows = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
          eq(executionOwnershipTable.invocationId, fixture.invocation.id),
        ),
      );
    expect(rows.filter((r) => r.ownershipState === "active")).toHaveLength(1);
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.id).not.toBe(first.ownership.id);
    expect(active?.leaseEpoch).toBe(first.ownership.leaseEpoch + 1);
    const epochs = rows.map((r) => r.leaseEpoch).sort((a, b) => a - b);
    expect(new Set(epochs).size).toBe(epochs.length);
    const stale = rows.find((r) => r.id === first.ownership.id);
    expect(["released", "lost"]).toContain(stale?.ownershipState);
    if (takeoverResult.status === "rejected") {
      // release 先提交时 takeover 是健康 Owner 之外的全新获取，不应失败；此断言防御回归。
      expect((takeoverResult as PromiseRejectedResult).reason).toMatchObject({
        code: "HealthyOwnerExists",
      });
    }
  });

  it("FENCE-09: the database single-active unique constraint rejects a bypassing insert but allows history", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const bypassAttempt = await prepareReplacementAttempt(fixture, "bypass-insert");
    await expect(
      db.insert(executionOwnershipTable).values({
        id: randomUUID(),
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: bypassAttempt.id,
        leaseEpoch: first.ownership.leaseEpoch + 1,
        ownershipState: "active",
        executionPhase: "activating",
        acquiredAt: new Date(),
        lastHeartbeatAt: new Date(),
        leaseExpiresAt: new Date(Date.now() + 90_000),
        dispatchDeadline: new Date(Date.now() + 120_000),
        acquiredByType: "service",
        acquiredById: "bypass-insert",
        versionNo: 1,
      }),
    ).rejects.toThrow();
    await closeExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: first.ownership.id,
      state: "released",
      reasonCode: "test_release",
    });
    const history = await db.insert(executionOwnershipTable).values({
      id: randomUUID(),
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: bypassAttempt.id,
      // 使用远端 epoch，不占用服务侧 lastOwnershipEpoch 序号，仅验证非 active 历史允许存在。
      leaseEpoch: first.ownership.leaseEpoch + 1000,
      ownershipState: "lost",
      executionPhase: "activating",
      acquiredAt: new Date(),
      lastHeartbeatAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 90_000),
      dispatchDeadline: new Date(Date.now() + 120_000),
      releasedAt: new Date(),
      reasonCode: "test_history",
      acquiredByType: "service",
      acquiredById: "bypass-history",
      versionNo: 1,
    });
    expect(history).toBeDefined();
    const secondActive = await acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: bypassAttempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "post-release-acquire",
    });
    expect(secondActive.ownership.leaseEpoch).toBe(first.ownership.leaseEpoch + 1);
  });

  it("FENCE-12: platform renewals cannot extend a not-yet-started owner past its dispatch deadline", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // 未 Start：续租被 deadline 封顶，无法延长到 now + 90s。
    const capped = await renewExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: first.ownership.id,
      attemptId: fixture.attempt.id,
      leaseEpoch: first.ownership.leaseEpoch,
    });
    expect(capped.leaseExpiresAt.getTime()).toBeLessThanOrEqual(
      first.ownership.dispatchDeadline.getTime() + 5,
    );
    expect(capped.leaseExpiresAt.getTime()).toBeLessThan(Date.now() + 90_000);
    // deadline 已过仍未 Start：续租必须失败，Start 无法无限占用。
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ dispatchDeadline: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    await expect(
      renewExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        ownershipId: first.ownership.id,
        attemptId: fixture.attempt.id,
        leaseEpoch: first.ownership.leaseEpoch,
      }),
    ).rejects.toMatchObject({ code: "OwnershipExpired" });
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.leaseExpiresAt.getTime()).toBeLessThanOrEqual(
      first.ownership.dispatchDeadline.getTime() + 5,
    );
  });

  it("FENCE-13/FENCE-15: a valid unrevoked old-generation token authenticates but its writes are fenced", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const token1 = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      audience: "runtime",
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      attemptId: fixture.attempt.id,
      ownershipId: first.ownership.id,
      leaseEpoch: String(first.ownership.leaseEpoch),
      sessionBindingId: first.session.id,
      expiresAt: Date.now() + 60_000,
    });
    const claims1 = decodeWorkloadToken(token1);
    expect(claims1.leaseEpoch).toBe(String(first.ownership.leaseEpoch));
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    const candidateB = await prepareReplacementAttempt(fixture, "token-fencing-takeover");
    await acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: candidateB.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "token-fencing-takeover",
    });
    // token1 签名有效且从未撤销——身份认证层面可通过。
    expect(await isTokenRevoked(fixture.tenantId, claims1.jti)).toBe(false);
    const authenticatedClaims = decodeWorkloadToken(token1);
    expect(authenticatedClaims.invocationId).toBe(fixture.invocation.id);
    // 但执行权层面对 epoch2 之后的旧 authority 写入全部拒绝——正确性不依赖撤销。
    await expect(
      ingressRuntimeEvents({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: first.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: "1",
              type: "progress" as const,
              schemaVersion: 1,
              payload: { message: "stale" },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
  });

  it("FENCE-14: heartbeat credential refresh mints a new jti on the same epoch, stale owners cannot refresh", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const oldToken = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      audience: "runtime",
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      attemptId: fixture.attempt.id,
      ownershipId: first.ownership.id,
      leaseEpoch: String(first.ownership.leaseEpoch),
      sessionBindingId: first.session.id,
      expiresAt: Date.now() + 60_000,
    });
    const oldJti = decodeWorkloadToken(oldToken).jti;
    const response = await handleRuntimeHeartbeat({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      request: {
        protocolVersion: 3,
        authority: first.authority,
        heartbeatId: randomUUID(),
        runtimeState: "running",
        lastObservedProducerSequence: "0",
        requestCredentialRefresh: true,
      },
    });
    expect(response.continueExecution).toBe(true);
    expect(response.renewedCredentials).toBeDefined();
    const newClaims = decodeWorkloadToken(response.renewedCredentials!.runtimeToken);
    expect(newClaims.jti).not.toBe(oldJti);
    expect(newClaims.leaseEpoch).toBe(String(first.ownership.leaseEpoch));
    expect(newClaims.sessionBindingId).toBe(first.session.id);
    // 过期 Owner 不能借 Heartbeat 续发凭据。
    // 过期/超时必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：
    // 客户端 `Date.now()` 比 DB 快毫秒级，只留 1ms 余量并不能表达该状态。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.ownership.id));
    await expect(
      handleRuntimeHeartbeat({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        request: {
          protocolVersion: 3,
          authority: first.authority,
          heartbeatId: randomUUID(),
          runtimeState: "running",
          lastObservedProducerSequence: "0",
          requestCredentialRefresh: true,
        },
      }),
    ).rejects.toMatchObject({ code: "OwnershipExpired" });
  });

  it("FENCE-16: a committed JTI revocation races ahead of the event ingress and the event is never accepted", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const first = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    const token1 = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      audience: "runtime",
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      attemptId: fixture.attempt.id,
      ownershipId: first.ownership.id,
      leaseEpoch: String(first.ownership.leaseEpoch),
      sessionBindingId: first.session.id,
      expiresAt: Date.now() + 60_000,
    });
    const claims = decodeWorkloadToken(token1);
    // 撤销先 commit：撤销与 Event 共享 Invocation 根锁的串行顺序中，撤销胜出。
    await revokeWorkloadToken({
      tenantId: fixture.tenantId,
      jti: claims.jti,
      invocationId: fixture.invocation.id,
      revokedBy: "test-security",
      reasonCode: "test_revocation_race",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      actor: { tenantId: fixture.tenantId, actorType: "user", actorId: "test-admin" },
    });
    expect(await isTokenRevoked(fixture.tenantId, claims.jti)).toBe(true);
    // 随后到达的 Event 在认证层即被拒，永不进入 ingress。
    await expect(
      resolveRuntimePrincipal(
        new Headers({ authorization: `Bearer ${token1}` }),
        fixture.invocation.id,
      ),
    ).rejects.toMatchObject({ code: "token_revoked" });
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active?.id).toBe(first.ownership.id);
  });

  it("FENCE-17: 终态 Invocation 不可 Acquire，不复活代际也不推进 epoch", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const before = await db
      .select({
        lastOwnershipEpoch: invocationTable.lastOwnershipEpoch,
        executionState: invocationTable.executionState,
      })
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id))
      .limit(1);
    await db
      .update(invocationTable)
      .set({ executionState: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invocationTable.tenantId, fixture.tenantId),
          eq(invocationTable.id, fixture.invocation.id),
        ),
      );

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

    expect(
      await getActiveExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
      }),
    ).toBeNull();
    const after = await db
      .select({
        lastOwnershipEpoch: invocationTable.lastOwnershipEpoch,
        executionState: invocationTable.executionState,
      })
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id))
      .limit(1);
    expect(after).toEqual([
      { lastOwnershipEpoch: before[0]?.lastOwnershipEpoch, executionState: "cancelled" },
    ]);
  });

  it("FENCE-18: 终态 Attempt 不可 Acquire（换实例必须新建 Attempt）", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "lost", finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invocationAttemptTable.tenantId, fixture.tenantId),
          eq(invocationAttemptTable.id, fixture.attempt.id),
        ),
      );

    await expect(
      acquireExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        acquiredByType: "service",
        acquiredById: "late-runtime",
      }),
    ).rejects.toMatchObject({ code: "AttemptMismatch" });
    expect(
      await getActiveExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
      }),
    ).toBeNull();
  });

  it("FENCE-19: Acquire 复核 Lease 冻结的 Revision，换 Revision 的预备证据不可执行", async () => {
    const tenant = await ensureDefaultTenant();
    const environment = await createEnvironmentDefinition({
      tenantId: tenant.id,
      environmentKey: `ownership-managed-${randomUUID()}`,
      displayName: "执行权环境",
      revision: environmentRevisionInput(),
    });
    const other = await createEnvironmentDefinition({
      tenantId: tenant.id,
      environmentKey: `ownership-other-${randomUUID()}`,
      displayName: "另一个环境",
      revision: environmentRevisionInput({ networkPolicyJson: { egress: "allow_https" } }),
    });
    const pinned = await getEnvironmentRevisionById(tenant.id, environment.currentRevisionId!);
    const otherRevision = await getEnvironmentRevisionById(tenant.id, other.currentRevisionId!);
    if (!pinned || !otherRevision) throw new Error("EnvironmentRevision fixture missing");
    const fixture = await seedPreparedRuntimeAttempt({
      tenantId: tenant.id,
      environmentDefinitionRevisionId: pinned.id,
    });
    // 事实上的"另一 Revision 的已核验准备证据"：形状完好，但不是 Binding 冻结的那一份。
    const foreignLease = await seedPreparedEnvironmentLease({
      tenantId: tenant.id,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      revision: otherRevision,
      workspaceBindingId: fixture.binding.workspaceBindingId,
    });

    await expect(
      acquireExecutionOwnership({
        tenantId: tenant.id,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        environmentLeaseId: foreignLease.id,
        acquiredByType: "service",
        acquiredById: "late-runtime",
      }),
    ).rejects.toThrow("EnvironmentRevisionMismatch");
    expect(
      await getActiveExecutionOwnership({
        tenantId: tenant.id,
        invocationId: fixture.invocation.id,
      }),
    ).toBeNull();

    // 正对照：Binding 冻结 Revision 与 Lease 一致时可以取得执行权（证明上面的拒绝来自
    // Revision 不匹配，而不是该路径恒失败）。`EnvironmentLease` 对
    // `(tenantId, invocationId, attemptId)` 唯一（同 Attempt 复用同一 Lease），
    // 因此正对照用独立夹具而不是同一 Attempt 的第二条 Lease。
    const matching = await seedPreparedRuntimeAttempt({
      tenantId: tenant.id,
      environmentDefinitionRevisionId: pinned.id,
    });
    const matchingLease = await seedPreparedEnvironmentLease({
      tenantId: tenant.id,
      invocationId: matching.invocation.id,
      attemptId: matching.attempt.id,
      revision: pinned,
      workspaceBindingId: matching.binding.workspaceBindingId,
    });
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: tenant.id,
      invocationId: matching.invocation.id,
      attemptId: matching.attempt.id,
      runtimeRevisionId: matching.binding.runtimeRevisionId,
      environmentLeaseId: matchingLease.id,
    });
    expect(acquired.ownership.environmentLeaseId).toBe(matchingLease.id);
  });

  it("FENCE-20: Acquire 复核 Prepared 证据有效期，过期证据不可执行", async () => {
    const tenant = await ensureDefaultTenant();
    const environment = await createEnvironmentDefinition({
      tenantId: tenant.id,
      environmentKey: `ownership-expiry-${randomUUID()}`,
      displayName: "过期证据环境",
      revision: environmentRevisionInput(),
    });
    const revision = await getEnvironmentRevisionById(tenant.id, environment.currentRevisionId!);
    if (!revision) throw new Error("EnvironmentRevision fixture missing");
    const fixture = await seedPreparedRuntimeAttempt({
      tenantId: tenant.id,
      environmentDefinitionRevisionId: revision.id,
    });
    // 写入时有效（`now` 在窗口内），Acquire 时才过期——Acquire 必须用 DB Authority 时间
    // 判有效期，不能只信 Lease 的 readinessState 字段。
    const staleLease = await seedPreparedEnvironmentLease({
      tenantId: tenant.id,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      revision,
      workspaceBindingId: fixture.binding.workspaceBindingId,
      now: new Date(Date.now() - ENVIRONMENT_PREPARED_TTL_MS - 60_000),
    });

    await expect(
      acquireExecutionOwnership({
        tenantId: tenant.id,
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        environmentLeaseId: staleLease.id,
        acquiredByType: "service",
        acquiredById: "late-runtime",
      }),
    ).rejects.toThrow("PreparedEvidence 已过期");
    expect(
      await getActiveExecutionOwnership({
        tenantId: tenant.id,
        invocationId: fixture.invocation.id,
      }),
    ).toBeNull();
  });
});
