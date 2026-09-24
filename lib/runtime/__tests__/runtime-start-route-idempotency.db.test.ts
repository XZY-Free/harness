/**
 * A04：Runtime HTTP Start 的幂等键与重放前置条件（**真实 Route Handler**）。
 *
 * 审查报告给出两处事实：
 *
 * 1. **确定性错误**（幂等键去前缀）：`app/runtime/invocations/route.ts` 先要求请求头为
 *    `start:<ownershipId>`，查询 Session 时却传入 `idempotencyKey.slice("start:".length)`；
 *    仓储 `getRuntimeSessionBindingByStartIntent` 按 `startIntentKey` **逐字相等**查询，
 *    而创建 Session 时该列被强制为完整 `start:<ownershipId>`。于是正常数据永远不可能命中，
 *    合法启动恒报 `RuntimeSessionMismatch`。Resume Route 的同类查找保留完整前缀，
 *    证明这不是"仓储也接受裸 Ownership ID"的约定。
 * 2. **关联幂等问题**（前置状态）：「同一当前代际的已接纳启动请求重放」与「一次新的启动
 *    操作」不是同一前置状态。`execution.started` 可能先于 HTTP 回执/重试到达，此时 Owner
 *    已进入 `executing`；若重放仍强制 `dispatching`，原请求会先被拒绝，后面
 *    `bindingState === "active"` 的稳定回执分支永远不可达。
 *
 * 报告要求：**必须测试真实 Route Handler** 的正常 Start 与 `execution.started` 先于
 * HTTP 回执/重试的场景，不能只测 transport mock。本文件直接 `POST` 路由处理器，
 * 请求体由**生产构造器** `buildRuntimeStartRequestForInvocation` 生成，token 由正式
 * `issueWorkloadToken` 签发，`execution.started` 走真实 Ingress。
 */
import { randomUUID } from "node:crypto";
import { POST as startRuntimeInvocationPOST } from "@/app/runtime/invocations/route";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { closeExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/http";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { executionOwnershipTable } from "@/lib/persistence/schema/executions";
import { buildRuntimeStartRequestForInvocation } from "@/lib/runtime/application/build-runtime-start-request";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import {
  getRuntimeSessionBindingByStartIntent,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type AuthorityIdentity,
  type RuntimeStartRequest,
  computeSemanticRequestDigest,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { ensureTenantWithBaselines } from "@/lib/test-support/ensure-tenant-with-baselines";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";
import { seedRuntimeRouteAuthority } from "@/lib/test-support/seed-runtime-route-authority";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUNTIME_CAPABILITIES = ["event_stream"];

const callbackEndpoints = {
  events: "http://127.0.0.1/runtime/events",
  heartbeat: "http://127.0.0.1/runtime/heartbeat",
  context: "http://127.0.0.1/gateway/context",
  capabilityActions: "http://127.0.0.1/gateway/capability-actions",
  toolCalls: "http://127.0.0.1/gateway/tool-calls",
  userActions: "http://127.0.0.1/gateway/user-actions",
};

describe("A04：Runtime HTTP Start 幂等键与重放前置条件（真实 Route Handler）", () => {
  let originalSigningKeyId: string | undefined;

  beforeAll(() => {
    originalSigningKeyId = process.env.WORKLOAD_SIGNING_KEY_ID;
    process.env.WORKLOAD_SIGNING_KEY_ID = "test-runtime-start-route-key";
  });

  afterAll(() => {
    if (originalSigningKeyId === undefined) process.env.WORKLOAD_SIGNING_KEY_ID = undefined;
    else process.env.WORKLOAD_SIGNING_KEY_ID = originalSigningKeyId;
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  /**
   * 建出可被真实 Route Handler 接纳的启动上下文。
   *
   * 请求体由**生产构造器**生成——这样 schema 合法性与 `semanticRequestDigest` 都与
   * 平台实际发出的请求同源，测试不会因为手工拼装而失真。
   */
  async function seedStartable() {
    const tenant = await ensureDefaultTenant();
    const tenantId = tenant.id;
    await ensureTenantWithBaselines(tenantId, "runtime-start-route-fixture");
    const identity = await upsertUserIdentity({
      tenantId,
      externalSubject: DEFAULT_USER_ID,
      email: DEFAULT_USER_EMAIL,
      displayName: DEFAULT_USER_NAME,
    });
    const suffix = randomUUID().slice(0, 8);
    const { revision } = await seedPublishedRuntimeRevision(
      tenantId,
      identity.id,
      `start-route-${suffix}`,
      RUNTIME_CAPABILITIES,
      suffix,
    );
    await seedRuntimeRouteAuthority({
      tenantId,
      runtimeRevisionId: revision.id,
      actorId: "runtime-start-route-fixture",
    });
    const fixture = await seedPreparedRuntimeAttempt({
      tenantId,
      runtimeRevisionId: revision.id,
    });
    const gen = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      runtimeRevisionId: revision.id,
      phase: "dispatching",
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES,
      // R02 生产时序：Start 在**派发前**就固定激活证据（`ExecutionOwnership_executing_activation_shape`
      // 要求 executing 阶段必须携带 activatedAt + evidence/digest）。
      activationEvidence: {
        kind: "runtime-start-route-fixture",
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
      },
    });
    const { request } = await buildRuntimeStartRequestForInvocation({
      tenantId,
      invocation: fixture.invocation,
      binding: fixture.binding,
      authority: gen.authority,
      credentials: {
        runtimeToken: "runtime-token-fixture",
        gatewayToken: "gateway-token-fixture",
        expiresAt: Date.now() + 60_000,
      },
      runtimeEndpoint: "http://127.0.0.1/runtime",
      callbackEndpoints,
      activationEvidenceRef: `ownership:${gen.ownership.id}`,
    });
    return { tenantId, fixture, revision, gen, request };
  }

  /** 用正式签发器为给定 authority 造一个 runtime audience 的 token，并组出路由请求。 */
  function buildRouteRequest(input: {
    tenantId: string;
    authority: AuthorityIdentity;
    body: RuntimeStartRequest;
    idempotencyKey?: string;
  }): Request {
    const token = issueWorkloadToken({
      contractVersion: 3,
      type: "execution",
      tenantId: input.tenantId,
      ...input.authority,
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    });
    return new Request("http://localhost/runtime/invocations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey ?? `start:${input.authority.ownershipId}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.body),
    });
  }

  it("RUNTIME-START-01: 正常 Start 经真实 Route Handler 接纳，幂等键必须是完整 start:<ownershipId>", async () => {
    const { tenantId, revision, gen, request } = await seedStartable();

    const response = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: request }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.accepted).toBe(true);
    expect(body.authority).toEqual(gen.authority);
    expect(body.semanticRequestDigest).toBe(request.semanticRequestDigest);
    expect(typeof body.remoteSessionRef).toBe("string");
    expect(typeof body.remoteExecutionRef).toBe("string");

    // 完整键（仓储要求的逐字相等）必须命中，且 ACK 已落盘。
    // 202 只记录传输层接纳：状态前移到 `dispatching`，`active` 由 `execution.started` 写入。
    const byFullKey = await getRuntimeSessionBindingByStartIntent(
      tenantId,
      `start:${gen.ownership.id}`,
    );
    expect(byFullKey).not.toBeNull();
    expect(byFullKey?.id).toBe(gen.session.id);
    expect(byFullKey?.bindingState).toBe("dispatching");
    expect(byFullKey?.semanticRequestDigest).toBe(request.semanticRequestDigest);
    // ACK 必须记录**发布证据摘要**：Ingress 接纳 `execution.started` 时会与它逐字比对，
    // 缺这一项会让已 ACK 的启动永远无法被 `execution.started` 承认（外部 Runtime 恒不 running）。
    expect(byFullKey?.transportAcknowledgement).toMatchObject({
      idempotencyKey: `start:${gen.ownership.id}`,
      capabilitiesDigest: expectedCapabilityManifestDigest({
        runtimeRevisionId: revision.id,
        runtimeCapabilitiesJson: RUNTIME_CAPABILITIES,
      }),
    });
    expect(byFullKey?.acknowledgedAt).not.toBeNull();

    // 裸 Ownership ID 永远不可能命中 —— 这正是旧实现 `slice("start:".length)` 的取值。
    // 固定住这条事实：仓储不做前缀归一，去前缀查找必然落空。
    expect(await getRuntimeSessionBindingByStartIntent(tenantId, gen.ownership.id)).toBeNull();
  }, 60_000);

  it("RUNTIME-START-02: execution.started 先于 HTTP 回执到达后，原请求重试仍被接纳为同一意图", async () => {
    const { tenantId, fixture, revision, gen, request } = await seedStartable();

    // 第一次投递：正常接纳。
    const first = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: request }),
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      remoteSessionRef: string;
      remoteExecutionRef: string;
    };

    const session = await getRuntimeSessionBindingByStartIntent(
      tenantId,
      `start:${gen.ownership.id}`,
    );
    if (!session) throw new Error("首派发未落盘 Session");

    // ── 真实 Ingress：execution.started 先于（重试的）HTTP 回执到达 ──
    const capabilitiesDigest = expectedCapabilityManifestDigest({
      runtimeRevisionId: revision.id,
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES,
    });
    await ingressRuntimeEvents({
      tenantId,
      invocationId: fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: gen.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "1",
            type: "execution.started" as const,
            schemaVersion: 1,
            payload: {
              intentKey: session.startIntentKey,
              semanticRequestDigest: request.semanticRequestDigest,
              remoteSessionRef: session.remoteSessionRef,
              remoteExecutionRef: session.remoteExecutionRef,
              capabilitiesDigest,
            },
          },
        ],
      },
    });
    const [owner] = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, tenantId),
          eq(executionOwnershipTable.id, gen.ownership.id),
        ),
      )
      .limit(1);
    // 前置状态已真实前移：Owner 不再是 dispatching。
    expect(owner?.executionPhase).toBe("executing");

    // ── 丢 ACK 后的重试：同一请求必须仍被接纳为**同一意图**，而不是被判 NotCurrentExecutor ──
    const retry = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: request }),
    );
    expect(retry.status).toBe(202);
    const retryBody = (await retry.json()) as {
      remoteSessionRef: string;
      remoteExecutionRef: string;
      semanticRequestDigest: string;
    };
    expect(retryBody.remoteSessionRef).toBe(firstBody.remoteSessionRef);
    expect(retryBody.remoteExecutionRef).toBe(firstBody.remoteExecutionRef);
    expect(retryBody.semanticRequestDigest).toBe(request.semanticRequestDigest);

    // 重放没有制造第二个 Session。
    const sessions = await getRuntimeSessionBindingsByInvocation(tenantId, fixture.invocation.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(session.id);
  }, 60_000);

  it("RUNTIME-START-03: 同一 Key 但语义请求不同 ⇒ 409 IDEMPOTENCY_CONFLICT（重放 ≠ 新操作）", async () => {
    const { tenantId, gen, request } = await seedStartable();
    const key = `start:${gen.ownership.id}`;

    const first = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: request, idempotencyKey: key }),
    );
    expect(first.status).toBe(202);

    // 同一 Idempotency-Key，但语义字段被改（producerSequenceStart）并重算摘要：
    // 这是"另一次操作"而不是重放，必须稳定冲突，且不得覆盖首派发冻结的语义请求。
    const mutated: RuntimeStartRequest = { ...request, producerSequenceStart: "99" };
    const withDigest: RuntimeStartRequest = {
      ...mutated,
      semanticRequestDigest: computeSemanticRequestDigest(mutated),
    };
    const conflict = await startRuntimeInvocationPOST(
      buildRouteRequest({
        tenantId,
        authority: gen.authority,
        body: withDigest,
        idempotencyKey: key,
      }),
    );
    expect(conflict.status).toBe(409);
    const conflictBody = (await conflict.json()) as { error?: { code?: string } };
    expect(conflictBody.error?.code).toBe("IDEMPOTENCY_CONFLICT");

    const session = await getRuntimeSessionBindingByStartIntent(tenantId, key);
    expect(session?.semanticRequestDigest).toBe(request.semanticRequestDigest);
  }, 60_000);

  it("R2-d: Token 与 trace 轮换后同源 Start 仍回读原 Session 和语义摘要", async () => {
    const { tenantId, gen, request } = await seedStartable();
    const first = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: request }),
    );
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      remoteSessionRef: string;
      remoteExecutionRef: string;
      semanticRequestDigest: string;
    };
    const rotated: RuntimeStartRequest = {
      ...request,
      credentials: {
        runtimeToken: `runtime-token-rotated-${randomUUID()}`,
        gatewayToken: `gateway-token-rotated-${randomUUID()}`,
        expiresAt: Date.now() + 120_000,
      },
      traceContext: { traceId: randomUUID(), spanId: randomUUID() },
    };
    expect(computeSemanticRequestDigest(rotated)).toBe(request.semanticRequestDigest);
    const replay = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: rotated }),
    );
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({
      remoteSessionRef: firstBody.remoteSessionRef,
      remoteExecutionRef: firstBody.remoteExecutionRef,
      semanticRequestDigest: firstBody.semanticRequestDigest,
    });
    const session = await getRuntimeSessionBindingByStartIntent(
      tenantId,
      `start:${gen.ownership.id}`,
    );
    expect(session?.id).toBe(gen.session.id);
    expect(session?.semanticRequestDigest).toBe(request.semanticRequestDigest);
    expect(
      await getRuntimeSessionBindingsByInvocation(tenantId, gen.authority.invocationId),
    ).toHaveLength(1);
  }, 60_000);

  it("RUNTIME-START-04: 旧代际的新启动仍被拒绝，且不得影响当前代际的 Session", async () => {
    const { tenantId, fixture, revision, gen } = await seedStartable();

    // 接管：旧 Owner 关闭 → 新 Attempt + 第 2 代 Acquire（新代际有自己的 Session）。
    await closeExecutionOwnership({
      tenantId,
      invocationId: fixture.invocation.id,
      ownershipId: gen.ownership.id,
      attemptId: gen.ownership.attemptId,
      leaseEpoch: gen.ownership.leaseEpoch,
      state: "revoked",
      reasonCode: "runtime_start_route_takeover",
    });
    const attempt2 = await createAttempt({ tenantId, invocationId: fixture.invocation.id });
    const evidence = { kind: "runtime-start-route-takeover", attemptId: attempt2.id };
    await db.transaction((tx) =>
      markAttemptPreparedForTestInTransaction(tx, {
        attemptId: attempt2.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    const gen2 = await acquireTestRuntimeAuthority({
      tenantId,
      invocationId: fixture.invocation.id,
      attemptId: attempt2.id,
      runtimeRevisionId: revision.id,
      phase: "dispatching",
      runtimeCapabilitiesJson: RUNTIME_CAPABILITIES,
      activationEvidence: {
        kind: "runtime-start-route-fixture",
        invocationId: fixture.invocation.id,
        attemptId: attempt2.id,
      },
    });
    expect(gen2.ownership.id).not.toBe(gen.ownership.id);

    // 旧代际的新启动：必须拒绝（保留 Current Authority 校验）。
    const staleRequest = {
      ...(
        await buildRuntimeStartRequestForInvocation({
          tenantId,
          invocation: fixture.invocation,
          binding: fixture.binding,
          authority: gen.authority,
          credentials: {
            runtimeToken: "runtime-token-fixture",
            gatewayToken: "gateway-token-fixture",
            expiresAt: Date.now() + 60_000,
          },
          runtimeEndpoint: "http://127.0.0.1/runtime",
          callbackEndpoints,
          activationEvidenceRef: `ownership:${gen.ownership.id}`,
        })
      ).request,
    };
    const denied = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen.authority, body: staleRequest }),
    );
    expect(denied.status).toBe(403);
    const deniedBody = (await denied.json()) as { error?: { code?: string; message?: string } };
    expect(deniedBody.error?.code).toBe("ACCESS_DENIED");
    expect(deniedBody.error?.message).toBe("NotCurrentExecutor");

    // 新代际原封不动：它的 Session 仍是 prepared，没有被旧请求的 ACK 改写。
    const sessions = await getRuntimeSessionBindingsByInvocation(tenantId, fixture.invocation.id);
    const staleSession = sessions.find((row) => row.id === gen.session.id);
    const freshSession = sessions.find((row) => row.id === gen2.session.id);
    expect(staleSession?.bindingState).not.toBe("active");
    expect(freshSession?.bindingState).toBe("prepared");
    expect(freshSession?.transportAcknowledgement ?? null).toBeNull();

    // 反向对照：当前代际的启动能正常被接纳，证明上面的拒绝是代际核对的结果。
    const currentRequest = (
      await buildRuntimeStartRequestForInvocation({
        tenantId,
        invocation: fixture.invocation,
        binding: fixture.binding,
        authority: gen2.authority,
        credentials: {
          runtimeToken: "runtime-token-fixture",
          gatewayToken: "gateway-token-fixture",
          expiresAt: Date.now() + 60_000,
        },
        runtimeEndpoint: "http://127.0.0.1/runtime",
        callbackEndpoints,
        activationEvidenceRef: `ownership:${gen2.ownership.id}`,
      })
    ).request;
    const accepted = await startRuntimeInvocationPOST(
      buildRouteRequest({ tenantId, authority: gen2.authority, body: currentRequest }),
    );
    expect(accepted.status).toBe(202);
    const after = await getRuntimeSessionBindingByStartIntent(
      tenantId,
      `start:${gen2.ownership.id}`,
    );
    expect(after?.bindingState).toBe("dispatching");
    expect(after?.acknowledgedAt).not.toBeNull();
  }, 60_000);
});
