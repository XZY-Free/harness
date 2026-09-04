import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { queueSteer } from "@/lib/conversations/steer-queries";
import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn, getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import type { AuditActor } from "@/lib/identity/audit";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { invocationCommandTable, turnTable } from "@/lib/persistence/schema/conversation";
import { executionBindingTable, invocationTable } from "@/lib/persistence/schema/executions";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import {
  dispatchInterruptCommandToRuntime,
  dispatchResumeCommandToRuntime,
  dispatchSteerCommandToRuntime,
} from "@/lib/runtime/command-dispatch-gateway";
import { dispatchEmployeeTurn } from "@/lib/runtime/employee-turn-dispatcher";
import { getAttemptsByInvocation } from "@/lib/runtime/invocation-attempt-queries";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import { getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { createHttpRuntimeConformanceAdapterForTest } from "@/lib/runtime/test-support/http-runtime-conformance-adapter";
import { subscribeThreadTransientEvents } from "@/lib/runtime/transient-event-bus";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import {
  publishExternalRuntimeRevisionForTest,
  publishRuntimeRevisionForTest,
} from "@/lib/test-support/publish-runtime-revision-for-test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

const externalServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of externalServers.splice(0)) await close();
});

const EXTERNAL_CAPABILITIES = {
  protocol_versions: ["2"],
  features: {
    event_stream: true,
    cancel: true,
    resume: true,
    steer: true,
    dynamic_tools: false,
    user_action: true,
    workspace_types: ["cloud"],
    filesystem_checkpoint: false,
  },
  limits: { max_invocation_seconds: 600, max_event_bytes: 1_048_576 },
};

function externalCapabilityProjection(capabilities = EXTERNAL_CAPABILITIES) {
  return {
    declared: {},
    measured: {
      features: {
        streaming_transport: capabilities.features.event_stream ? "pass" : "not_applicable",
        input_required: capabilities.features.user_action ? "pass" : "not_applicable",
        resume: capabilities.features.resume ? "pass" : "not_applicable",
        cancel: capabilities.features.cancel ? "pass" : "not_applicable",
        steer: capabilities.features.steer ? "pass" : "not_applicable",
      },
    },
    effective: {},
  };
}

interface ExternalRequest {
  method: string;
  url: string;
  authorization?: string;
  idempotencyKey?: string;
  body: Record<string, unknown> | null;
}

async function startExternalRuntimeServer(capabilities = EXTERNAL_CAPABILITIES) {
  const requests: ExternalRequest[] = [];
  const acceptedStartKeys = new Set<string>();
  let startFailureStatus: number | null = null;
  let disconnectNextAcceptedStart = false;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      idempotencyKey:
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined,
      body,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/runtime/v1/capabilities")) {
      response.end(JSON.stringify(capabilities));
      return;
    }
    const invocationId =
      request.url === "/runtime/v1/invocations"
        ? String(body?.invocation_id ?? "")
        : (request.url?.split("/")[4] ?? "");
    if (request.url === "/runtime/v1/invocations") {
      if (startFailureStatus !== null) {
        response.statusCode = startFailureStatus;
        response.end(
          JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "temporarily busy" } }),
        );
        return;
      }
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      acceptedStartKeys.add(idempotencyKey);
      if (disconnectNextAcceptedStart) {
        disconnectNextAcceptedStart = false;
        request.socket.destroy();
        return;
      }
      response.end(
        JSON.stringify({
          invocation_id: invocationId,
          accepted: true,
          attempt_no: 1,
          runtime_session_ref: `external-session:${invocationId}`,
          runtime_execution_ref: `external-execution:${invocationId}`,
          capabilities,
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        invocation_id: invocationId,
        attempt_no: 1,
        ...(request.url?.endsWith("/cancel")
          ? { cancelled: true }
          : request.url?.endsWith("/resume")
            ? { resumed: true, requires_redispatch: false }
            : { steered: true }),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  externalServers.push(async () => {
    server.close();
    await once(server, "close");
  });
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    setStartFailureStatus(status: number | null) {
      startFailureStatus = status;
    },
    disconnectNextStartAfterAccept() {
      disconnectNextAcceptedStart = true;
    },
    acceptedExecutionCount() {
      return acceptedStartKeys.size;
    },
    resetObservations() {
      requests.length = 0;
      acceptedStartKeys.clear();
    },
  };
}

// ─── 辅助：InMemoryManagedArtifactStore ────────────────────

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
    const sbom = this.sboms.get(ref);
    if (!sbom) throw new Error(`SBOM not found: ${ref}`);
    return sbom;
  }
  async readProvenance(ref: string): Promise<ProvenanceDocument> {
    const prov = this.provenances.get(ref);
    if (!prov) throw new Error(`Provenance not found: ${ref}`);
    return prov;
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
  contentSuffix: string,
): Promise<{ runtime: { id: string }; revision: RuntimeRevision }> {
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
    runtimeCapabilitiesJson: ["event_stream"],
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

async function seedReadyEmployeeTurn(suffix: string) {
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `employee-turn-owner-${suffix}`,
    email: `employee-turn-owner-${suffix}@example.com`,
    displayName: "Employee Turn Owner",
  });
  const runtime = await seedPublishedRuntimeRevision(
    tenant.id,
    owner.id,
    `default-runtime-${suffix}`,
    suffix,
  );
  const routeSet = await createRouteSet({
    tenantId: tenant.id,
    target: { kind: "runtime" },
    routeScopeKey: "default",
    routeScopeJson: { networkZone: "internal" },
  });
  await activateSingleRouteForTest({
    tenantId: tenant.id,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: runtime.revision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenant.id, "deploy-bot-001"),
  });
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: owner.id,
    actorId: owner.id,
  });
  const { turn } = await acceptUserMessageTurn({
    tenantId: tenant.id,
    threadId: thread.id,
    ownerUserId: owner.id,
    content: { text: "请确认已经接通" },
    actorId: owner.id,
  });
  return { tenantId: tenant.id, ownerId: owner.id, thread, turn };
}

async function seedReadyExternalEmployeeTurn(suffix: string, capabilities = EXTERNAL_CAPABILITIES) {
  const server = await startExternalRuntimeServer(capabilities);
  const tenant = await ensureDefaultTenant();
  const owner = await upsertUserIdentity({
    tenantId: tenant.id,
    externalSubject: `external-turn-owner-${suffix}`,
    email: `external-turn-owner-${suffix}@example.com`,
    displayName: "External Turn Owner",
  });
  const runtime = await createRuntime({
    tenantId: tenant.id,
    runtimeKey: `external-runtime-${suffix}`,
    displayName: `External Runtime ${suffix}`,
    runtimeKind: "external",
    ownerUserId: owner.id,
    lifecycleState: "enabled",
  });
  const revision = await createDraftRuntimeRevision({
    tenantId: tenant.id,
    runtimeId: runtime.id,
    protocolType: "harness_runtime_protocol",
    protocolContractRevision: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "external_endpoint",
    endpointRef: server.endpoint,
    runtimeArtifactRef: null,
    runtimeCapabilitiesJson: externalCapabilityProjection(capabilities),
    identityMode: "none",
    networkZone: "external",
    configHash: computeArtifactDigest(`external-config-${suffix}`),
    createdBy: owner.id,
  });
  const transport = createHttpHarnessRuntimeTransport({
    endpoint: server.endpoint,
    auth: { mode: "none" },
  });
  await publishExternalRuntimeRevisionForTest({
    tenantId: tenant.id,
    revisionId: revision.id,
    runtimeExpectedVersionNo: runtime.versionNo,
    runtimeAdapter: createHttpRuntimeConformanceAdapterForTest({
      transport,
      endpoint: server.endpoint,
      auth: { mode: "none" },
    }),
  });
  const routeSet = await createRouteSet({
    tenantId: tenant.id,
    target: { kind: "runtime" },
    routeScopeKey: "default",
    routeScopeJson: { networkZone: "external" },
  });
  await activateSingleRouteForTest({
    tenantId: tenant.id,
    routeSetId: routeSet.id,
    routeSetExpectedVersionNo: 1,
    target: { kind: "runtime", runtimeRevisionId: revision.id },
    trafficWeight: MAX_TRAFFIC_WEIGHT,
    priorityNo: 1,
    actor: buildActor(tenant.id, "external-deploy-bot"),
  });
  const { thread } = await createThread({
    tenantId: tenant.id,
    ownerUserId: owner.id,
    actorId: owner.id,
  });
  const { turn } = await acceptUserMessageTurn({
    tenantId: tenant.id,
    threadId: thread.id,
    ownerUserId: owner.id,
    content: { text: "由外部 Runtime 执行" },
    actorId: owner.id,
  });
  server.resetObservations();
  return { server, tenantId: tenant.id, ownerId: owner.id, thread, turn };
}

async function createExternalResumeCommand(params: {
  threadId: string;
  turnId: string;
  invocationId: string;
}) {
  const id = randomUUID();
  const now = new Date();
  const commandPayload = { resume_payload: { answer: "继续" }, turn_id: params.turnId };
  await db.insert(invocationCommandTable).values({
    id,
    invocationId: params.invocationId,
    threadId: params.threadId,
    turnId: params.turnId,
    commandType: "resume",
    commandPayloadJson: commandPayload,
    commandPayloadHash: computeInvocationCommandPayloadHash(commandPayload),
    commandState: "queued",
    idempotencyKey: `external-resume:${id}`,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("dispatchEmployeeTurn", () => {
  it("external_endpoint 真实发送 HTTP 并持久化会话能力，不启动 Hosted Loop", async () => {
    const { server, tenantId, ownerId, thread, turn } =
      await seedReadyExternalEmployeeTurn("http-start");
    const hostedDecision = vi.fn();
    const result = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
      decisionPort: { decideNextAction: hostedDecision },
    });
    await result.completion;

    expect(result.dispatched).toBe(true);
    expect(hostedDecision).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/runtime/v1/invocations",
      authorization: undefined,
    });
    expect(server.requests[0]?.body).not.toHaveProperty("tenantId");
    expect(server.requests[0]?.body).not.toHaveProperty("userId");
    expect(server.requests[0]?.body).not.toHaveProperty("execution_subject");

    const updatedTurn = await getTurnById(tenantId, turn.id);
    const invocation = await getInvocationById(
      tenantId,
      updatedTurn?.latestInvocationId ?? "missing",
    );
    expect(invocation).toMatchObject({
      executionState: "running",
      runtimeExecutionRef: `external-execution:${invocation?.id}`,
    });
    const session = await getSessionBindingById(
      tenantId,
      invocation?.runtimeSessionBindingId ?? "missing",
    );
    expect(session).toMatchObject({
      externalSessionRef: `external-session:${invocation?.id}`,
      runtimeCapabilitiesJson: EXTERNAL_CAPABILITIES,
    });
  });

  it("默认 retry worker 不注入 dispatchAttempt，External Attempt 真实重发同一 HTTP start", async () => {
    const { server, tenantId, ownerId, thread, turn } =
      await seedReadyExternalEmployeeTurn("http-retry-default");
    server.disconnectNextStartAfterAccept();
    const initial = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
    });
    expect(initial.dispatched).toBe(true);
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.turnId, turn.id))
      .limit(1);
    expect(invocation).toBeTruthy();
    const [attempt] = await getAttemptsByInvocation(invocation?.id ?? "");
    expect(attempt?.attemptState).toBe("queued");
    const worker = createRuntimeDispatchRetryWorker({
      workerId: "external-default-retry-worker",
      clock: () => new Date((attempt?.nextDispatchAt?.getTime() ?? Date.now()) + 1),
      dispatchCommand: async () => {},
    });

    expect((await worker.tick()).attempts).toBe(1);
    const startRequests = server.requests.filter(
      (request) => request.method === "POST" && request.url === "/runtime/v1/invocations",
    );
    expect(startRequests).toHaveLength(2);
    expect(startRequests[0]?.body?.invocation_id).toBe(invocation?.id);
    expect(startRequests[1]?.body?.invocation_id).toBe(invocation?.id);
    expect(new Set(startRequests.map((request) => request.idempotencyKey))).toEqual(
      new Set([`invocation-attempt:${attempt?.id}`]),
    );
    expect(server.acceptedExecutionCount()).toBe(1);
    expect((await getInvocationById(tenantId, invocation?.id ?? ""))?.executionState).toBe(
      "running",
    );
  });

  it("External start 暂态失败只排入 durable retry，不 fallback Hosted", async () => {
    const { server, tenantId, ownerId, thread, turn } =
      await seedReadyExternalEmployeeTurn("http-transient");
    server.setStartFailureStatus(503);
    const hostedDecision = vi.fn();
    const result = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
      decisionPort: { decideNextAction: hostedDecision },
    });
    await result.completion;

    expect(hostedDecision).not.toHaveBeenCalled();
    expect(server.requests.map((request) => request.url)).toEqual(["/runtime/v1/invocations"]);
    const updatedTurn = await getTurnById(tenantId, turn.id);
    const invocationId = updatedTurn?.latestInvocationId;
    if (!invocationId) throw new Error("暂态失败缺少 Invocation");
    expect((await getInvocationById(tenantId, invocationId))?.executionState).toBe("queued");
    expect(await getAttemptsByInvocation(invocationId)).toEqual([
      expect.objectContaining({
        attemptState: "queued",
        dispatchAttemptCount: 1,
        lastTransientErrorCode: "runtime_unavailable",
        nextDispatchAt: expect.any(Date),
      }),
    ]);
  });

  it("External start capabilities 与发布事实不一致时 fail closed", async () => {
    const capabilities = {
      ...EXTERNAL_CAPABILITIES,
      features: { ...EXTERNAL_CAPABILITIES.features },
    };
    const fixture = await seedReadyExternalEmployeeTurn("capability-mismatch", capabilities);
    capabilities.features.cancel = false;
    const hostedDecision = vi.fn();
    await expect(
      dispatchEmployeeTurn({
        tenantId: fixture.tenantId,
        threadId: fixture.thread.id,
        turnId: fixture.turn.id,
        executionSubject: {
          tenantId: fixture.tenantId,
          subjectType: "user",
          subjectId: fixture.ownerId,
        },
        decisionPort: { decideNextAction: hostedDecision },
      }),
    ).rejects.toMatchObject({
      name: "RuntimeHttpClientError",
      stableCode: "RUNTIME_CAPABILITY_MISMATCH",
      retryable: false,
      dispatchPossiblyStarted: true,
    });
    expect(hostedDecision).not.toHaveBeenCalled();
    expect(fixture.server.requests.map((request) => request.url)).toEqual([
      "/runtime/v1/invocations",
    ]);
  });

  it("External cancel 通过共享 command gateway 真实发送 HTTP", async () => {
    const cancelFixture = await seedReadyExternalEmployeeTurn("http-cancel");
    await dispatchEmployeeTurn({
      tenantId: cancelFixture.tenantId,
      threadId: cancelFixture.thread.id,
      turnId: cancelFixture.turn.id,
      executionSubject: {
        tenantId: cancelFixture.tenantId,
        subjectType: "user",
        subjectId: cancelFixture.ownerId,
      },
    });
    cancelFixture.server.requests.length = 0;
    const interrupt = await requestInterrupt({
      tenantId: cancelFixture.tenantId,
      ownerUserId: cancelFixture.ownerId,
      turnId: cancelFixture.turn.id,
      reasonCode: "user_cancel",
      idempotencyKey: "external-cancel-command",
    });
    const cancel = await dispatchInterruptCommandToRuntime({
      tenantId: cancelFixture.tenantId,
      commandId: interrupt.command.id,
      actorId: cancelFixture.ownerId,
    });
    expect(cancel).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect(cancelFixture.server.requests.map((request) => request.url)).toEqual([
      expect.stringMatching(/^\/runtime\/v1\/invocations\/[^/]+\/cancel$/),
    ]);
  });

  it("External steer 通过共享 command gateway 真实发送 HTTP", async () => {
    const steerFixture = await seedReadyExternalEmployeeTurn("http-steer");
    await dispatchEmployeeTurn({
      tenantId: steerFixture.tenantId,
      threadId: steerFixture.thread.id,
      turnId: steerFixture.turn.id,
      executionSubject: {
        tenantId: steerFixture.tenantId,
        subjectType: "user",
        subjectId: steerFixture.ownerId,
      },
    });
    await db
      .update(turnTable)
      .set({ turnState: "running" })
      .where(eq(turnTable.id, steerFixture.turn.id));
    steerFixture.server.requests.length = 0;
    const steerCommand = await queueSteer({
      tenantId: steerFixture.tenantId,
      ownerUserId: steerFixture.ownerId,
      turnId: steerFixture.turn.id,
      guidanceText: "先核对余额",
      idempotencyKey: "external-steer-command",
    });
    const steer = await dispatchSteerCommandToRuntime({
      tenantId: steerFixture.tenantId,
      commandId: steerCommand.command.id,
      actorId: steerFixture.ownerId,
    });
    expect(steer).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect(steerFixture.server.requests.map((request) => request.url)).toEqual([
      expect.stringMatching(/^\/runtime\/v1\/invocations\/[^/]+\/steer$/),
    ]);
  });

  it("External resume 读取持久化 effective capability 后真实发送 HTTP", async () => {
    const fixture = await seedReadyExternalEmployeeTurn("http-resume");
    await dispatchEmployeeTurn({
      tenantId: fixture.tenantId,
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      executionSubject: {
        tenantId: fixture.tenantId,
        subjectType: "user",
        subjectId: fixture.ownerId,
      },
    });
    const turn = await getTurnById(fixture.tenantId, fixture.turn.id);
    const invocationId = turn?.activeInvocationId;
    if (!invocationId) throw new Error("External start 未绑定 active Invocation");
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user", updatedAt: new Date() })
      .where(eq(invocationTable.id, invocationId));
    await db
      .update(turnTable)
      .set({ turnState: "waiting_user" })
      .where(eq(turnTable.id, fixture.turn.id));
    const commandId = await createExternalResumeCommand({
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      invocationId,
    });
    fixture.server.requests.length = 0;
    const resume = await dispatchResumeCommandToRuntime({
      tenantId: fixture.tenantId,
      commandId,
      actorId: fixture.ownerId,
    });
    expect(resume).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect(fixture.server.requests.map((request) => request.url)).toEqual([
      `/runtime/v1/invocations/${invocationId}/resume`,
    ]);
  });

  it("External session 声明 resume=false 时 fail closed，网络请求为零", async () => {
    const capabilities = {
      ...EXTERNAL_CAPABILITIES,
      features: { ...EXTERNAL_CAPABILITIES.features, resume: false },
    };
    const fixture = await seedReadyExternalEmployeeTurn("resume-unsupported", capabilities);
    await dispatchEmployeeTurn({
      tenantId: fixture.tenantId,
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      executionSubject: {
        tenantId: fixture.tenantId,
        subjectType: "user",
        subjectId: fixture.ownerId,
      },
    });
    const turn = await getTurnById(fixture.tenantId, fixture.turn.id);
    const invocationId = turn?.activeInvocationId;
    if (!invocationId) throw new Error("External start 未绑定 active Invocation");
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user", updatedAt: new Date() })
      .where(eq(invocationTable.id, invocationId));
    await db
      .update(turnTable)
      .set({ turnState: "waiting_user" })
      .where(eq(turnTable.id, fixture.turn.id));
    const commandId = await createExternalResumeCommand({
      threadId: fixture.thread.id,
      turnId: fixture.turn.id,
      invocationId,
    });
    fixture.server.requests.length = 0;
    await expect(
      dispatchResumeCommandToRuntime({
        tenantId: fixture.tenantId,
        commandId,
        actorId: fixture.ownerId,
      }),
    ).resolves.toEqual({ dispatched: false, reason: "unsupported_capability" });
    expect(fixture.server.requests).toHaveLength(0);
  });

  it("接纳的 Turn 会经内置 Hosted Runtime 生成并持久化真实 Agent 回复", async () => {
    const { tenantId, ownerId, thread, turn } = await seedReadyEmployeeTurn("v1");
    const deltas: string[] = [];
    const unsubscribe = subscribeThreadTransientEvents(thread.id, (event) => {
      if (event.type === "response.delta") deltas.push(event.payload.delta as string);
    });

    const dispatched = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
      modelRef: "test-model",
      // 顶层恒为 base harness route；modelRef 作为 Thread 模型事实进入 Binding。
      decisionPort: {
        async decideNextAction() {
          return {
            actionId: "respond-1",
            stepNo: 1,
            actionType: "respond",
            purposeCode: "answer_ready",
            shortPurpose: "直接回答",
            payload: { evidenceRefs: [] },
          };
        },
      },
      finalResponsePort: {
        async generateFinalResponse(view, emitDelta) {
          await emitDelta?.("真实执行器");
          await emitDelta?.(`回复：${view.objective}`);
          return `真实执行器回复：${view.objective}`;
        },
      },
    });
    await dispatched.completion;
    unsubscribe();

    const updatedTurn = await getTurnById(tenantId, turn.id);
    const items = await listItemsByThread(tenantId, thread.id);
    const [binding] = await db
      .select({ modelId: executionBindingTable.modelId })
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, updatedTurn?.latestInvocationId ?? ""))
      .limit(1);
    expect(dispatched.dispatched).toBe(true);
    expect(deltas).toEqual(["真实执行器", "回复：请确认已经接通"]);
    expect(updatedTurn?.turnState).toBe("completed");
    expect(binding?.modelId).toBe("test-model");
    expect(items.find((item) => item.itemType === "assistant_message")?.contentJson).toMatchObject({
      text: "真实执行器回复：请确认已经接通",
      model_ref: "test-model",
    });
  });

  it("live cancel 中断模型执行，确认命令后不再提交新 action", async () => {
    const { tenantId, ownerId, thread, turn } = await seedReadyEmployeeTurn("cancel-live");
    let modelStarted = false;
    const dispatched = await dispatchEmployeeTurn({
      tenantId,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: { tenantId, subjectType: "user", subjectId: ownerId },
      decisionPort: {
        async decideNextAction(_view, abortSignal) {
          modelStarted = true;
          return await new Promise((_resolve, reject) => {
            abortSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
          });
        },
      },
      finalResponsePort: {
        async generateFinalResponse() {
          throw new Error("cancel 后不得生成正文");
        },
      },
    });
    await vi.waitFor(() => expect(modelStarted).toBe(true));
    const runningTurn = await getTurnById(tenantId, turn.id);
    const invocationId = runningTurn?.activeInvocationId;
    if (!invocationId) throw new Error("缺少 active Invocation");
    const interrupt = await requestInterrupt({
      tenantId,
      ownerUserId: ownerId,
      turnId: turn.id,
      reasonCode: "user_cancel",
      idempotencyKey: "cancel-live-1",
    });
    const gateway = await dispatchInterruptCommandToRuntime({
      tenantId,
      commandId: interrupt.command.id,
      actorId: ownerId,
    });
    await dispatched.completion;

    expect(gateway).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect((await getInvocationById(tenantId, invocationId))?.executionState).toBe("cancelled");
    expect(await listItemsByThread(tenantId, thread.id)).toEqual([
      expect.objectContaining({ itemType: "user_message" }),
    ]);
  });
});
