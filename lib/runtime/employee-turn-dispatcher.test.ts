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
import { registerBuiltinTools } from "@/lib/capability/builtin-tools";
import { requestInterrupt } from "@/lib/conversations/interrupt-queries";
import { requestPausedTurnResume } from "@/lib/conversations/pause-resume-queries";
import { computeInvocationCommandPayloadHash } from "@/lib/conversations/regenerate-queries";
import { queueSteer } from "@/lib/conversations/steer-queries";
import { listItemsByThread } from "@/lib/conversations/thread-item-queries";
import { createThread } from "@/lib/conversations/thread-queries";
import { acceptUserMessageTurn, getTurnById } from "@/lib/conversations/turn-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { getAttemptsByInvocation } from "@/lib/executions/persistence/attempt-store";
import { getActiveExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { AuditActor } from "@/lib/identity/audit";
import { registerDevice, revokeDevice } from "@/lib/identity/device-queries";
import { ensureDefaultTenant } from "@/lib/identity/tenant-queries";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  invocationAttemptTable,
  invocationCommandTable,
} from "@/lib/persistence/schema/executions";
import {
  executionBindingTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import type { RuntimeRevision } from "@/lib/persistence/schema/runtimes";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import {
  dispatchInterruptCommandToRuntime,
  dispatchResumeCommandToRuntime,
  dispatchSteerCommandToRuntime,
} from "@/lib/runtime/command-dispatch-gateway";
import { dispatchEmployeeTurn } from "@/lib/runtime/employee-turn-dispatcher";
import { createRuntime } from "@/lib/runtime/persistence/runtime-queries";
import { createDraftRuntimeRevision } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getRuntimeSessionBindingsByInvocation } from "@/lib/runtime/persistence/runtime-session-store";
import { createRuntimeDispatchRetryWorker } from "@/lib/runtime/retry/runtime-dispatch-retry-worker";
import { createHttpRuntimeConformanceAdapterForTest } from "@/lib/runtime/test-support/http-runtime-conformance-adapter";
import { subscribeThreadTransientEvents } from "@/lib/runtime/transient-event-bus";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import {
  publishExternalRuntimeRevisionForTest,
  publishRuntimeRevisionForTest,
} from "@/lib/test-support/publish-runtime-revision-for-test";
import { ensureDesktopWorkspace } from "@/lib/workspace/desktop-workspace-queries";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(async () => {
  await resetDatabase(db);
});

const externalServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of externalServers.splice(0)) await close();
  vi.unstubAllEnvs();
});

// V12 RuntimeProtocol v3：External fixture 直接声明正式 RuntimeCapabilities 形状
// （probe 响应、revision.runtimeCapabilitiesJson 与 start 回执 digest 均以此为准）。
const EXTERNAL_CAPABILITIES = {
  protocolVersion: 3 as const,
  contractDigest: `sha256:${"c".repeat(64)}`,
  runtimeTargetDigest: `sha256:${"d".repeat(64)}`,
  features: {
    heartbeat: true,
    durableStartIdempotency: true,
    startedEvent: true,
    exactReplay: true,
    cancel: true,
    resume: true,
    steer: true,
    subjectTypes: ["thread", "job"],
    workspaceModes: ["NO_PLATFORM_WORKSPACE"],
    filesystemSemantics: {
      kind: "external-posix",
      caseSensitive: true,
      symlinks: true,
      permissions: true,
      hardlinks: true,
      specialFiles: false,
      xattrsAcl: false,
      mtime: "coarse",
    },
  },
  limits: { maxEventBytes: 262_144, maxBatchEvents: 100, maxBatchBytes: 1_048_576 },
};

interface ExternalRequest {
  method: string;
  url: string;
  authorization?: string;
  idempotencyKey?: string;
  body: Record<string, unknown> | null;
}

/**
 * 模拟 External Runtime 的正式行为：接纳 Start/Resume 后先发送 execution.started
 * （正式状态只由 Ingress 确认）。Conformance 阶段的假 Authority 查不到真实
 * SessionBinding，静默跳过；只有真实 dispatch 产生的 session 会被推进。
 */
async function emitExecutionStarted(
  tenantId: string,
  body: Record<string, unknown>,
  capabilitiesDigest: string,
): Promise<void> {
  const authority = body.authority as { invocationId?: string };
  const invocationId = String(authority?.invocationId ?? "");
  if (!invocationId) return;
  // R02 §7：Resume 会换新 Ownership 代际与**新** SessionBinding，旧代际落到 lost。
  // 这里必须挑当前仍处于 dispatching 的那一代，否则会把事件投到已关闭的旧 Session 上。
  const [session] = await db
    .select()
    .from(runtimeSessionBindingTable)
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.invocationId, invocationId),
        eq(runtimeSessionBindingTable.bindingState, "dispatching"),
      ),
    )
    .orderBy(desc(runtimeSessionBindingTable.versionNo))
    .limit(1);
  if (!session || !session.semanticRequestDigest) return;
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, invocationId)))
    .limit(1);
  if (!invocation) return;
  await ingressRuntimeEvents({
    tenantId,
    invocationId,
    batch: {
      protocolVersion: 3,
      authority: body.authority as never,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: String(Number(invocation.lastProducerSequence) + 1),
          type: "execution.started",
          schemaVersion: 1,
          payload: {
            intentKey: session.startIntentKey,
            semanticRequestDigest: session.semanticRequestDigest,
            remoteSessionRef: session.remoteSessionRef ?? `external-session:${invocationId}`,
            remoteExecutionRef: session.remoteExecutionRef ?? `external-execution:${invocationId}`,
            capabilitiesDigest,
          },
        },
      ],
    },
  });
}

async function startExternalRuntimeServer(capabilities = EXTERNAL_CAPABILITIES) {
  const requests: ExternalRequest[] = [];
  const acceptedStartKeys = new Set<string>();
  let startFailureStatus: number | null = null;
  let disconnectNextAcceptedStart = false;
  let suppressExecutionStarted = false;
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
    if (request.url?.startsWith("/runtime/capabilities")) {
      response.end(JSON.stringify(capabilities));
      return;
    }
    const authority = (body?.authority ?? null) as Record<string, unknown> | null;
    const invocationId = String(authority?.invocationId ?? request.url?.split("/")[4] ?? "");
    if (request.url === "/runtime/invocations" || request.url?.endsWith("/resume")) {
      if (startFailureStatus !== null) {
        response.statusCode = startFailureStatus;
        response.end(
          JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "temporarily busy" } }),
        );
        return;
      }
      // §7.4：Runtime 只能接受自己**声明**的 Workspace 连续性 profile。声明之外的模式
      // 必须 fail closed —— 真实 External Runtime 也不会接一个没声明过的连续性模式。
      const requestedWorkspace = body?.workspace as
        | { mode?: string; continuityMode?: string }
        | undefined;
      if (
        requestedWorkspace?.mode === "BOUND" &&
        requestedWorkspace.continuityMode !== undefined &&
        !capabilities.features.workspaceModes.includes(
          requestedWorkspace.continuityMode as (typeof capabilities.features.workspaceModes)[number],
        )
      ) {
        response.statusCode = 409;
        response.end(
          JSON.stringify({
            error: {
              code: "RUNTIME_WORKSPACE_MODE_UNSUPPORTED",
              message: `workspace mode not declared: ${requestedWorkspace.continuityMode}`,
            },
          }),
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
      // V3 Start/Resume 回执：echo authority + semanticRequestDigest，capabilitiesDigest
      // 按发布事实（RuntimeRevision manifest）口径由 live capabilities 计算。
      const capabilitiesDigest = computeCapabilityManifestDigest({
        runtimeRevisionId: String(authority?.runtimeRevisionId ?? ""),
        runtimeCapabilities: capabilities,
      });
      // 真实 dispatch 产生的 session：模拟 Runtime 先发 execution.started 再开始执行。
      // 在响应前同步完成，避免与测试主线程的后续事务（interrupt/steer 命令创建）
      // 形成 ExecutionOwnership 行锁交叉导致 InnoDB 死锁。
      const contextTenantId = (body?.context as { common?: { tenantId?: string } } | undefined)
        ?.common?.tenantId;
      if (contextTenantId && !suppressExecutionStarted) {
        await emitExecutionStarted(
          contextTenantId,
          body as Record<string, unknown>,
          capabilitiesDigest,
        ).catch(() => undefined);
      }
      response.end(
        JSON.stringify({
          protocolVersion: 3,
          authority,
          semanticRequestDigest: body?.semanticRequestDigest,
          accepted: true,
          remoteSessionRef: `external-session:${invocationId}`,
          remoteExecutionRef: `external-execution:${invocationId}`,
          capabilitiesDigest,
          acceptedAt: Date.now(),
        }),
      );
      return;
    }
    // Cancel/Steer 请求体是顶层 CancelRequest/SteerRequest（targetAuthority 不嵌套）。
    const targetAuthority = (body?.targetAuthority ?? null) as unknown;
    if (request.url?.endsWith("/cancel")) {
      response.end(JSON.stringify({ accepted: true, targetAuthority, stopState: "requested" }));
      return;
    }
    if (request.url?.endsWith("/steer")) {
      response.end(
        JSON.stringify({
          accepted: true,
          commandId: body?.commandId,
          targetAuthority,
          inputDigest: body?.inputDigest,
        }),
      );
      return;
    }
    response.end(JSON.stringify({ accepted: true, targetAuthority }));
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
    setSuppressExecutionStarted(value: boolean) {
      suppressExecutionStarted = value;
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
    protocolContractDigest: "harness-runtime-protocol@1",
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
    protocolContractDigest: "harness-runtime-protocol@1",
    runtimeEvidenceKind: "external_endpoint",
    endpointRef: server.endpoint,
    runtimeArtifactRef: null,
    runtimeCapabilitiesJson: capabilities,
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
  tenantId: string;
  threadId: string;
  turnId: string;
  invocationId: string;
}) {
  const id = randomUUID();
  const commandPayload = { resume_payload: { answer: "继续" }, turn_id: params.turnId };
  await db.insert(invocationCommandTable).values({
    id,
    tenantId: params.tenantId,
    invocationId: params.invocationId,
    commandType: "resume",
    payloadJson: commandPayload,
    payloadDigest: computeInvocationCommandPayloadHash(commandPayload),
    commandState: "queued",
    idempotencyKey: `external-resume:${id}`,
    requestedByType: "system",
    requestedById: "external-resume-fixture",
  });
  return id;
}

describe("dispatchEmployeeTurn", () => {
  it.each([false, true])(
    "桌面绑定冻结；设备撤销只禁用命令，不阻断基础聊天（revoked=%s）",
    async (revoked) => {
      const fixture = await seedReadyEmployeeTurn("desktop-workspace-binding");
      await registerDevice({
        tenantId: fixture.tenantId,
        userId: fixture.ownerId,
        deviceKey: "desktop-device-1",
        publicKey: "public-key",
        deviceName: "Mac",
        appVersion: "1.0.0",
      });
      const workspace = await ensureDesktopWorkspace({
        tenantId: fixture.tenantId,
        userId: fixture.ownerId,
        deviceKey: "desktop-device-1",
        displayName: "snow_harness",
        storageScopeDigest: `sha256:${"b".repeat(64)}`,
      });
      await db
        .update(threadTable)
        .set({ defaultWorkspaceId: workspace.workspaceId })
        .where(eq(threadTable.id, fixture.thread.id));
      await registerBuiltinTools({ tenantId: fixture.tenantId, ownerUserId: fixture.ownerId });
      if (revoked) await revokeDevice(fixture.tenantId, "desktop-device-1");

      const result = await dispatchEmployeeTurn({
        tenantId: fixture.tenantId,
        threadId: fixture.thread.id,
        turnId: fixture.turn.id,
        decisionPort: {
          async decideNextAction() {
            return {
              actionId: "basic-reply",
              stepNo: 1,
              actionType: "respond",
              purposeCode: "answer_ready",
              shortPurpose: "直接回答",
              payload: { evidenceRefs: [] },
            };
          },
        },
        finalResponsePort: {
          async generateFinalResponse() {
            return "基础聊天可以继续。";
          },
        },
        executionSubject: {
          tenantId: fixture.tenantId,
          subjectType: "user",
          subjectId: fixture.ownerId,
        },
      });

      expect(result.dispatched).toBe(true);
      const dispatchedTurn = await getTurnById(fixture.tenantId, fixture.turn.id);
      const [binding] = await db
        .select()
        .from(executionBindingTable)
        .where(eq(executionBindingTable.invocationId, dispatchedTurn?.activeInvocationId ?? ""))
        .limit(1);
      // 冻结设计（schema-design §ExecutionBinding.workspaceBindingId）：Turn 调度
      // 不携带平台 Workspace writer，执行绑定引用显式 NO_PLATFORM_WORKSPACE 契约
      // Binding；桌面绑定事实不回滚，能力降级冻结在 catalog unavailableFacts。
      expect(binding?.workspaceBindingId).not.toBe(workspace.bindingId);
      const fallbackWorkspace = await getWorkspaceBindingById(
        fixture.tenantId,
        binding?.workspaceBindingId ?? "",
      );
      expect(fallbackWorkspace?.continuityMode).toBe("NO_PLATFORM_WORKSPACE");
      const catalog = binding?.capabilityCatalogJson as { tools: Array<{ operationId: string }> };
      expect(catalog.tools.some((tool) => tool.operationId === "shell")).toBe(!revoked);
      await result.completion;
      expect((await getTurnById(fixture.tenantId, fixture.turn.id))?.turnState).toBe("completed");
    },
  );

  it("基础 Harness Route 缺失时把已接纳 Turn 明确收口为失败，不无限停在 accepted", async () => {
    const tenant = await ensureDefaultTenant();
    const owner = await upsertUserIdentity({
      tenantId: tenant.id,
      externalSubject: `no-route-${randomUUID()}`,
      email: `no-route-${randomUUID()}@example.com`,
      displayName: "No Route User",
    });
    const { thread } = await createThread({
      tenantId: tenant.id,
      ownerUserId: owner.id,
      title: "无运行路由",
      actorId: owner.id,
    });
    const { turn } = await acceptUserMessageTurn({
      tenantId: tenant.id,
      threadId: thread.id,
      ownerUserId: owner.id,
      content: { text: "你好" },
      actorId: owner.id,
    });

    const result = await dispatchEmployeeTurn({
      tenantId: tenant.id,
      threadId: thread.id,
      turnId: turn.id,
      executionSubject: {
        tenantId: tenant.id,
        subjectType: "user",
        subjectId: owner.id,
      },
    });

    expect(result).toMatchObject({
      dispatched: false,
      reason: "no_effective_route",
      turnState: "failed",
      errorCode: "NO_EFFECTIVE_RUNTIME_ROUTE",
    });
    expect(await getTurnById(tenant.id, turn.id)).toMatchObject({
      turnState: "failed",
      activeInvocationId: null,
      errorCode: "NO_EFFECTIVE_RUNTIME_ROUTE",
      finishedAt: expect.any(Date),
    });
  });

  it("external_endpoint 真实发送 HTTP 并持久化会话能力，不启动 Hosted Loop", async () => {
    vi.stubEnv("SNOW_CONTROL_PLANE_PUBLIC_URL", "https://platform.example.test/base/");
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
      url: "/runtime/invocations",
      authorization: undefined,
    });
    expect(server.requests[0]?.body).not.toHaveProperty("tenantId");
    expect(server.requests[0]?.body).not.toHaveProperty("userId");
    expect(server.requests[0]?.body).not.toHaveProperty("execution_subject");
    // V3 Start 请求：Gateway 回调端点冻结在 callbackEndpoints（六端点 camelCase 形状）。
    const startBody = server.requests[0]?.body as {
      authority?: { invocationId?: string };
      callbackEndpoints?: Record<string, string>;
    };
    const startInvocationId = startBody?.authority?.invocationId ?? "";
    expect(startBody?.callbackEndpoints).toEqual({
      events: `https://platform.example.test/base/runtime/invocations/${startInvocationId}/events`,
      heartbeat: `https://platform.example.test/base/runtime/invocations/${startInvocationId}/heartbeat`,
      context: "https://platform.example.test/base/gateway/context",
      capabilityActions: "https://platform.example.test/base/gateway/capability-actions",
      toolCalls: "https://platform.example.test/base/gateway/tool-calls",
      userActions: "https://platform.example.test/base/gateway/user-action-requests",
    });

    const updatedTurn = await getTurnById(tenantId, turn.id);
    const invocation = await getInvocationById(
      tenantId,
      updatedTurn?.latestInvocationId ?? "missing",
    );
    expect(invocation).toMatchObject({
      executionState: "running",
    });
    // V12：remote ref 由 Invocation 列迁移到 RuntimeSessionBinding。
    const [session] = await getRuntimeSessionBindingsByInvocation(tenantId, invocation?.id ?? "");
    expect(session).toMatchObject({
      remoteSessionRef: `external-session:${invocation?.id}`,
      remoteExecutionRef: `external-execution:${invocation?.id}`,
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
    // V12：Attempt 的 nextDispatchAt 迁移到 RuntimeSessionBinding.nextDispatchAt。
    const [dispatchSession] = await getRuntimeSessionBindingsByInvocation(
      tenantId,
      invocation?.id ?? "",
    );
    const worker = createRuntimeDispatchRetryWorker({
      workerId: "external-default-retry-worker",
      clock: () => new Date((dispatchSession?.nextDispatchAt?.getTime() ?? Date.now()) + 1),
      dispatchCommand: async () => {},
    });

    expect((await worker.tick()).attempts).toBe(1);
    const startRequests = server.requests.filter(
      (request) => request.method === "POST" && request.url === "/runtime/invocations",
    );
    expect(startRequests).toHaveLength(2);
    // V3 Start 请求：invocation 身份冻结在 body.authority.invocationId。
    expect(
      startRequests.map(
        (request) => (request.body?.authority as { invocationId?: string })?.invocationId,
      ),
    ).toEqual([invocation?.id, invocation?.id]);
    // canonical 不变量：start idempotency key 与 session.startIntentKey 同源
    //（= `start:${ownershipId}`，见 runtime-session-store.createRuntimeSessionBinding）。
    const owner = await getActiveExecutionOwnership({
      tenantId,
      invocationId: invocation?.id ?? "",
    });
    expect(new Set(startRequests.map((request) => request.idempotencyKey))).toEqual(
      new Set([`start:${owner?.id}`]),
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
    expect(server.requests.map((request) => request.url)).toEqual(["/runtime/invocations"]);
    const updatedTurn = await getTurnById(tenantId, turn.id);
    const invocationId = updatedTurn?.latestInvocationId;
    if (!invocationId) throw new Error("暂态失败缺少 Invocation");
    expect((await getInvocationById(tenantId, invocationId))?.executionState).toBe("queued");
    // V12：dispatch 重试状态属 RuntimeSessionBinding（Attempt 不再持有重试列）。
    expect(await getRuntimeSessionBindingsByInvocation(tenantId, invocationId)).toEqual([
      expect.objectContaining({
        dispatchCount: 1,
        lastErrorCode: "runtime_unavailable",
        nextDispatchAt: expect.any(Date),
      }),
    ]);
  });

  it("External start capabilities 与发布事实不一致时 fail closed", async () => {
    const capabilities = structuredClone(EXTERNAL_CAPABILITIES);
    const fixture = await seedReadyExternalEmployeeTurn("capability-mismatch", capabilities);
    // seed 后原地变更 live capabilities（部署 target 指纹），使 server 回执 digest
    // 偏离发布事实（revision 冻结 JSON）的 manifest digest → fail closed。
    capabilities.runtimeTargetDigest = `sha256:${"e".repeat(64)}`;
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
    expect(fixture.server.requests.map((request) => request.url)).toEqual(["/runtime/invocations"]);
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
      expect.stringMatching(/^\/runtime\/invocations\/[^/]+\/cancel$/),
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
      expect.stringMatching(/^\/runtime\/invocations\/[^/]+\/steer$/),
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
    // Resume dispatch 要求 Latest Attempt 处于 suspended（受控暂停后的再派发语义）。
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "suspended" })
      .where(eq(invocationAttemptTable.invocationId, invocationId));
    const commandId = await createExternalResumeCommand({
      tenantId: fixture.tenantId,
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
      `/runtime/invocations/${invocationId}/resume`,
    ]);
  });

  it("用户暂停后继续同一 Invocation，不新建 Turn 或 Regenerate", async () => {
    const fixture = await seedReadyExternalEmployeeTurn("user-pause-resume");
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
    const running = await getTurnById(fixture.tenantId, fixture.turn.id);
    const invocationId = running?.activeInvocationId;
    if (!invocationId) throw new Error("缺少 active Invocation");
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user", updatedAt: new Date() })
      .where(eq(invocationTable.id, invocationId));
    await db
      .update(turnTable)
      .set({ turnState: "waiting_user", errorCode: "USER_PAUSED", waitingAt: new Date() })
      .where(eq(turnTable.id, fixture.turn.id));
    // Resume dispatch 要求 Latest Attempt 处于 suspended（受控暂停后的再派发语义）。
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "suspended" })
      .where(eq(invocationAttemptTable.invocationId, invocationId));

    const requested = await requestPausedTurnResume({
      tenantId: fixture.tenantId,
      ownerUserId: fixture.ownerId,
      turnId: fixture.turn.id,
      idempotencyKey: "user-pause-resume-command",
    });
    expect(await getTurnById(fixture.tenantId, fixture.turn.id)).toMatchObject({
      turnState: "waiting_user",
      activeInvocationId: invocationId,
      errorCode: "USER_PAUSED",
    });
    fixture.server.requests.length = 0;
    const resumed = await dispatchResumeCommandToRuntime({
      tenantId: fixture.tenantId,
      commandId: requested.command.id,
      actorId: fixture.ownerId,
    });

    expect(requested).toMatchObject({ turnState: "waiting_user", resumeState: "requested" });
    // R02 §7：Turn/Invocation 回到 running 的唯一来源是合法 `execution.started`
    // （waiting_user → running 的正式恢复转换），不是 Resume 的 HTTP ACK。
    expect(await getTurnById(fixture.tenantId, fixture.turn.id)).toMatchObject({
      turnState: "running",
      activeInvocationId: invocationId,
      errorCode: null,
    });
    expect(await getInvocationById(fixture.tenantId, invocationId)).toMatchObject({
      executionState: "running",
    });
    expect(resumed).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect(fixture.server.requests.map((request) => request.url)).toEqual([
      `/runtime/invocations/${invocationId}/resume`,
    ]);
  });

  it("R02 §7：Resume 的 HTTP ACK 只表示 Transport 交付，不把 Invocation/Turn 推进到 running", async () => {
    const fixture = await seedReadyExternalEmployeeTurn("ack-only-resume");
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
    const turnRow = await getTurnById(fixture.tenantId, fixture.turn.id);
    const invocationId = turnRow?.activeInvocationId;
    if (!invocationId) throw new Error("缺少 active Invocation");
    await db
      .update(invocationTable)
      .set({ executionState: "waiting_user", updatedAt: new Date() })
      .where(eq(invocationTable.id, invocationId));
    await db
      .update(turnTable)
      .set({ turnState: "waiting_user", errorCode: "USER_PAUSED", waitingAt: new Date() })
      .where(eq(turnTable.id, fixture.turn.id));
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "suspended" })
      .where(eq(invocationAttemptTable.invocationId, invocationId));
    const requested = await requestPausedTurnResume({
      tenantId: fixture.tenantId,
      ownerUserId: fixture.ownerId,
      turnId: fixture.turn.id,
      idempotencyKey: "ack-only-resume-command",
    });
    // Runtime 接纳 Resume 但**没有**发送 execution.started（对端只在 Transport 层回执）。
    fixture.server.setSuppressExecutionStarted(true);
    fixture.server.requests.length = 0;
    const resumed = await dispatchResumeCommandToRuntime({
      tenantId: fixture.tenantId,
      commandId: requested.command.id,
      actorId: fixture.ownerId,
    });
    expect(resumed).toMatchObject({
      dispatched: true,
      command: { commandState: "acknowledged" },
    });
    expect(fixture.server.requests.map((request) => request.url)).toEqual([
      `/runtime/invocations/${invocationId}/resume`,
    ]);
    expect(await getTurnById(fixture.tenantId, fixture.turn.id)).toMatchObject({
      turnState: "waiting_user",
      activeInvocationId: invocationId,
      errorCode: "USER_PAUSED",
    });
    expect(await getInvocationById(fixture.tenantId, invocationId)).toMatchObject({
      executionState: "waiting_user",
    });
  });

  it("External session 声明 resume=false 时 fail closed，网络请求为零", async () => {
    const capabilities: typeof EXTERNAL_CAPABILITIES = structuredClone(EXTERNAL_CAPABILITIES);
    capabilities.features.resume = false;
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
    // Resume dispatch 要求 Latest Attempt 处于 suspended（受控暂停后的再派发语义）。
    await db
      .update(invocationAttemptTable)
      .set({ attemptState: "suspended" })
      .where(eq(invocationAttemptTable.invocationId, invocationId));
    const commandId = await createExternalResumeCommand({
      tenantId: fixture.tenantId,
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
      expect.objectContaining({
        itemType: "user_guidance",
        contextPolicy: "exclude",
        contentJson: expect.objectContaining({ kind: "progress.snapshot" }),
      }),
    ]);
  });
});
