/**
 * S05-C03：RuntimeEventIngress 集成测试（真实 MySQL 8）。
 *
 * 覆盖：
 * - 8 核心入库场景：response.completed / execution.completed/failed/cancelled /
 *   user_action.requested / progress.snapshot / sequence 递增 / mapped_events 返回
 * - 5 幂等/去重场景：相同 producerEventId 重放 / 相同 producerSequence 重放 /
 *   hash 冲突 / 部分重放 / 重放返回原映射
 * - 3 序列校验场景：producerSequence 空洞 / start 不匹配 / 空批次
 * - 4 错误场景：Invocation 不存在 / Invocation 已终态 / 未知 candidateType / 跨租户
 * - 3 transient 场景：成功 / 不持久化 / 空批次
 * - 3 route 级场景：POST events:batch 成功 / 缺少 Idempotency-Key / POST transient-events:batch 成功
 *
 * 真实 MySQL 8 Testcontainers，不使用 mock。
 */
import {
  type BuilderKeyRegistry,
  type ManagedArtifactStore,
  type ProvenanceDocument,
  type VerifyAttestationInput,
  computeArtifactDigest,
} from "@/lib/artifacts/domain/artifact-attestation";
import { verifyAndPersistAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
import {
  buildDsseArtifactAttestationEnvelope,
  generateTestBuilderKey,
} from "@/lib/artifacts/test-support/build-dsse-artifact-attestation-envelope";
import { EventSequenceGapError } from "@/lib/conversations/errors";
import { computeEventPayloadHash, createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { upsertPrincipalBinding } from "@/lib/identity/principal-binding-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { type WorkloadTokenClaims, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  threadEventTable,
  threadItemTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import { userActionRequestTable } from "@/lib/persistence/schema/user-action-request";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { DEFAULT_ROUTE_SCOPE_KEY, dispatchInvocationForTurn } from "@/lib/runtime/dispatcher";
import {
  EventPayloadHashConflictError,
  IngressInvocationNotFoundError,
  IngressInvocationTerminalError,
  InvocationStateConflictError,
} from "@/lib/runtime/errors";
import {
  IngressBatchEmptyError,
  IngressCandidateTypeUnsupportedError,
  IngressSequenceStartMismatchError,
  getIngressByInvocation,
  getIngressByProducerEventId,
  ingressEventBatch,
} from "@/lib/runtime/event-ingress-queries";
import {
  getInvocationById,
  setInvocationOutputItem,
  updateInvocationState,
} from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { TransientSequenceGapError, ingressTransientBatch } from "@/lib/runtime/transient-events";
import { publishRuntimeRevisionForTest } from "@/lib/test-support/publish-runtime-revision-for-test";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

afterEach(() => {
  // 无外部状态污染
});

// ─── 辅助：InMemoryManagedArtifactStore（与 dispatcher.test.ts 一致） ────

class InMemoryManagedArtifactStore implements ManagedArtifactStore {
  private envelopes = new Map<string, Buffer>();
  private sboms = new Map<string, unknown>();
  private provenances = new Map<string, ProvenanceDocument>();

  writeDsseEnvelope(ref: string, envelope: Buffer): void {
    this.envelopes.set(ref, envelope);
  }
  writeSbom(ref: string, doc: unknown): void {
    this.sboms.set(ref, doc);
  }
  writeProvenance(ref: string, doc: ProvenanceDocument): void {
    this.provenances.set(ref, doc);
  }

  async readDsseEnvelope(ref: string): Promise<Buffer> {
    const envelope = this.envelopes.get(ref);
    if (!envelope) throw new Error(`DSSE envelope not found: ${ref}`);
    return envelope;
  }
  async readSbom(ref: string): Promise<unknown> {
    const doc = this.sboms.get(ref);
    if (!doc) throw new Error(`sbom not found: ${ref}`);
    return doc;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const doc = this.provenances.get(ref);
    if (!doc) throw new Error(`provenance not found: ${ref}`);
    return doc;
  }
}

// ─── 辅助：DSSE Envelope 构造（来自 test-support） ─────────
// generateTestBuilderKey / buildDsseArtifactAttestationEnvelope 来自 test-support。

function buildCleanSbom(): unknown {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: { component: { type: "application", name: "test-app", version: "1.0.0" } },
    components: [
      {
        type: "library",
        name: "lodash",
        version: "4.17.21",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };
}

function buildValidProvenance(): ProvenanceDocument {
  return {
    buildPipeline: "ci-cd-pipeline-1",
    sourceRevision: "git_commit_1",
    dependencyLockFile: "package-lock.json:sha256:lockhash",
    buildTime: "2026-07-15T01:00:00.000Z",
  };
}

// ─── 辅助：seed 租户 + 用户 ────────────────────────────────

async function seedTenantAndOwner() {
  const tenant = await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: "ingress-owner-001",
    email: "ingress-owner@example.com",
    displayName: "Ingress Owner",
  });
  await upsertPrincipalBinding({
    tenantId: tenant.id,
    subjectType: "user",
    externalId: "ingress-owner-001",
    displayName: "Ingress Owner",
    userIdentityId: identity.id,
  });
  return { tenantId: tenant.id, ownerId: identity.id };
}

function buildActor(tenantId: string, actorId: string): AuditActor {
  return { tenantId, actorType: "service", actorId };
}

// ─── 辅助：创建 verified attestation ───────────────────────

async function createVerifiedAttestation(
  tenantId: string,
  artifactType: string,
  artifactRevisionId: string,
  artifactContent: string,
) {
  const keyPair = generateTestBuilderKey("builder:company-agent-runtime");
  const builderKeys: BuilderKeyRegistry = {
    "builder:company-agent-runtime": keyPair.publicKeyBase64,
  };
  const digest = computeArtifactDigest(artifactContent);
  const dsseEnvelopeRef = `attestation:signature:${digest.slice(7, 15)}`;
  const sbomRef = `attestation:sbom:${digest.slice(7, 15)}`;
  const provRef = `attestation:provenance:${digest.slice(7, 15)}`;

  const store = new InMemoryManagedArtifactStore();
  store.writeDsseEnvelope(
    dsseEnvelopeRef,
    buildDsseArtifactAttestationEnvelope(keyPair, digest, {
      sbomRef,
      sbomContent: buildCleanSbom(),
      provenanceRef: provRef,
      provenanceContent: buildValidProvenance(),
    }),
  );
  store.writeSbom(sbomRef, buildCleanSbom());
  store.writeProvenance(provRef, buildValidProvenance());

  const input: VerifyAttestationInput = {
    tenantId,
    artifactType,
    artifactRevisionId,
    artifactDigest: digest,
    dsseEnvelopeRef,
    builderIdentity: "builder:company-agent-runtime",
  };

  return verifyAndPersistAttestation(
    input,
    store,
    builderKeys,
    buildActor(tenantId, "ci-service-001"),
  );
}

// ─── 辅助：seed Runtime + published RuntimeRevision + attestation ─

async function seedPublishedRuntimeRevision(
  tenantId: string,
  ownerId: string,
  runtimeKey: string,
  capabilities: string[],
  contentSuffix: string,
) {
  const runtime = await createRuntime({
    tenantId,
    runtimeKey,
    displayName: `Runtime ${runtimeKey}`,
    runtimeKind: "hosted",
    ownerUserId: ownerId,
    lifecycleState: "enabled",
  });

  const revision = await createDraftRuntimeRevision({
    tenantId,
    runtimeId: runtime.id,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "hosted_artifact",
    endpointRef: `https://runtime-${contentSuffix}.internal`,
    runtimeArtifactRef: `oci://registry/runtime@${computeArtifactDigest(`runtime-content-${contentSuffix}`)}`,
    runtimeCapabilitiesJson: capabilities,
    identityMode: "managed",
    networkZone: "internal",
    configHash: computeArtifactDigest(`runtime-config-${contentSuffix}`),
    createdBy: ownerId,
  });

  const attestation = await createVerifiedAttestation(
    tenantId,
    "runtime_revision",
    revision.id,
    `runtime-content-${contentSuffix}`,
  );
  await publishRuntimeRevisionForTest({
    tenantId,
    revisionId: revision.id,
    runtimeExpectedVersionNo: 1,
    attestationId: attestation.id,
  });

  return { runtime, revision };
}

// ─── 辅助：seed 完整调度上下文 ─────────────────────────────

interface FullIngressContext {
  tenantId: string;
  ownerId: string;
  runtimeRevision: RuntimeRevision;
  threadId: string;
  turnId: string;
  triggerItemId: string | null;
}

async function seedFullIngressContext(): Promise<FullIngressContext> {
  const { tenantId, ownerId } = await seedTenantAndOwner();

  const { revision: runtimeRevision } = await seedPublishedRuntimeRevision(
    tenantId,
    ownerId,
    "ingress-runtime",
    ["event_stream"],
    "v1",
  );

  // 顶层恒为 base harness route（target={kind:"runtime"}）。
  const routeSet = await createRouteSet({
    tenantId,
    target: { kind: "runtime" },
    routeScopeKey: DEFAULT_ROUTE_SCOPE_KEY,
    routeScopeJson: { networkZone: "internal" },
  });

  await activateSingleRouteForTest({
    tenantId,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: runtimeRevision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenantId, "deploy-bot-001"),
  });

  const { thread } = await createThread({
    tenantId,
    ownerUserId: ownerId,
    actorId: ownerId,
  });

  const { turn } = await acceptUserMessageTurn({
    tenantId,
    threadId: thread.id,
    ownerUserId: ownerId,
    content: { text: "请帮我分析数据" },
    actorId: ownerId,
  });

  return {
    tenantId,
    ownerId,
    runtimeRevision,
    threadId: thread.id,
    turnId: turn.id,
    triggerItemId: turn.triggerItemId ?? null,
  };
}

// ─── 辅助：调度 Invocation 并转为 running ─────────────────

interface DispatchedInvocation {
  invocationId: string;
  tenantId: string;
  threadId: string;
  turnId: string;
}

async function seedRunningInvocation(ctx: FullIngressContext): Promise<DispatchedInvocation> {
  // 调度（不传 runtimeClient，Invocation 保持 queued）；顶层 base harness route。
  const result = await dispatchInvocationForTurn({
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
  });

  const invocation = result.invocation;
  if (!invocation) {
    throw new Error("调度失败：未创建 Invocation");
  }

  // 手动将 Invocation 从 queued 转为 running（模拟 Runtime 已开始执行）
  const invocationId = invocation.id;
  await db.transaction(async (tx) => {
    await updateInvocationState(tx, ctx.tenantId, invocationId, "running");
  });

  return {
    invocationId,
    tenantId: ctx.tenantId,
    threadId: ctx.threadId,
    turnId: ctx.turnId,
  };
}

// ─── 辅助：构造候选事件 ───────────────────────────────────

function makeEvent(
  producerEventId: string,
  producerSequence: number,
  type: string,
  payload: Record<string, unknown>,
) {
  return {
    producer_event_id: producerEventId,
    producer_sequence: producerSequence,
    type,
    payload,
  };
}

// ─── 辅助：构造 Workload Token ────────────────────────────

function makeWorkloadToken(
  tenantId: string,
  invocationId: string,
  runtimeRevisionId: string,
): string {
  const claims: Omit<WorkloadTokenClaims, "issuedAt"> = {
    type: "runtime",
    tenantId,
    jti: "jti-runtime-ingress-001",
    invocationId,
    runtimeRevisionId,
    audience: "runtime",
    expiresAt: Date.now() + 60_000,
  };
  return issueWorkloadToken(claims);
}

// ═══════════════════════════════════════════════════════════
// 1. 核心入库场景
// ═══════════════════════════════════════════════════════════

describe("RuntimeEventIngress 核心入库", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("progress.snapshot：创建 user_guidance Item + item.created 事件", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-001", 1, "progress.snapshot", { summary: "正在分析..." })],
      correlationId: "test-correlation",
    });

    expect(result.invocationId).toBe(invocationId);
    expect(result.acceptedThroughProducerSequence).toBe(1);
    expect(result.mappedEvents).toHaveLength(1);

    const mapped = result.mappedEvents[0];
    expect(mapped?.producerEventId).toBe("evt-001");
    expect(mapped?.threadEventId).toBeTruthy();
    expect(mapped?.threadSequence).toBeGreaterThan(0);
    expect(mapped?.itemId).toBeTruthy();

    // Ingress 行已 mapped
    const ingress = await getIngressByProducerEventId(ctx.tenantId, invocationId, "evt-001");
    expect(ingress).not.toBeNull();
    expect(ingress?.ingressState).toBe("mapped");
    expect(ingress?.mappedItemId).toBe(mapped?.itemId);
    expect(ingress?.mappedThreadEventId).toBe(mapped?.threadEventId);
  });

  it("response.completed：内容 Authority——assistant_message + outputItemId，不改执行终态", async () => {
    const { invocationId, threadId, turnId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-resp", 1, "response.completed", { text: "分析完成", finish_reason: "stop" }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const mapped = result.mappedEvents[0];
    expect(mapped?.itemId).toBeTruthy();

    // 冻结语义（Authority 拆分）：response.completed 只设 outputItemId，
    // Invocation/Turn 均保持 running（执行终态归 execution.completed 唯一 Authority）。
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("running");
    expect(invocation?.outputItemId).toBe(mapped?.itemId);

    const [turn] = await db
      .select({ turnState: turnTable.turnState, finalItemId: turnTable.finalItemId })
      .from(turnTable)
      .where(eq(turnTable.id, turnId))
      .limit(1);
    expect(turn?.turnState).toBe("queued");
    expect(turn?.finalItemId).toBeNull();

    // item.created + item.completed 已落库；无 invocation.completed。
    const events = await db
      .select({ eventType: threadEventTable.eventType })
      .from(threadEventTable)
      .where(eq(threadEventTable.threadId, threadId))
      .orderBy(asc(threadEventTable.eventSequence));
    const types = events.map((e) => e.eventType);
    expect(types).toContain("item.created");
    expect(types).toContain("item.completed");
    expect(types).not.toContain("invocation.completed");
  });

  it("execution.completed：invocation.completed 事件 + Invocation→completed", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-exec", 1, "execution.completed", { finish_reason: "done" })],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const mapped = result.mappedEvents[0];
    expect(mapped?.itemId).toBeNull();
    expect(mapped?.threadEventId).toBeTruthy();

    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("completed");
  });

  it("同一批次 response.completed + execution.completed：单事务提交，无状态机冲突（A2A completed 根因回归）", async () => {
    const { invocationId, threadId, turnId } = await seedRunningInvocation(ctx);

    // A2A 单条 completed status 经 mapper 拆成的两个候选事件，同批同事务。
    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("a2a:pair:1", 1, "response.completed", {
          source: "a2a",
          task_id: "t-1",
          text: "分析完成",
        }),
        makeEvent("a2a:pair:2", 2, "execution.completed", {
          source: "a2a",
          task_id: "t-1",
          finish_reason: "a2a_task_completed",
        }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(2);
    expect(result.mappedEvents).toHaveLength(2);

    // 两条 ingress 行均 mapped。
    const respIngress = await getIngressByProducerEventId(ctx.tenantId, invocationId, "a2a:pair:1");
    const execIngress = await getIngressByProducerEventId(ctx.tenantId, invocationId, "a2a:pair:2");
    expect(respIngress?.ingressState).toBe("mapped");
    expect(execIngress?.ingressState).toBe("mapped");

    // Invocation completed，outputItemId = assistant_message Item。
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("completed");
    const agentMessageItemId = respIngress?.mappedItemId;
    expect(agentMessageItemId).toBeTruthy();
    expect(invocation?.outputItemId).toBe(agentMessageItemId);

    // Turn completed，finalItemId = 同一 assistant_message Item。
    const [turn] = await db
      .select({ turnState: turnTable.turnState, finalItemId: turnTable.finalItemId })
      .from(turnTable)
      .where(eq(turnTable.id, turnId))
      .limit(1);
    expect(turn?.turnState).toBe("completed");
    expect(turn?.finalItemId).toBe(agentMessageItemId);

    // 唯一 invocation.completed；item.created/item.completed 各一条；无 lost/failed。
    const events = await db
      .select({ eventType: threadEventTable.eventType })
      .from(threadEventTable)
      .where(eq(threadEventTable.threadId, threadId))
      .orderBy(asc(threadEventTable.eventSequence));
    const types = events.map((e) => e.eventType);
    expect(types.filter((t) => t === "invocation.completed")).toHaveLength(1);
    // item.created 至少含用户消息与 assistant_message 各一条；item.completed 唯一
    //（assistant_message 内容终结）。
    expect(types.filter((t) => t === "item.created").length).toBeGreaterThanOrEqual(1);
    expect(types.filter((t) => t === "item.completed")).toHaveLength(1);
    expect(types).not.toContain("invocation.lost");
    expect(types).not.toContain("turn.failed");
  });

  it("分两批 response.completed → execution.completed：第二批沿用第一批 outputItemId 作 finalItemId", async () => {
    const { invocationId, turnId } = await seedRunningInvocation(ctx);

    const respResult = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("a2a:split:1", 1, "response.completed", { source: "a2a", text: "答案" })],
    });
    const agentMessageItemId = respResult.mappedEvents[0]?.itemId;
    expect(agentMessageItemId).toBeTruthy();

    const execResult = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 2,
      events: [
        makeEvent("a2a:split:2", 2, "execution.completed", {
          source: "a2a",
          finish_reason: "a2a_task_completed",
        }),
      ],
    });
    expect(execResult.acceptedThroughProducerSequence).toBe(2);

    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("completed");
    expect(invocation?.outputItemId).toBe(agentMessageItemId);

    const [turn] = await db
      .select({ turnState: turnTable.turnState, finalItemId: turnTable.finalItemId })
      .from(turnTable)
      .where(eq(turnTable.id, turnId))
      .limit(1);
    expect(turn?.turnState).toBe("completed");
    expect(turn?.finalItemId).toBe(agentMessageItemId);
  });

  it("重复 execution.completed 仍 fail closed（不允许 completed→completed）", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("dup-exec-1", 1, "execution.completed", { finish_reason: "done" })],
    });

    // 第二个不同 producer_event_id 的 execution.completed：Invocation 已终态，
    // 入口 fail closed（IngressInvocationTerminalError），未放宽状态机。
    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 2,
        events: [makeEvent("dup-exec-2", 2, "execution.completed", { finish_reason: "done" })],
      }),
    ).rejects.toThrow(IngressInvocationTerminalError);
  });

  it("setInvocationOutputItem：设置 outputItemId 不改 executionState；终态后不可变", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    // non-terminal：只设置 outputItemId + versionNo 递增，状态保持 running。
    await db.transaction(async (tx) => {
      const updated = await setInvocationOutputItem(tx, ctx.tenantId, invocationId, "item-out-1");
      expect(updated.executionState).toBe("running");
      expect(updated.outputItemId).toBe("item-out-1");
    });
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("running");
    expect(invocation?.outputItemId).toBe("item-out-1");

    // 终态后内容投影不可变：fail closed。
    await db.transaction(async (tx) => {
      await updateInvocationState(tx, ctx.tenantId, invocationId, "completed");
    });
    await expect(
      db.transaction(async (tx) => {
        await setInvocationOutputItem(tx, ctx.tenantId, invocationId, "item-out-2");
      }),
    ).rejects.toThrow(InvocationStateConflictError);
  });

  it("execution.failed：invocation.failed 事件 + Invocation→failed", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-fail", 1, "execution.failed", {
          error_code: "MODEL_TIMEOUT",
          error_summary: "模型超时",
        }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("failed");
    expect(invocation?.errorCode).toBe("MODEL_TIMEOUT");
  });

  it("execution.cancelled：invocation.cancelled 事件 + Invocation→cancelled", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-cancel", 1, "execution.cancelled", { cancelled_by: "user" })],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("cancelled");
  });

  it("user_action.requested：创建 UAR Authority + user_action Item Projection + Invocation→waiting_user（§21.1）", async () => {
    const { invocationId, threadId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-ua", 1, "user_action.requested", {
          request_type: "confirmation",
          prompt: "是否继续？",
        }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const mapped = result.mappedEvents[0];
    expect(mapped?.itemId).toBeTruthy();

    const invocation = await getInvocationById(ctx.tenantId, invocationId);
    expect(invocation?.executionState).toBe("waiting_user");

    // §21.1：UserActionRequest=Authority，ThreadItem=Projection，不能只写 Item/Event。
    const uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.tenantId, ctx.tenantId));
    expect(uars).toHaveLength(1);
    const uar = uars[0]!;
    expect(uar.threadId).toBe(threadId);
    expect(uar.itemId).toBe(mapped?.itemId); // Authority 指向 Projection
    expect(uar.requestType).toBe("confirmation");
    expect(uar.requestState).toBe("pending");
    expect(uar.permissionDecisionId).toBeNull(); // 非 Policy pause：不伪造 tool_permission_confirmation 关联

    // user_action.requested ThreadEvent 带 request_id 引用 Authority。
    const uaEvents = await db
      .select()
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, threadId),
          eq(threadEventTable.eventType, "user_action.requested"),
        ),
      );
    expect(uaEvents).toHaveLength(1);
    const payload = uaEvents[0]!.payloadJson as { request_id?: string };
    expect(payload.request_id).toBe(uar.id);
  });

  it("user_action.requested（input）：Item contentJson 必须持久化 request_id，content hash 对应最终含 request_id 的内容（RED）", async () => {
    const { invocationId, threadId } = await seedRunningInvocation(ctx);
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
    };

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-ua-input", 1, "user_action.requested", {
          request_type: "input",
          purpose: "a2a_input_required",
          prompt: "请提供请假事由",
          input_schema: inputSchema,
        }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(1);
    const mapped = result.mappedEvents[0];
    expect(mapped?.itemId).toBeTruthy();

    const uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.tenantId, ctx.tenantId));
    expect(uars).toHaveLength(1);
    const uar = uars[0]!;
    expect(uar.requestType).toBe("input");
    expect(uar.inputSchemaJson).toEqual(inputSchema);

    // 回读 ThreadItem Projection：Authority(=UAR) 与 Projection(=Item) 是两行不同 id，
    // 真实流程禁止人为把两者设成相同来掩盖缺口。
    const [item] = await db
      .select()
      .from(threadItemTable)
      .where(eq(threadItemTable.id, mapped!.itemId!))
      .limit(1);
    expect(item).toBeDefined();
    expect(item!.id).not.toBe(uar.id);
    expect(uar.itemId).toBe(item!.id);

    // RED：Item contentJson 必须携带 request_id，Web :resolve 才能用 Item 找到 Authority。
    const finalContent = {
      kind: "user_action.requested",
      request_type: "input",
      purpose: "a2a_input_required",
      prompt: "请提供请假事由",
      input_schema: inputSchema,
      request_id: uar.id,
    };
    expect(item!.contentJson).toEqual(finalContent);

    // RED：contentHash 必须对应最终含 request_id 的 content（而非先建的中间版本）。
    const expectedHash = computeEventPayloadHash(finalContent);
    expect(item!.contentHash).toBe(expectedHash);

    // RED：item.created 事件的 content_hash 同样匹配最终行。
    const [itemCreatedEvent] = await db
      .select()
      .from(threadEventTable)
      .where(
        and(
          eq(threadEventTable.threadId, threadId),
          eq(threadEventTable.eventType, "item.created"),
          eq(threadEventTable.itemId, item!.id),
        ),
      )
      .limit(1);
    expect(itemCreatedEvent).toBeDefined();
    const itemCreatedPayload = itemCreatedEvent!.payloadJson as { content_hash?: string };
    expect(itemCreatedPayload.content_hash).toBe(expectedHash);
  });

  it("user_action.requested 伪造 purpose=tool_permission_confirmation → 拒绝（§21）", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    // External Runtime 不得伪造 Tool Gateway 保留的 purpose（§21），拒绝且事务回滚。
    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [
          makeEvent("evt-ua-forge", 1, "user_action.requested", {
            purpose: "tool_permission_confirmation",
            prompt: "伪造确认",
          }),
        ],
      }),
    ).rejects.toThrow(IngressCandidateTypeUnsupportedError);

    // 事务回滚：不残留 UAR / Item。
    const uars = await db
      .select()
      .from(userActionRequestTable)
      .where(eq(userActionRequestTable.tenantId, ctx.tenantId));
    expect(uars).toHaveLength(0);
  });

  it("user_action.requested 非法 request_type → 拒绝（§21.1）", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [
          makeEvent("evt-ua-bad", 1, "user_action.requested", {
            request_type: "ask", // 全仓唯一决策值仅 allow/pause/block；request_type 无 ask。
            prompt: "非法类型",
          }),
        ],
      }),
    ).rejects.toThrow(IngressCandidateTypeUnsupportedError);
  });

  it("多事件批次：producerSequence 递增 + acceptedThrough 更新", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-1", 1, "progress.snapshot", { summary: "步骤 1" }),
        makeEvent("evt-2", 2, "progress.snapshot", { summary: "步骤 2" }),
        makeEvent("evt-3", 3, "execution.completed", { finish_reason: "done" }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(3);
    expect(result.mappedEvents).toHaveLength(3);

    // 每个 mapped event 的 producerEventId 按序
    expect(result.mappedEvents[0]?.producerEventId).toBe("evt-1");
    expect(result.mappedEvents[1]?.producerEventId).toBe("evt-2");
    expect(result.mappedEvents[2]?.producerEventId).toBe("evt-3");
  });

  it("mapped_events 返回 thread_event_id + thread_sequence + item_id", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-map", 1, "progress.snapshot", { summary: "test" })],
    });

    const mapped = result.mappedEvents[0];
    expect(mapped).toBeDefined();
    expect(typeof mapped?.threadEventId).toBe("string");
    expect(typeof mapped?.threadSequence).toBe("number");
    expect(mapped?.threadSequence).toBeGreaterThan(0);
    expect(typeof mapped?.itemId).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. 幂等/去重场景
// ═══════════════════════════════════════════════════════════

describe("RuntimeEventIngress 幂等去重", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("相同 producerEventId 重放：返回原映射，不重复创建", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const params = {
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-dedup-1", 1, "progress.snapshot", { summary: "去重测试" })],
      correlationId: "test",
    };

    const first = await ingressEventBatch(params);
    const second = await ingressEventBatch(params);

    // 两次返回相同的映射
    expect(second.acceptedThroughProducerSequence).toBe(1);
    expect(second.mappedEvents[0]?.threadEventId).toBe(first.mappedEvents[0]?.threadEventId);
    expect(second.mappedEvents[0]?.itemId).toBe(first.mappedEvents[0]?.itemId);

    // Ingress 行只有 1 条
    const rows = await getIngressByInvocation(ctx.tenantId, invocationId);
    expect(rows).toHaveLength(1);
  });

  it("同一 Thread 的两个 Invocation 可各自使用相同 Harness actionId", async () => {
    const first = await seedRunningInvocation(ctx);
    const actionPayload = {
      action_id: "e2e-respond-1",
      step_no: 1,
      action_type: "respond",
      action_digest: `sha256:${"0".repeat(64)}`,
      purpose_code: "answer_user",
      short_purpose: "生成最终回答",
      target_ref: null,
      state: "proposed",
      action_payload: {},
    };

    const firstResult = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId: first.invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("first-action-proposed", 1, "harness.action.proposed", actionPayload),
        makeEvent("first-execution-completed", 2, "execution.completed", {
          finish_reason: "done",
        }),
      ],
    });

    const { turn } = await acceptUserMessageTurn({
      tenantId: ctx.tenantId,
      threadId: ctx.threadId,
      ownerUserId: ctx.ownerId,
      content: { text: "请再回答一次" },
      actorId: ctx.ownerId,
    });
    const second = await seedRunningInvocation({
      ...ctx,
      turnId: turn.id,
      triggerItemId: turn.triggerItemId ?? null,
    });
    const secondResult = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId: second.invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("second-action-proposed", 1, "harness.action.proposed", actionPayload)],
    });

    expect(second.invocationId).not.toBe(first.invocationId);
    expect(secondResult.mappedEvents[0]?.threadEventId).not.toBe(
      firstResult.mappedEvents[0]?.threadEventId,
    );
  });

  it("相同 producerSequence 重放：返回原映射", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const baseEvent = makeEvent("evt-seq-1", 1, "progress.snapshot", { summary: "序号去重" });
    const first = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [baseEvent],
    });

    // 用不同 producerEventId 但相同 producerSequence + 相同 payload 重放
    const replayEvent = makeEvent("evt-seq-1-replay", 1, "progress.snapshot", {
      summary: "序号去重",
    });
    const second = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [replayEvent],
    });

    // 重放返回原映射（通过 producerSequence 找到已存在行）
    expect(second.mappedEvents[0]?.threadEventId).toBe(first.mappedEvents[0]?.threadEventId);
  });

  it("hash 冲突：相同 producerEventId 但 payloadHash 不同 → EventPayloadHashConflictError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    // 第一次入库
    await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-conflict", 1, "progress.snapshot", { summary: "原始内容" })],
    });

    // 第二次用相同 producerEventId 但不同 payload → hash 冲突
    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [makeEvent("evt-conflict", 1, "progress.snapshot", { summary: "篡改内容" })],
      }),
    ).rejects.toThrow(EventPayloadHashConflictError);
  });

  it("部分重放：批次中部分事件已存在，部分新事件", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    // 第一批：evt-1, evt-2
    await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-partial-1", 1, "progress.snapshot", { step: 1 }),
        makeEvent("evt-partial-2", 2, "progress.snapshot", { step: 2 }),
      ],
    });

    // 第二批：重放 evt-1, evt-2 + 新增 evt-3
    // producerSequenceStart=1，因为重放从已存在的序号开始
    const result = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [
        makeEvent("evt-partial-1", 1, "progress.snapshot", { step: 1 }),
        makeEvent("evt-partial-2", 2, "progress.snapshot", { step: 2 }),
        makeEvent("evt-partial-3", 3, "execution.completed", { finish_reason: "done" }),
      ],
    });

    expect(result.acceptedThroughProducerSequence).toBe(3);
    expect(result.mappedEvents).toHaveLength(3);
  });

  it("重放返回原映射的 thread_sequence 正确回填", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const first = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-replay-ts", 1, "progress.snapshot", { summary: "ts 测试" })],
    });

    const second = await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-replay-ts", 1, "progress.snapshot", { summary: "ts 测试" })],
    });

    // 重放返回的 thread_sequence 应与首次一致
    expect(second.mappedEvents[0]?.threadSequence).toBe(first.mappedEvents[0]?.threadSequence);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. 序列校验场景
// ═══════════════════════════════════════════════════════════

describe("RuntimeEventIngress 序列校验", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("producerSequence 空洞：跳号 → EventSequenceGapError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [
          makeEvent("evt-1", 1, "progress.snapshot", { step: 1 }),
          makeEvent("evt-3", 3, "progress.snapshot", { step: 3 }), // 跳过 2
        ],
      }),
    ).rejects.toThrow(EventSequenceGapError);
  });

  it("跨批次 producerSequence 跳号也拒绝", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);
    await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-cross-batch-1", 1, "progress.snapshot", { step: 1 })],
    });

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 3,
        events: [makeEvent("evt-cross-batch-3", 3, "progress.snapshot", { step: 3 })],
      }),
    ).rejects.toThrow(EventSequenceGapError);
  });

  it("producerSequenceStart 与 events[0] 不匹配 → IngressSequenceStartMismatchError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 5,
        events: [makeEvent("evt-start-mismatch", 1, "progress.snapshot", { step: 1 })],
      }),
    ).rejects.toThrow(IngressSequenceStartMismatchError);
  });

  it("空批次 → IngressBatchEmptyError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [],
      }),
    ).rejects.toThrow(IngressBatchEmptyError);
  });
});

// ═══════════════════════════════════════════════════════════
// 4. 错误场景
// ═══════════════════════════════════════════════════════════

describe("RuntimeEventIngress 错误场景", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("Invocation 不存在 → IngressInvocationNotFoundError", async () => {
    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId: "nonexistent-invocation-id",
        producerSequenceStart: 1,
        events: [makeEvent("evt-1", 1, "progress.snapshot", { summary: "test" })],
      }),
    ).rejects.toThrow(IngressInvocationNotFoundError);
  });

  it("Invocation 已终态 → IngressInvocationTerminalError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    // 先完成 Invocation
    await ingressEventBatch({
      tenantId: ctx.tenantId,
      invocationId,
      producerSequenceStart: 1,
      events: [makeEvent("evt-complete", 1, "execution.completed", { finish_reason: "done" })],
    });

    // 再次入库 → 终态错误
    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 2,
        events: [makeEvent("evt-after-terminal", 2, "progress.snapshot", { summary: "test" })],
      }),
    ).rejects.toThrow(IngressInvocationTerminalError);
  });

  it("未知 candidateType → IngressCandidateTypeUnsupportedError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: ctx.tenantId,
        invocationId,
        producerSequenceStart: 1,
        events: [makeEvent("evt-unknown", 1, "unknown.event.type", { foo: "bar" })],
      }),
    ).rejects.toThrow(IngressCandidateTypeUnsupportedError);
  });

  it("跨租户：不同 tenantId 查不到 Invocation → IngressInvocationNotFoundError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressEventBatch({
        tenantId: "11111111-1111-4111-8111-111111111111", // 不同租户
        invocationId,
        producerSequenceStart: 1,
        events: [makeEvent("evt-cross-tenant", 1, "progress.snapshot", { summary: "test" })],
      }),
    ).rejects.toThrow(IngressInvocationNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Transient 事件场景
// ═══════════════════════════════════════════════════════════

describe("Transient 事件处理", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("成功接收 transient 批次：返回 acceptedThroughTransientSequence + persisted=false", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    const result = await ingressTransientBatch({
      tenantId: ctx.tenantId,
      invocationId,
      transientSequenceStart: 1,
      events: [
        {
          transient_id: "t-1",
          transient_sequence: 1,
          type: "response.delta",
          payload: { delta: "你" },
        },
        {
          transient_id: "t-2",
          transient_sequence: 2,
          type: "response.delta",
          payload: { delta: "好" },
        },
      ],
      correlationId: "transient-test",
    });

    expect(result.invocationId).toBe(invocationId);
    expect(result.acceptedThroughTransientSequence).toBe(2);
    expect(result.persisted).toBe(false);
  });

  it("transient 事件不持久化：RuntimeEventIngress 表无新增", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await ingressTransientBatch({
      tenantId: ctx.tenantId,
      invocationId,
      transientSequenceStart: 1,
      events: [
        { transient_id: "t-persist", transient_sequence: 1, type: "heartbeat", payload: {} },
      ],
    });

    // 查询 RuntimeEventIngress 表，不应有 transient 事件
    const rows = await getIngressByInvocation(ctx.tenantId, invocationId);
    expect(rows).toHaveLength(0);
  });

  it("transient 空批次 → IngressBatchEmptyError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressTransientBatch({
        tenantId: ctx.tenantId,
        invocationId,
        transientSequenceStart: 1,
        events: [],
      }),
    ).rejects.toThrow(IngressBatchEmptyError);
  });

  it("transient sequence 空洞 → TransientSequenceGapError", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);

    await expect(
      ingressTransientBatch({
        tenantId: ctx.tenantId,
        invocationId,
        transientSequenceStart: 1,
        events: [
          {
            transient_id: "t-1",
            transient_sequence: 1,
            type: "response.delta",
            payload: { delta: "a" },
          },
          {
            transient_id: "t-3",
            transient_sequence: 3,
            type: "response.delta",
            payload: { delta: "b" },
          },
        ],
      }),
    ).rejects.toThrow(TransientSequenceGapError);
  });
});

// ═══════════════════════════════════════════════════════════
// 6. Route 级场景
// ═══════════════════════════════════════════════════════════

describe("Runtime Route 级测试", () => {
  let ctx: FullIngressContext;

  beforeEach(async () => {
    ctx = await seedFullIngressContext();
  });

  it("POST events:batch 成功：返回 200 + accepted_through_producer_sequence", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);
    const { POST } = await import(
      "@/app/runtime/v1/invocations/[invocation_id]/events/batch/route"
    );

    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);
    const body = {
      producer_sequence_start: 1,
      events: [
        {
          producer_event_id: "route-evt-1",
          producer_sequence: 1,
          type: "progress.snapshot",
          payload: { summary: "route 测试" },
        },
      ],
    };

    const request = new Request(
      `https://example.com/runtime/v1/invocations/${invocationId}/events/batch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-key-1",
          "x-request-id": "route-req-1",
        },
        body: JSON.stringify(body),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.invocation_id).toBe(invocationId);
    expect(json.accepted_through_producer_sequence).toBe(1);
    expect(json.mapped_events).toHaveLength(1);
    expect(json.mapped_events[0]?.producer_event_id).toBe("route-evt-1");
  });

  it("POST events:batch 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);
    const { POST } = await import(
      "@/app/runtime/v1/invocations/[invocation_id]/events/batch/route"
    );

    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);
    const body = {
      producer_sequence_start: 1,
      events: [
        {
          producer_event_id: "route-evt-no-key",
          producer_sequence: 1,
          type: "progress.snapshot",
          payload: { summary: "test" },
        },
      ],
    };

    const request = new Request(
      `https://example.com/runtime/v1/invocations/${invocationId}/events/batch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-request-id": "route-req-2",
          // 故意不传 idempotency-key
        },
        body: JSON.stringify(body),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(400);

    const json = await response.json();
    expect(json.error.code).toBe("REQUEST_SCHEMA_INVALID");
  });

  it("POST transient-events:batch 成功：返回 200 + persisted=false", async () => {
    const { invocationId } = await seedRunningInvocation(ctx);
    const { POST } = await import(
      "@/app/runtime/v1/invocations/[invocation_id]/transient-events/batch/route"
    );

    const token = makeWorkloadToken(ctx.tenantId, invocationId, ctx.runtimeRevision.id);
    const body = {
      transient_sequence_start: 1,
      events: [
        {
          transient_id: "route-t-1",
          transient_sequence: 1,
          type: "response.delta",
          payload: { delta: "hello" },
        },
      ],
    };

    const request = new Request(
      `https://example.com/runtime/v1/invocations/${invocationId}/transient-events/batch`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "idempotency-key": "route-transient-key-1",
          "x-request-id": "route-req-3",
        },
        body: JSON.stringify(body),
      },
    );

    const context = {
      params: Promise.resolve({ invocation_id: invocationId }),
    };

    const response = await POST(request, context);
    expect(response.status).toBe(200);

    const json = await response.json();
    expect(json.invocation_id).toBe(invocationId);
    expect(json.accepted_through_transient_sequence).toBe(1);
    expect(json.persisted).toBe(false);
  });
});
