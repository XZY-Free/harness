/**
 * Session Dispatch Claim 身份与可见性（R04 §5）。
 *
 * 真实验证四条不变量：
 * 1. 扫描只取候选 ID，结论在领取事务里按对象自身根重做；
 * 2. `nextDispatchAt` 为空不会让"已持久但进程在填 retry 时间前 Crash"的工作永久不可见；
 * 3. 所有完成确认（计数、暂态重试排定、attempt 置终态）带 Session + Ownership + claim token；
 * 4. 过期 Worker 的迟到结论不能改新 claim 的结果。
 */
import { randomUUID } from "node:crypto";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createAttempt } from "@/lib/executions/persistence/attempt-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  invocationAttemptTable,
  invocationCommandTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import {
  DISPATCH_STUCK_GRACE_MS,
  SessionDispatchClaimSupersededError,
  claimInvocationCommandDispatch,
  claimSessionDispatch,
  recordAttemptDispatchTransientFailure,
  recordSessionDispatchAttemptStarted,
  scanDueInvocationCommandDispatches,
  scanDueSessionDispatches,
  scheduleCommandTransientRetry,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";
const LEASE_MS = 60_000;

async function readSession(id: string) {
  const [row] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(eq(runtimeSessionBindingTable.id, id))
    .limit(1);
  if (!row) throw new Error("RuntimeSessionBinding 不存在");
  return row;
}

async function readAttempt(id: string) {
  const [row] = await db
    .select()
    .from(invocationAttemptTable)
    .where(eq(invocationAttemptTable.id, id))
    .limit(1);
  if (!row) throw new Error("InvocationAttempt 不存在");
  return row;
}

describe("Session dispatch claim integration", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  /** 建立一个真实的 dispatching Session（Attempt queued）。 */
  async function dispatchingFixture(options: { dueInMs?: number } = {}) {
    const fixture = await seedPreparedRuntimeAttempt();
    const authority = await acquireTestRuntimeAuthority({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
    });
    // canonical 约束（RuntimeSessionBinding_dispatch_freeze_shape）：
    // bindingState=dispatching 必须同时冻结语义请求 + digest + intentFrozenAt。
    const semanticRequest = {
      kind: "session-dispatch-claim-fixture",
      invocationId: fixture.invocation.id,
    };
    await applyRuntimeSessionDispatchForTest(TENANT_ID, authority.session.id, {
      bindingState: "dispatching",
      semanticRequestJson: semanticRequest,
      semanticRequestDigest: protocolDigest(semanticRequest),
      nextDispatchAt: new Date(Date.now() + (options.dueInMs ?? -1_000)),
    });
    return { fixture, authority, session: await readSession(authority.session.id) };
  }

  it("CLAIM-01: 扫描只取候选 ID，领取时按对象自身根重新验证 state/lease", async () => {
    const { fixture, authority } = await dispatchingFixture();
    const now = new Date();
    const candidates = await scanDueSessionDispatches({ now, limit: 10 });
    expect(candidates.map((candidate) => candidate.sessionBindingId)).toEqual([
      authority.session.id,
    ]);

    // 扫描之后 Attempt 被置终态：领取必须放弃候选，且不留下任何 lease。
    // canonical 约束（InvocationAttempt_terminal_shape）：终态必须带 finishedAt。
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "failed", finishedAt: now, updatedAt: now })
      .where(eq(invocationAttemptTable.id, fixture.attempt.id));
    const claim = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      attemptId: fixture.attempt.id,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    expect(claim).toBeNull();
    const session = await readSession(authority.session.id);
    expect(session.dispatchLeaseOwner).toBeNull();
    expect(session.dispatchLeaseExpiresAt).toBeNull();
  });

  it("CLAIM-02: nextDispatchAt 为空的工作在安全窗口后可见（不会永久不可见）", async () => {
    const { authority } = await dispatchingFixture();
    const now = new Date();
    await applyRuntimeSessionDispatchForTest(TENANT_ID, authority.session.id, {
      nextDispatchAt: null,
    });
    // 刚写完（进程可能仍在运行）：窗口内不可见，避免与请求内联调度竞争。
    const fresh = await scanDueSessionDispatches({ now, limit: 10 });
    expect(fresh).toHaveLength(0);

    // 静默超过安全窗口：可见并可领取。
    await db
      .update(runtimeSessionBindingTable)
      .set({ updatedAt: new Date(now.getTime() - DISPATCH_STUCK_GRACE_MS - 1) })
      .where(eq(runtimeSessionBindingTable.id, authority.session.id));
    const stale = await scanDueSessionDispatches({ now, limit: 10 });
    expect(stale.map((candidate) => candidate.sessionBindingId)).toEqual([authority.session.id]);
    const claim = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      attemptId: stale[0]?.attemptId as string,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    expect(claim?.claimToken).toBe("worker:1");
    expect(claim?.sessionBindingId).toBe(authority.session.id);
  });

  it("CLAIM-03: 完成确认带 claim 身份，过期 Worker 不能改新 claim 的结果", async () => {
    const { fixture, authority } = await dispatchingFixture();
    const now = new Date();
    const first = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    if (!first) throw new Error("claim missing");
    await recordSessionDispatchAttemptStarted(first, now);
    const afterFirst = await readSession(authority.session.id);
    expect(afterFirst.dispatchCount).toBe(1);
    expect(afterFirst.lastDispatchAt).not.toBeNull();

    // 领取权过期后由另一个 Worker 接管。
    const takeoverAt = new Date(now.getTime() + LEASE_MS + 1);
    const second = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      leaseOwner: "worker:2",
      leaseDurationMs: LEASE_MS,
      now: takeoverAt,
    });
    expect(second?.claimToken).toBe("worker:2");

    // 旧 Worker 的迟到完成确认被拒，且不改变行。
    await expect(recordSessionDispatchAttemptStarted(first, takeoverAt)).rejects.toBeInstanceOf(
      SessionDispatchClaimSupersededError,
    );
    const stillSecond = await readSession(authority.session.id);
    expect(stillSecond.dispatchCount).toBe(1);
    expect(stillSecond.dispatchLeaseOwner).toBe("worker:2");

    await recordSessionDispatchAttemptStarted(second as NonNullable<typeof second>, takeoverAt);
    const afterSecond = await readSession(authority.session.id);
    expect(afterSecond.dispatchCount).toBe(2);
    expect(fixture.attempt.id).toBe(authority.session.attemptId);
  });

  it("V02: claim 已过期但尚未被接管时，发送与失败尾部也不能提交", async () => {
    const { fixture, authority } = await dispatchingFixture();
    const claim = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      leaseOwner: "worker:expired",
      leaseDurationMs: LEASE_MS,
      now: new Date(),
    });
    if (!claim) throw new Error("claim missing");
    await db
      .update(runtimeSessionBindingTable)
      .set({ dispatchLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(runtimeSessionBindingTable.id, authority.session.id));
    const before = await readSession(authority.session.id);
    await expect(recordSessionDispatchAttemptStarted(claim, new Date())).rejects.toBeInstanceOf(
      SessionDispatchClaimSupersededError,
    );
    await expect(
      recordAttemptDispatchTransientFailure(claim, {
        errorCode: "runtime_network_unavailable",
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(SessionDispatchClaimSupersededError);
    expect(await readSession(authority.session.id)).toEqual(before);
    expect((await readAttempt(fixture.attempt.id)).attemptState).toBe("queued");
  });

  it("CLAIM-04: 暂态重试排定按 claim 身份复核；错身份被拒且状态不变", async () => {
    const { authority } = await dispatchingFixture();
    const now = new Date();
    const claim = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    if (!claim) throw new Error("claim missing");
    // 生产顺序：领取 → 记一次 dispatch 开始（计数 +1）→ 暂态失败排定（不再重复计数）。
    await recordSessionDispatchAttemptStarted(claim, now);
    const outcome = await recordAttemptDispatchTransientFailure(claim, {
      errorCode: "runtime_unavailable",
      now,
      counted: true,
    });
    expect(outcome.outcome).toBe("scheduled");
    expect(outcome.dispatchCount).toBe(1);
    const scheduled = await readSession(authority.session.id);
    expect(scheduled.dispatchLeaseOwner).toBeNull();
    expect(scheduled.lastErrorCode).toBe("runtime_unavailable");

    // 已失去领取权的旧身份再次排定 → 拒绝，且 session 不被改写。
    await db
      .update(runtimeSessionBindingTable)
      .set({ dispatchLeaseOwner: "worker:9" })
      .where(eq(runtimeSessionBindingTable.id, authority.session.id));
    const before = await readSession(authority.session.id);
    await expect(
      recordAttemptDispatchTransientFailure(claim, {
        errorCode: "runtime_network_unavailable",
        now: new Date(now.getTime() + 1_000),
        counted: true,
      }),
    ).rejects.toBeInstanceOf(SessionDispatchClaimSupersededError);
    const after = await readSession(authority.session.id);
    expect(after.lastErrorCode).toBe(before.lastErrorCode);
    expect(after.dispatchCount).toBe(before.dispatchCount);
  });

  it("CLAIM-05: 命令 lane 领取与重试排定同样带 claim 身份", async () => {
    const { fixture, authority } = await dispatchingFixture();
    const now = new Date();
    const commandId = randomUUID();
    const commandPayload = { kind: "claim-05", commandId };
    await db.insert(invocationCommandTable).values({
      id: commandId,
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      commandType: "cancel",
      payloadJson: commandPayload,
      payloadDigest: computeInvocationCommandPayloadHash(commandPayload),
      commandState: "dispatched",
      idempotencyKey: `claim-05:${commandId}`,
      dispatchCount: 1,
      nextDispatchAt: new Date(now.getTime() - 1_000),
      targetOwnershipId: authority.ownership.id,
      targetSessionId: authority.session.id,
      requestedByType: "system",
      requestedById: "session-dispatch-claim-fixture",
    });

    const candidates = await scanDueInvocationCommandDispatches({ now, limit: 10 });
    expect(candidates).toContain(commandId);
    const claim = await claimInvocationCommandDispatch({
      commandId,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    expect(claim?.claimToken).toBe("worker:1");

    const scheduled = await scheduleCommandTransientRetry(
      { tenantId: TENANT_ID, commandId, claimToken: "worker:1" },
      { errorCode: "runtime_unavailable", now },
    );
    expect(scheduled.outcome).toBe("scheduled");
    const [afterSchedule] = await db
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, TENANT_ID),
          eq(invocationCommandTable.id, commandId),
        ),
      )
      .limit(1);
    expect(afterSchedule?.dispatchLeaseOwner).toBeNull();
    expect(afterSchedule?.nextDispatchAt?.getTime()).toBeGreaterThan(now.getTime());

    // 过期 Worker 的迟到结论被拒。
    await expect(
      scheduleCommandTransientRetry(
        { tenantId: TENANT_ID, commandId, claimToken: "worker:1" },
        { errorCode: "runtime_unavailable", now },
      ),
    ).rejects.toBeInstanceOf(SessionDispatchClaimSupersededError);
  });

  it("CLAIM-06: 领取后 Attempt 非 queued 的候选被放弃，不产生 lease", async () => {
    const { fixture, authority } = await dispatchingFixture();
    const now = new Date();
    const other = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    const claim = await claimSessionDispatch({
      sessionBindingId: authority.session.id,
      attemptId: other.id,
      leaseOwner: "worker:1",
      leaseDurationMs: LEASE_MS,
      now,
    });
    // 扫描候选与行内 Attempt 不一致 → 放弃。
    expect(claim).toBeNull();
    const session = await readSession(authority.session.id);
    expect(session.attemptId).toBe(fixture.attempt.id);
    expect(session.dispatchLeaseOwner).toBeNull();
    expect((await readAttempt(fixture.attempt.id)).attemptState).toBe("queued");
  });
});
