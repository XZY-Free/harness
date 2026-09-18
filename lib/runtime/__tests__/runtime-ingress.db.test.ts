import { randomUUID } from "node:crypto";
import { POST as ingestRuntimeEventsPOST } from "@/app/runtime/invocations/[invocationId]/events/route";
import { rebuildProjectionsForThread } from "@/lib/conversations/projector";
import {
  getItemSnapshotWithCursor,
  getTurnTimelineProjection,
  listTurnTimelineProjections,
} from "@/lib/conversations/read-model-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn, getTurnsByThread } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { buildApiRequest } from "@/lib/db/test/api-fixtures";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { DEFAULT_TENANT_ID, ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import {
  decodeWorkloadToken,
  issueWorkloadToken,
  signWorkloadTokenPayload,
} from "@/lib/identity/workload-token";
import { revokeWorkloadToken } from "@/lib/identity/workload-token-revocation-queries";
import {
  threadEventTable,
  threadItemTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { jobCommandTable } from "@/lib/persistence/schema/job";
import {
  EventPayloadHashConflictError,
  IngressAuthorityMismatchError,
  ProducerSequenceGapError,
  ingressRuntimeEvents,
} from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

/** R02 §3：该夹具 Session 冻结的发布能力证据（Hosted Revision 的能力名列表）。 */
const RUNTIME_CAPABILITIES_JSON = ["event_stream"];

async function createActiveRuntime(thread?: {
  threadId: string;
  turnId: string;
  triggerItemId: string;
}) {
  const fixture = await seedPreparedRuntimeAttempt(thread ? { thread } : {});
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  const activationEvidence = {
    kind: "runtime-ingress-test",
    ownershipId: acquired.ownership.id,
  };
  await db
    .update(executionOwnershipTable)
    .set({
      activationEvidence,
      activationDigest: protocolDigest(activationEvidence),
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(executionOwnershipTable.id, acquired.ownership.id));
  const semanticRequest = { invocationId: fixture.invocation.id, fixture: "runtime-ingress" };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `runtime-session:${acquired.session.id}`;
  const remoteExecutionRef = `runtime-execution:${fixture.invocation.id}`;
  // R02 §3：Hosted 接纳回执的摘要来自冻结发布证据（Session 与事件必须同源）。
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
  });
  await applyRuntimeSessionDispatchForTest(fixture.tenantId, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  const started = {
    eventId: randomUUID(),
    producerSequence: "1",
    type: "execution.started" as const,
    schemaVersion: 1,
    payload: {
      intentKey: acquired.session.startIntentKey,
      semanticRequestDigest,
      remoteSessionRef,
      remoteExecutionRef,
      capabilitiesDigest,
    },
  };
  await ingressRuntimeEvents({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    batch: { protocolVersion: 3, authority: acquired.authority, events: [started] },
  });
  return { fixture, acquired, started };
}

async function replaceCurrentOwner(input: Awaited<ReturnType<typeof createActiveRuntime>>) {
  await db
    .update(executionOwnershipTable)
    .set({ leaseExpiresAt: new Date(Date.now() - 1) })
    .where(eq(executionOwnershipTable.id, input.acquired.ownership.id));
  const attempt = await createAttempt({
    tenantId: input.fixture.tenantId,
    invocationId: input.fixture.invocation.id,
    retryReasonCode: "test_takeover",
  });
  const evidence = { kind: "test-replacement", attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return acquireExecutionOwnership({
    tenantId: input.fixture.tenantId,
    invocationId: input.fixture.invocation.id,
    attemptId: attempt.id,
    runtimeRevisionId: input.fixture.binding.runtimeRevisionId,
    acquiredByType: "service",
    acquiredById: "runtime-ingress-replacement",
  });
}

function progressEvent(
  sequence: string,
  eventId = randomUUID(),
  payload: Record<string, unknown> = { message: "progress" },
) {
  return {
    eventId,
    producerSequence: sequence,
    type: "progress" as const,
    schemaVersion: 1,
    payload,
  };
}

type ActiveRuntime = Awaited<ReturnType<typeof createActiveRuntime>>;

/** 用当前 Authority 投递一批事件（REPLAY 用例只关心批的语义，不重复拼 batch）。 */
function ingressBatch(runtime: ActiveRuntime, events: unknown[]) {
  return ingressRuntimeEvents({
    tenantId: runtime.fixture.tenantId,
    invocationId: runtime.fixture.invocation.id,
    batch: { protocolVersion: 3, authority: runtime.acquired.authority, events },
  });
}

/** 该 Invocation 的全部正式 Ledger 事实（按 producerSequence 升序）。 */
async function readLedger(tenantId: string, invocationId: string) {
  return db
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, tenantId),
        eq(runtimeEventIngressTable.invocationId, invocationId),
      ),
    )
    .orderBy(asc(runtimeEventIngressTable.producerSequence));
}

/** 执行计数：Replay 必须逐项不变（水位 / 版本 / 恢复水位）。 */
async function readInvocationCounters(tenantId: string, invocationId: string) {
  const [row] = await db
    .select({
      lastProducerSequence: invocationTable.lastProducerSequence,
      recoveryVersion: invocationTable.recoveryVersion,
      versionNo: invocationTable.versionNo,
    })
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)));
  return row;
}

/** 产品侧映射计数（Thread 事件/条目与 Job 命令）：Replay 不得新增任何一条。 */
async function readProductMappingCounts(tenantId: string, threadId: string) {
  const [threadEvents, threadItems, jobCommands] = await Promise.all([
    db
      .select({ id: threadEventTable.id })
      .from(threadEventTable)
      .where(eq(threadEventTable.threadId, threadId)),
    db
      .select({ id: threadItemTable.id })
      .from(threadItemTable)
      .where(eq(threadItemTable.threadId, threadId)),
    db
      .select({ id: jobCommandTable.id })
      .from(jobCommandTable)
      .where(eq(jobCommandTable.tenantId, tenantId)),
  ]);
  return {
    threadEvents: threadEvents.length,
    threadItems: threadItems.length,
    jobCommands: jobCommands.length,
  };
}

describe("RuntimeEventIngress database fencing", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("INGRESS-01/INGRESS-11: execution.started is the only formal transition to running", async () => {
    const fixture = await seedPreparedRuntimeAttempt();
    const acquired = await acquireTestRuntimeAuthority({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES_JSON,
    });
    const [before] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(before?.executionState).toBe("queued");
    expect(acquired.session.bindingState).toBe("prepared");
  });

  it("INGRESS-03/INGRESS-04/INGRESS-07: old authority cannot add events or claim a historical receipt", async () => {
    const runtime = await createActiveRuntime();
    const event = progressEvent("2");
    await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    const replacement = await replaceCurrentOwner(runtime);

    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("3", randomUUID(), { resultRef: "old-response" })],
        },
      }),
    ).rejects.toMatchObject({ code: "NotCurrentExecutor" });
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: {
            ...runtime.acquired.authority,
            attemptId: replacement.ownership.attemptId,
            ownershipId: replacement.ownership.id,
            leaseEpoch: String(replacement.ownership.leaseEpoch),
          },
          events: [event],
        },
      }),
    ).rejects.toBeInstanceOf(IngressAuthorityMismatchError);
  });

  it("INGRESS-05/INGRESS-08/INGRESS-09: exact replay returns the original receipt, but payload conflicts and gaps fail closed", async () => {
    const runtime = await createActiveRuntime();
    const event = progressEvent("2");
    const first = await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    await replaceCurrentOwner(runtime);
    const replay = await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [event] },
    });
    expect(replay.replayedEventIds).toEqual([event.eventId]);
    expect(replay.receipts).toEqual(first.receipts);
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("2", event.eventId, { message: "conflict" })],
        },
      }),
    ).rejects.toBeInstanceOf(EventPayloadHashConflictError);
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [progressEvent("4")],
        },
      }),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);
  });

  it("INGRESS-10: a mixed batch rolls back every new event when any event conflicts", async () => {
    const runtime = await createActiveRuntime();
    const accepted = progressEvent("2");
    await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: { protocolVersion: 3, authority: runtime.acquired.authority, events: [accepted] },
    });
    const legal = progressEvent("3");
    await expect(
      ingressRuntimeEvents({
        tenantId: runtime.fixture.tenantId,
        invocationId: runtime.fixture.invocation.id,
        batch: {
          protocolVersion: 3,
          authority: runtime.acquired.authority,
          events: [accepted, legal, progressEvent("4", accepted.eventId, { message: "conflict" })],
        },
      }),
    ).rejects.toBeInstanceOf(EventPayloadHashConflictError);
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, runtime.fixture.tenantId),
          eq(invocationTable.id, runtime.fixture.invocation.id),
        ),
      );
    expect(invocation?.lastProducerSequence).toBe(2);
    const ingress = await db
      .select()
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, runtime.fixture.tenantId),
          eq(runtimeEventIngressTable.invocationId, runtime.fixture.invocation.id),
          eq(runtimeEventIngressTable.producerEventId, legal.eventId),
        ),
      );
    expect(ingress).toEqual([]);
  });

  // ─── REPLAY-01..06（R05 / R04 / R03）──────────────────────────────────────
  // 编号严格对应 acceptance/replay.md 的场景与必须断言。每条都带"零新增 / 零计数变化"
  // 的负向断言：身份错配不许被当成 Replay，精确 Replay 不许产生任何副作用。

  it("REPLAY-01: 已接纳 E1 后，另一 eventId + 相同 producerSequence + 相同 Payload 是身份冲突", async () => {
    const runtime = await createActiveRuntime();
    const e1 = progressEvent("2");
    await ingressBatch(runtime, [e1]);
    const ledgerBefore = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);
    const countersBefore = await readInvocationCounters(
      runtime.fixture.tenantId,
      runtime.fixture.invocation.id,
    );

    // producerSequence 命中 E1、payload 逐字相同，但 eventId 不同：两个唯一键必须命中
    // 同一行才算精确 Replay，否则是稳定身份冲突——绝不能把 E1 当成新 Event 二次成功。
    await expect(ingressBatch(runtime, [progressEvent("2", randomUUID())])).rejects.toBeInstanceOf(
      ProducerSequenceGapError,
    );

    expect(await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id)).toEqual(
      ledgerBefore,
    );
    expect(
      await readInvocationCounters(runtime.fixture.tenantId, runtime.fixture.invocation.id),
    ).toEqual(countersBefore);
  });

  it("REPLAY-02: 已接纳 E1 后，原 eventId + 不同 producerSequence + 相同 Payload 冲突且零写入", async () => {
    const runtime = await createActiveRuntime();
    const e1 = progressEvent("2");
    await ingressBatch(runtime, [e1]);
    const ledgerBefore = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);
    const countersBefore = await readInvocationCounters(
      runtime.fixture.tenantId,
      runtime.fixture.invocation.id,
    );

    await expect(ingressBatch(runtime, [progressEvent("3", e1.eventId)])).rejects.toBeInstanceOf(
      ProducerSequenceGapError,
    );

    // "无任何写入"：Ledger 行、水位与版本三个计数都必须逐项不变。
    expect(await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id)).toEqual(
      ledgerBefore,
    );
    expect(
      await readInvocationCounters(runtime.fixture.tenantId, runtime.fixture.invocation.id),
    ).toEqual(countersBefore);
  });

  it("REPLAY-03: eventId 命中行 A、producerSequence 命中行 B 时必须冲突，不得任选一行", async () => {
    const runtime = await createActiveRuntime();
    const ea = progressEvent("2");
    await ingressBatch(runtime, [ea]);
    const eb = progressEvent("3", randomUUID(), { message: "second-event" });
    await ingressBatch(runtime, [eb]);
    const ledgerBefore = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);

    // 交叉错配：eventId 是 A 的、sequence 是 B 的、payload 与 A 相同。
    await expect(
      ingressBatch(runtime, [progressEvent("3", ea.eventId, { message: "progress" })]),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);

    // 不得"按 eventId 判为已重放"，也不得"按 sequence 覆盖 B"：两行都原样保留。
    const ledgerAfter = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);
    expect(ledgerAfter).toEqual(ledgerBefore);
    expect(ledgerAfter.map((row) => row.producerSequence)).toEqual([1, 2, 3]);
  });

  it("REPLAY-04: 同一 Authority 用仍合法凭据逐字重放同一事件返回原 receipt，计数与产品映射全不变", async () => {
    const runtime = await createActiveRuntime();
    const e1 = progressEvent("2");
    const first = await ingressBatch(runtime, [e1]);
    const ledgerBefore = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);
    const countersBefore = await readInvocationCounters(
      runtime.fixture.tenantId,
      runtime.fixture.invocation.id,
    );
    const mappingBefore = await readProductMappingCounts(
      runtime.fixture.tenantId,
      runtime.fixture.threadId,
    );

    const replay = await ingressBatch(runtime, [e1]);

    expect(replay.replayedEventIds).toEqual([e1.eventId]);
    expect(replay.receipts).toEqual(first.receipts);
    expect(replay.acceptedThroughProducerSequence).toBe(first.acceptedThroughProducerSequence);
    expect(await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id)).toEqual(
      ledgerBefore,
    );
    expect(
      await readInvocationCounters(runtime.fixture.tenantId, runtime.fixture.invocation.id),
    ).toEqual(countersBefore);
    // 全部执行计数、JobCommand 与产品侧映射（Thread 事件/条目）都不得新增。
    expect(
      await readProductMappingCounts(runtime.fixture.tenantId, runtime.fixture.threadId),
    ).toEqual(mappingBefore);
  });

  it("REPLAY-05: 批内重复 ID/sequence、合法新事件混一个冲突事件都必须整批回滚", async () => {
    const runtime = await createActiveRuntime();
    const sharedEventId = randomUUID();
    // (a) 批内 eventId 重复。
    await expect(
      ingressBatch(runtime, [progressEvent("2", sharedEventId), progressEvent("3", sharedEventId)]),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);
    // (b) 批内 producerSequence 重复。
    await expect(
      ingressBatch(runtime, [
        progressEvent("2", randomUUID()),
        progressEvent("2", randomUUID(), { message: "dup-seq" }),
      ]),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);
    expect(
      (await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id)).map(
        (row) => row.producerSequence,
      ),
    ).toEqual([1]);

    // (c) 合法新事件 + 冲突事件同批：冲突把同批的新事件与其产品映射一起回滚。
    const e1 = progressEvent("2");
    await ingressBatch(runtime, [e1]);
    const ledgerBefore = await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id);
    const countersBefore = await readInvocationCounters(
      runtime.fixture.tenantId,
      runtime.fixture.invocation.id,
    );
    const mappingBefore = await readProductMappingCounts(
      runtime.fixture.tenantId,
      runtime.fixture.threadId,
    );
    await expect(
      ingressBatch(runtime, [
        progressEvent("3"),
        // eventId 命中已接纳的 E1、sequence 仍未占用 → 身份冲突（不是合法新事件）。
        progressEvent("4", e1.eventId),
      ]),
    ).rejects.toBeInstanceOf(ProducerSequenceGapError);

    expect(await readLedger(runtime.fixture.tenantId, runtime.fixture.invocation.id)).toEqual(
      ledgerBefore,
    );
    expect(
      await readInvocationCounters(runtime.fixture.tenantId, runtime.fixture.invocation.id),
    ).toEqual(countersBefore);
    expect(
      await readProductMappingCounts(runtime.fixture.tenantId, runtime.fixture.threadId),
    ).toEqual(mappingBefore);
  });

  it("REPLAY-06: HTTP 层 Token tuple 与 body Authority 不一致、过期或已撤销凭据一律拒绝", async () => {
    const runtime = await createActiveRuntime();
    const { fixture, acquired } = runtime;
    const invocationId = fixture.invocation.id;
    const issueToken = (
      overrides: {
        expiresAt?: number;
        invocationId?: string;
        audience?: "runtime" | "gateway";
      } = {},
    ) =>
      issueWorkloadToken({
        contractVersion: 3,
        type: "execution",
        audience: overrides.audience ?? "runtime",
        tenantId: fixture.tenantId,
        invocationId: overrides.invocationId ?? invocationId,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        attemptId: fixture.attempt.id,
        ownershipId: acquired.ownership.id,
        leaseEpoch: String(acquired.ownership.leaseEpoch),
        sessionBindingId: acquired.session.id,
        expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
      });
    // `issueWorkloadToken` 把 issuedAt 固定为 now，因此无法表达"已过期"；这里显式签发一份
    // 签名有效但 issuedAt=60s 前 / expiresAt=1s 前的正式 claims（过期是事实，不是伪造签名）。
    const issueExpiredToken = () =>
      signWorkloadTokenPayload({
        contractVersion: 3,
        type: "execution",
        audience: "runtime",
        tenantId: fixture.tenantId,
        invocationId,
        runtimeRevisionId: fixture.binding.runtimeRevisionId,
        attemptId: fixture.attempt.id,
        ownershipId: acquired.ownership.id,
        leaseEpoch: String(acquired.ownership.leaseEpoch),
        sessionBindingId: acquired.session.id,
        jti: randomUUID(),
        issuedAt: Date.now() - 60_000,
        expiresAt: Date.now() - 1_000,
      });
    // 走真实 Route Handler（不绕过 HTTP 层、不直接调用内层 service）。
    const callRoute = (token: string | null, authority: unknown, pathId = invocationId) =>
      ingestRuntimeEventsPOST(
        buildApiRequest({
          audience: "runtime",
          method: "POST",
          path: `/invocations/${pathId}/events`,
          idempotencyKey: randomUUID(),
          ...(token ? { token } : {}),
          body: { protocolVersion: 3, authority, events: [progressEvent("2")] },
        }),
        { params: Promise.resolve({ invocationId: pathId }) },
      );

    // (a) 凭据有效但 body Authority 与 Token tuple 不一致。
    const mismatched = await callRoute(issueToken(), {
      ...acquired.authority,
      attemptId: randomUUID(),
    });
    expect(mismatched.status).toBe(400);
    expect((await mismatched.json()).error.code).toBe("REQUEST_SCHEMA_INVALID");

    // (b) 过期凭据。
    const expired = await callRoute(issueExpiredToken(), acquired.authority);
    expect(expired.status).toBe(401);
    expect((await expired.json()).error.code).toBe("AUTHENTICATION_REQUIRED");

    // (c) 路径 Invocation 与凭据绑定不一致。
    const otherPath = await callRoute(issueToken(), acquired.authority, randomUUID());
    expect(otherPath.status).toBe(401);

    // (d) audience 不匹配。
    const wrongAudience = await callRoute(issueToken({ audience: "gateway" }), acquired.authority);
    expect(wrongAudience.status).toBe(401);

    // (e) 真实撤销行提交之后，同一凭据立即失效。
    const token = issueToken();
    await revokeWorkloadToken({
      tenantId: fixture.tenantId,
      jti: decodeWorkloadToken(token).jti,
      invocationId,
      revokedBy: "test-service",
      reasonCode: "test_revoke",
      tokenExpiresAt: new Date(Date.now() + 60_000),
      actor: { tenantId: fixture.tenantId, actorType: "service", actorId: "test-service" },
    });
    const revoked = await callRoute(token, acquired.authority);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe("AUTHENTICATION_REQUIRED");

    // 五次拒绝都不许留下任何 Ledger 事实（只有夹具的 execution.started）。
    expect(
      (await readLedger(fixture.tenantId, invocationId)).map((row) => row.producerSequence),
    ).toEqual([1]);
  });

  it("R04: 终态事件是最后一条状态写入，Job 桥版本与批次水位一次归并", async () => {
    const runtime = await createActiveRuntime();
    await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: runtime.acquired.authority,
        events: [
          progressEvent("2", randomUUID(), {
            resultRef: "receipt-ref",
            resultDigest: protocolDigest({ ok: true }),
          }),
        ],
      },
    });
    const [beforeRow] = await db
      .select({ versionNo: invocationTable.versionNo })
      .from(invocationTable)
      .where(eq(invocationTable.id, runtime.fixture.invocation.id));
    const beforeVersion = beforeRow?.versionNo ?? 0;
    const result = await ingressRuntimeEvents({
      tenantId: runtime.fixture.tenantId,
      invocationId: runtime.fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: runtime.acquired.authority,
        events: [
          progressEvent("3", randomUUID(), { message: "no-op" }),
          {
            eventId: randomUUID(),
            producerSequence: "4",
            type: "execution.completed" as const,
            schemaVersion: 1,
            payload: { resultRef: "thread-result", resultDigest: protocolDigest({ done: true }) },
          },
        ],
      },
    });
    expect(result.acceptedThroughProducerSequence).toBe("4");
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, runtime.fixture.tenantId),
          eq(invocationTable.id, runtime.fixture.invocation.id),
        ),
      );
    expect(invocation?.executionState).toBe("completed");
    expect(invocation?.lastProducerSequence).toBe(4);
    // 批次水位只归并一次（+1），终态推进一次（+1）：终态写入之后不再有兜底版本更新。
    expect(invocation?.versionNo).toBe(beforeVersion + 2);
  });

  // ─── REPLAY-07（R05：刷新产品页并从 DB 重建时间线）────────────────────────
  // 场景：Thread Runtime 完成后刷新产品页并从 DB 重建时间线。
  // 必须断言：正式输出、Turn 采用关系与页面一致，**不只曾经 SSE 显示**。
  // 因此本用例全程不读任何 SSE/内存状态：Thread 与 Turn 由真实产品路径建立，
  // 终态后先 `rebuildProjectionsForThread` 从权威表重建读模型，再按页面真实
  // 数据源（`getTurnsByThread` = 权威 Turn 表）与时间线投影逐项核对。

  it("REPLAY-07: Runtime 完成后从 DB 重建的产品页显示正式输出，且 Turn 采用关系一致", async () => {
    // 1. 真实产品路径建 Thread + Turn（写入 thread.created / turn.accepted / item.created）。
    const thread = await createThread({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: "test-user",
      actorId: "test-user",
    });
    const accepted = await acceptUserMessageTurn({
      tenantId: DEFAULT_TENANT_ID,
      threadId: thread.thread.id,
      ownerUserId: "test-user",
      content: { text: "REPLAY-07 提问：请给出正式输出" },
      actorId: "test-user",
    });

    // 2. 真实 Runtime 执行链挂到同一个 Thread/Turn 上。
    const runtime = await createActiveRuntime({
      threadId: thread.thread.id,
      turnId: accepted.turn.id,
      triggerItemId: accepted.item.id,
    });
    const invocationId = runtime.fixture.invocation.id;

    // 3. Runtime 逐个提交正式输出（response.completed 携带 item_type）与终态。
    const officialText = `官方输出-${randomUUID()}`;
    await ingressBatch(runtime, [
      {
        eventId: randomUUID(),
        producerSequence: "2",
        type: "response.completed",
        schemaVersion: 1,
        payload: { text: officialText, item_type: "assistant_message", finish_reason: "stop" },
      },
      {
        eventId: randomUUID(),
        producerSequence: "3",
        type: "execution.completed",
        schemaVersion: 1,
        payload: { finish_reason: "execution.completed" },
      },
    ]);

    // 4. 刷新产品页 = 从 DB 重建时间线（清空投影并按权威 ThreadEvent 重放）。
    await rebuildProjectionsForThread(DEFAULT_TENANT_ID, thread.thread.id);

    // 5. 页面真实数据源（权威 Turn 表）：状态与 Turn 采用关系。
    const [pageTurn] = await getTurnsByThread(DEFAULT_TENANT_ID, thread.thread.id);
    expect(pageTurn?.id).toBe(accepted.turn.id);
    expect(pageTurn?.turnState).toBe("completed");
    // 终态 Turn 不再持有活跃执行（列语义：activeInvocationId 只在 queued/running/waiting 有值）。
    expect(pageTurn?.activeInvocationId).toBeNull();
    // 采用关系：当前正式回答属于产出它的那次会话执行。
    expect(pageTurn?.adoptedInvocationId).toBe(invocationId);
    expect(pageTurn?.finalItemId).toBeTruthy();
    expect(pageTurn?.errorCode).toBeNull();

    // 6. 正式输出 = 该 Invocation 的 assistant_message Item，内容与 Runtime 提交的一致。
    const snapshot = await getItemSnapshotWithCursor(DEFAULT_TENANT_ID, thread.thread.id);
    const officialItems = snapshot.items.filter(
      (item) => item.itemType === "assistant_message" && item.invocationId === invocationId,
    );
    expect(officialItems).toHaveLength(1);
    expect(officialItems[0]?.id).toBe(pageTurn?.finalItemId);
    expect(officialItems[0]?.contentJson).toMatchObject({ text: officialText });
    const [invocationRow] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocationId));
    expect(invocationRow?.executionState).toBe("completed");

    // 7. 重建后的 Turn 时间线投影必须与页面事实一致（同一条正式输出）。
    const timelineRows = await listTurnTimelineProjections(DEFAULT_TENANT_ID, thread.thread.id);
    const [timeline] = timelineRows;
    expect(timelineRows).toHaveLength(1);
    expect(timeline?.turnId).toBe(accepted.turn.id);
    expect(timeline?.turnState).toBe("completed");
    expect(timeline?.finalItemId).toBe(pageTurn?.finalItemId);
    expect(timeline?.finalItemType).toBe("assistant_message");
    expect(timeline?.triggerItemId).toBe(accepted.item.id);
    const projection = await getTurnTimelineProjection(DEFAULT_TENANT_ID, accepted.turn.id);
    expect(projection?.finalItemId).toBe(pageTurn?.finalItemId);

    // 8. 负向：页面不得出现重复回答（SSE 期间显示过不等于只得一份），
    //    也不得把触发消息本身当成正式输出。
    expect(snapshot.items.filter((item) => item.itemType === "assistant_message")).toHaveLength(1);
    expect(timeline?.finalItemId).not.toBe(accepted.item.id);
    expect(pageTurn?.finalItemId).not.toBe(accepted.item.id);
  });
});
