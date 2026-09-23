import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { createInvocationCommandInTransaction } from "@/lib/executions/application/create-invocation-command";
import type { ExecutionAuthorityError } from "@/lib/executions/domain/execution-authority";
import {
  createAttempt,
  getAttemptById,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnership,
  getActiveExecutionOwnership,
  getAuthorityDatabaseTime,
  renewExecutionOwnership,
} from "@/lib/executions/persistence/execution-ownership-store";
import {
  attemptPreparationClaimForTest,
  markAttemptPreparedForTestInTransaction,
} from "@/lib/executions/test-support/preparation-fixtures";
import { seedPreparedRuntimeAttempt } from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import { runtimeRevisionTable, runtimeTable } from "@/lib/persistence/schema/runtimes";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { resumeRuntimeInvocation } from "@/lib/runtime/application/runtime-resume";
import {
  RuntimeStartTransportError,
  startRuntimeInvocation as startRuntimeInvocationProduction,
} from "@/lib/runtime/application/runtime-start";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import { validateRuntimeProtocolCapabilities } from "@/lib/runtime/protocol-conformance";
import {
  createHttpRuntimeClient,
  createMockRuntimeClient,
  defaultRuntimeCapabilities,
} from "@/lib/runtime/runtime-client";
import {
  type AuthorityIdentity,
  type RuntimeCapabilities,
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

type StoredStart = {
  semanticRequestDigest: string;
  authority: AuthorityIdentity;
  remoteSessionRef: string;
  remoteExecutionRef: string;
  executionCount: number;
  startedCallbackDelivered: boolean;
};

type DurableStartStore = { starts: Record<string, StoredStart> };

const callbackEndpoints = {
  events: "http://127.0.0.1/runtime/events",
  heartbeat: "http://127.0.0.1/runtime/heartbeat",
  context: "http://127.0.0.1/gateway/context",
  capabilityActions: "http://127.0.0.1/gateway/capability-actions",
  toolCalls: "http://127.0.0.1/gateway/tool-calls",
  userActions: "http://127.0.0.1/gateway/user-actions",
};

class DurableReferenceRuntime {
  private server: Server | null = null;
  private root: string | null = null;
  private endpointValue: string | null = null;
  readonly requests: Array<{ idempotencyKey: string; request: RuntimeStartRequest; path: string }> =
    [];
  callbackBeforeResponse = false;
  dropNextStartResponse = false;
  readonly capabilities = defaultRuntimeCapabilities();
  // External start capability 一致性：回执摘要必须等于发布事实 manifest 摘要
  //（与生产 runtime-start.ts 的 computeCapabilityManifestDigest 同源）。
  readonly capabilitiesDigest: string;

  constructor(
    private readonly tenantId: string,
    runtimeRevisionId?: string,
  ) {
    this.capabilitiesDigest = runtimeRevisionId
      ? computeCapabilityManifestDigest({
          runtimeRevisionId,
          runtimeCapabilities: this.capabilities,
        })
      : this.capabilities.contractDigest;
  }

  get endpoint(): string {
    if (!this.endpointValue) throw new Error("reference runtime has not started");
    return this.endpointValue;
  }

  async start(): Promise<void> {
    if (!this.root)
      this.root = await mkdtemp(path.join(tmpdir(), "snowharness-reference-runtime-"));
    this.server = createServer((request, response) => void this.handle(request, response));
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address() as AddressInfo;
    this.endpointValue = `http://127.0.0.1:${address.port}`;
  }

  async restart(): Promise<void> {
    await this.closeServer();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.closeServer();
    if (this.root) await rm(this.root, { recursive: true, force: true });
    this.root = null;
    this.endpointValue = null;
  }

  async store(): Promise<DurableStartStore> {
    if (!this.root) throw new Error("reference runtime storage is unavailable");
    try {
      return JSON.parse(
        await readFile(path.join(this.root, "starts.json"), "utf8"),
      ) as DurableStartStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { starts: {} };
      throw error;
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/runtime/capabilities?protocolVersion=3") {
      return this.reply(response, 200, this.capabilities);
    }
    if (
      request.method !== "POST" ||
      !request.url ||
      !/^\/runtime\/invocations(?:\/[^/]+\/resume)?$/.test(request.url)
    ) {
      return this.reply(response, 404, {
        error: { code: "RUNTIME_ROUTE_NOT_FOUND", message: "not found" },
      });
    }
    const requestBody = RuntimeStartRequestSchema.parse(await readJson(request));
    const isResumeRoute = request.url !== "/runtime/invocations";
    if (
      (isResumeRoute && requestBody.intentType !== "resume") ||
      (!isResumeRoute && requestBody.intentType !== "start")
    ) {
      return this.reply(response, 400, {
        error: { code: "REQUEST_SCHEMA_INVALID", message: "intent/path mismatch" },
      });
    }
    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || !idempotencyKey) {
      return this.reply(response, 400, {
        error: { code: "REQUEST_SCHEMA_INVALID", message: "idempotency key missing" },
      });
    }
    this.requests.push({ idempotencyKey, request: requestBody, path: request.url });
    const store = await this.store();
    const existing = store.starts[idempotencyKey];
    if (existing && existing.semanticRequestDigest !== requestBody.semanticRequestDigest) {
      return this.reply(response, 409, {
        error: { code: "StartIntentConflict", message: "start intent digest conflicts" },
      });
    }
    const accepted = existing ?? {
      semanticRequestDigest: requestBody.semanticRequestDigest,
      authority: requestBody.authority,
      remoteSessionRef: `reference-session:${requestBody.authority.sessionBindingId}`,
      remoteExecutionRef: `reference-execution:${requestBody.authority.ownershipId}`,
      executionCount: 1,
      startedCallbackDelivered: false,
    };
    store.starts[idempotencyKey] = accepted;
    await this.writeStore(store);
    if (this.callbackBeforeResponse && !accepted.startedCallbackDelivered) {
      accepted.startedCallbackDelivered = true;
      await this.writeStore(store);
      await ingressRuntimeEvents({
        tenantId: this.tenantId,
        invocationId: requestBody.authority.invocationId,
        batch: {
          protocolVersion: 3,
          authority: requestBody.authority,
          events: [
            {
              eventId: randomUUID(),
              producerSequence: requestBody.producerSequenceStart,
              type: "execution.started",
              schemaVersion: 1,
              payload: {
                intentKey: idempotencyKey,
                semanticRequestDigest: requestBody.semanticRequestDigest,
                remoteSessionRef: accepted.remoteSessionRef,
                remoteExecutionRef: accepted.remoteExecutionRef,
                capabilitiesDigest: this.capabilitiesDigest,
              },
            },
          ],
        },
      });
    }
    if (this.dropNextStartResponse) {
      this.dropNextStartResponse = false;
      response.destroy();
      return;
    }
    return this.reply(response, 202, {
      protocolVersion: 3,
      authority: requestBody.authority,
      semanticRequestDigest: accepted.semanticRequestDigest,
      accepted: true,
      remoteSessionRef: accepted.remoteSessionRef,
      remoteExecutionRef: accepted.remoteExecutionRef,
      capabilitiesDigest: this.capabilitiesDigest,
      acceptedAt: Date.now(),
    });
  }

  private async writeStore(value: DurableStartStore): Promise<void> {
    if (!this.root) throw new Error("reference runtime storage is unavailable");
    await writeFile(path.join(this.root, "starts.json"), JSON.stringify(value), "utf8");
  }

  private reply(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startRuntimeInvocation(
  input: Parameters<typeof startRuntimeInvocationProduction>[0],
): ReturnType<typeof startRuntimeInvocationProduction> {
  const attempt = await getAttemptById(input.attempt.id);
  const preparationClaim =
    input.preparationClaim ??
    (attempt?.preparationClaimId ? await attemptPreparationClaimForTest(attempt.id) : null);
  return startRuntimeInvocationProduction({
    ...input,
    ...(preparationClaim ? { preparationClaim } : {}),
  });
}

async function startFixture(
  fixture: Awaited<ReturnType<typeof seedPreparedRuntimeAttempt>>,
  runtimeEndpoint: string,
  sessionDispatchClaim?: RuntimeStartTransportError["dispatchIdentity"],
) {
  return startRuntimeInvocation({
    tenantId: fixture.tenantId,
    invocation: fixture.invocation,
    sourceOperationKey: `invocation:${fixture.invocation.id}`,
    binding: fixture.binding,
    attempt: fixture.attempt,
    runtimeClient: createHttpRuntimeClient(),
    runtimeEndpoint,
    auth: { mode: "none" },
    callbackEndpoints,
    ...(sessionDispatchClaim ? { sessionDispatchClaim } : {}),
  });
}

async function seedStartFixture() {
  const tenant = await ensureDefaultTenant();
  const runtimeId = randomUUID();
  const runtimeRevisionId = randomUUID();
  const digest = protocolDigest({
    runtimeId,
    runtimeRevisionId,
    fixture: "runtime-start-recovery",
  });
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: tenant.id,
    runtimeKey: `reference-runtime-${runtimeId}`,
    displayName: "Reference Runtime",
    runtimeKind: "external",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
    currentRevisionId: runtimeRevisionId,
    versionNo: 1,
  });
  await db.insert(runtimeRevisionTable).values({
    id: runtimeRevisionId,
    tenantId: tenant.id,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: 3,
    protocolContractDigest: digest,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest,
    endpointRef: "http://127.0.0.1/reference-runtime",
    runtimeArtifactRef: null,
    artifactId: null,
    artifactDigest: null,
    runtimeCapabilitiesJson: defaultRuntimeCapabilities(),
    identityMode: "none",
    networkZone: "external",
    configHash: digest,
    credentialRefId: null,
    revisionState: "published",
    createdBy: "test-service",
  });
  return seedPreparedRuntimeAttempt({
    tenantId: tenant.id,
    runtimeRevisionId,
    policyRevisionId: randomUUID(),
    governanceConfigRevisionId: randomUUID(),
  });
}

let runtime: DurableReferenceRuntime | null = null;
let originalSigningKeyId: string | undefined;

beforeAll(() => {
  originalSigningKeyId = process.env.WORKLOAD_SIGNING_KEY_ID;
  process.env.WORKLOAD_SIGNING_KEY_ID = "test-runtime-start-key";
});

beforeEach(async () => {
  await resetDatabase(db);
  await ensureDefaultTenant();
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
});

afterAll(() => {
  if (originalSigningKeyId === undefined) process.env.WORKLOAD_SIGNING_KEY_ID = undefined;
  else process.env.WORKLOAD_SIGNING_KEY_ID = originalSigningKeyId;
});

describe("Runtime Start / Resume durable recovery", () => {
  it("START-01/START-02/START-07: durable reference runtime deduplicates a stable start identity and rejects a changed semantic request", async () => {
    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    await runtime.start();

    const first = await startFixture(fixture, runtime.endpoint);
    const repeated = await startFixture(fixture, runtime.endpoint);
    expect(repeated.response).toMatchObject({
      remoteSessionRef: first.response.remoteSessionRef,
      remoteExecutionRef: first.response.remoteExecutionRef,
      semanticRequestDigest: first.response.semanticRequestDigest,
    });
    const startKey = `start:${first.authority.ownershipId}`;
    expect((await runtime.store()).starts[startKey]?.executionCount).toBe(1);
    expect(runtime.requests.filter((entry) => entry.idempotencyKey === startKey)).toHaveLength(2);
    expect(new Set(runtime.requests.map((entry) => entry.request.semanticRequestDigest))).toEqual(
      new Set([first.response.semanticRequestDigest]),
    );

    const original = runtime.requests[0]?.request;
    expect(original).toBeDefined();
    await expect(
      createHttpRuntimeClient().startInvocation({
        runtimeEndpoint: runtime.endpoint,
        auth: { mode: "none" },
        idempotencyKey: startKey,
        request: { ...original!, semanticRequestDigest: protocolDigest({ changed: true }) },
      }),
    ).rejects.toMatchObject({ runtimeErrorCode: "StartIntentConflict", retryable: false });
    expect((await runtime.store()).starts[startKey]?.executionCount).toBe(1);
  });

  it("START-03: response loss followed by worker restart replays the persisted session identity without another remote execution", async () => {
    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    await runtime.start();
    runtime.dropNextStartResponse = true;

    const failure = await startFixture(fixture, runtime.endpoint).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeStartTransportError);
    if (!(failure instanceof RuntimeStartTransportError)) throw new Error("缺少原始派发身份");
    const active = await getActiveExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
    });
    expect(active).not.toBeNull();
    await runtime.restart();
    const recovered = await startFixture(fixture, runtime.endpoint, failure.dispatchIdentity);
    const startKey = `start:${recovered.authority.ownershipId}`;
    expect((await runtime.store()).starts[startKey]).toMatchObject({ executionCount: 1 });
    expect(runtime.requests.filter((entry) => entry.idempotencyKey === startKey)).toHaveLength(2);
  });

  it("START-04: execution.started may arrive before HTTP 202 without regressing the active SessionBinding", async () => {
    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    runtime.callbackBeforeResponse = true;
    await runtime.start();

    const started = await startFixture(fixture, runtime.endpoint);
    const session = await getRuntimeSessionBindingById(fixture.tenantId, started.sessionBindingId);
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(session).toMatchObject({
      bindingState: "active",
      remoteSessionRef: started.response.remoteSessionRef,
      remoteExecutionRef: started.response.remoteExecutionRef,
    });
    expect(invocation?.executionState).toBe("running");
  });

  it("START-05: a transport failure after intent registration resumes delivery from the stored session rather than inventing a key", async () => {
    const fixture = await seedStartFixture();
    const unavailable = createMockRuntimeClient({
      startInvocation: async () => {
        throw new RuntimeHttpClientError(
          "network",
          "reference runtime temporarily unavailable",
          undefined,
          undefined,
          {
            dispatchPossiblyStarted: true,
          },
        );
      },
    });
    const failure = await startRuntimeInvocation({
      tenantId: fixture.tenantId,
      invocation: fixture.invocation,
      sourceOperationKey: `invocation:${fixture.invocation.id}`,
      binding: fixture.binding,
      attempt: fixture.attempt,
      runtimeClient: unavailable,
      runtimeEndpoint: "http://127.0.0.1:1",
      auth: { mode: "none" },
      callbackEndpoints,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeStartTransportError);
    if (!(failure instanceof RuntimeStartTransportError)) throw new Error("缺少原始派发身份");
    const [owner] = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, fixture.tenantId),
          eq(executionOwnershipTable.invocationId, fixture.invocation.id),
        ),
      );
    expect(owner).toBeDefined();
    const sessions = await getRuntimeSessionBindingsByInvocation(
      fixture.tenantId,
      fixture.invocation.id,
    );
    expect(sessions).toHaveLength(1);

    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    await runtime.start();
    const recovered = await startFixture(fixture, runtime.endpoint, failure.dispatchIdentity);
    expect(recovered.authority.ownershipId).toBe(owner?.id);
    expect(recovered.sessionBindingId).toBe(sessions[0]?.id);
    expect(Object.keys((await runtime.store()).starts)).toEqual([`start:${owner?.id}`]);
  });

  it("START-06: an epoch-one start receipt does not renew after a newer ownership generation takes over", async () => {
    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    runtime.callbackBeforeResponse = true;
    await runtime.start();
    const first = await startFixture(fixture, runtime.endpoint);
    // 过期必须对齐**生产判定所用的权威时钟**（DB `CURRENT_TIMESTAMP(6)`）：客户端
    // `Date.now()` 与 DB 时钟存在毫秒级偏差，只留 1ms 余量并不足以表达「已过期」，
    // 并发下 VM 时钟滞后加剧，会误报 HealthyOwnerExists。
    await db
      .update(executionOwnershipTable)
      .set({ leaseExpiresAt: await getAuthorityDatabaseTime(db) })
      .where(eq(executionOwnershipTable.id, first.authority.ownershipId));
    const replacementAttempt = await createAttempt({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      retryReasonCode: "reference_takeover",
    });
    const evidence = { kind: "reference-takeover", attemptId: replacementAttempt.id };
    await db.transaction((tx) =>
      markAttemptPreparedForTestInTransaction(tx, {
        attemptId: replacementAttempt.id,
        evidence,
        digest: protocolDigest(evidence),
      }),
    );
    await acquireExecutionOwnership({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      attemptId: replacementAttempt.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      acquiredByType: "service",
      acquiredById: "reference-takeover",
    });

    await expect(
      renewExecutionOwnership({
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        ownershipId: first.authority.ownershipId,
        attemptId: first.authority.attemptId,
        leaseEpoch: Number(first.authority.leaseEpoch),
      }),
    ).rejects.toMatchObject({
      code: "NotCurrentExecutor",
    } satisfies Partial<ExecutionAuthorityError>);
  });

  it("START-08/START-09: resume uses a new generation and preserves the first remote references when a late response conflicts", async () => {
    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    runtime.callbackBeforeResponse = true;
    await runtime.start();
    const initial = await startFixture(fixture, runtime.endpoint);
    const anchorDigest = protocolDigest({ anchor: "reference-suspension" });
    await ingressRuntimeEvents({
      tenantId: fixture.tenantId,
      invocationId: fixture.invocation.id,
      batch: {
        protocolVersion: 3,
        authority: initial.authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "execution.suspended",
            schemaVersion: 1,
            payload: { reason: "reference-suspension", resumeAnchorDigest: anchorDigest },
          },
        ],
      },
    });
    runtime.callbackBeforeResponse = false;
    runtime.dropNextStartResponse = true;
    const resumeCommandId = await db.transaction((tx) =>
      createInvocationCommandInTransaction(tx, {
        tenantId: fixture.tenantId,
        invocationId: fixture.invocation.id,
        commandType: "resume",
        idempotencyKey: `reference-resume:${randomUUID()}`,
        payloadJson: { resume_source: "user_pause", resume_payload: { source: "user_pause" } },
        requestedByType: "user",
        requestedById: "reference-test",
      }),
    );
    const resumeSourceOperationKey = `command:${resumeCommandId}`;
    const firstResumeFailure = await resumeRuntimeInvocation({
      tenantId: fixture.tenantId,
      invocation: fixture.invocation,
      sourceOperationKey: resumeSourceOperationKey,
      binding: fixture.binding,
      attempt: fixture.attempt,
      runtimeClient: createHttpRuntimeClient(),
      runtimeEndpoint: runtime.endpoint,
      auth: { mode: "none" },
      callbackEndpoints,
      anchor: "reference-suspension",
      anchorDigest,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(firstResumeFailure).toBeInstanceOf(RuntimeStartTransportError);
    if (!(firstResumeFailure instanceof RuntimeStartTransportError)) {
      throw new Error("缺少 Resume 原始派发身份");
    }
    const resumed = await resumeRuntimeInvocation({
      tenantId: fixture.tenantId,
      invocation: fixture.invocation,
      sourceOperationKey: resumeSourceOperationKey,
      binding: fixture.binding,
      attempt: fixture.attempt,
      runtimeClient: createHttpRuntimeClient(),
      runtimeEndpoint: runtime.endpoint,
      auth: { mode: "none" },
      callbackEndpoints,
      anchor: "reference-suspension",
      anchorDigest,
      sessionDispatchClaim: firstResumeFailure.dispatchIdentity,
    });
    const sessions = await getRuntimeSessionBindingsByInvocation(
      fixture.tenantId,
      fixture.invocation.id,
    );
    const resumedSession = sessions.find((session) => session.id !== initial.sessionBindingId);
    expect(resumedSession).toMatchObject({ intentType: "resume", bindingState: "dispatching" });
    expect(runtime.requests.filter((entry) => entry.path.endsWith("/resume"))).toHaveLength(2);
    expect(
      (await runtime.store()).starts[`start:${resumed.authority.ownershipId}`]?.executionCount,
    ).toBe(1);

    const conflicting = createMockRuntimeClient({
      resumeInvocation: async (request) => ({
        protocolVersion: 3,
        authority: request.request.authority,
        semanticRequestDigest: request.request.semanticRequestDigest,
        accepted: true,
        remoteSessionRef: "conflicting-session",
        remoteExecutionRef: "conflicting-execution",
        capabilitiesDigest: runtime!.capabilitiesDigest,
        acceptedAt: Date.now(),
      }),
    });
    await expect(
      startRuntimeInvocation({
        tenantId: fixture.tenantId,
        sourceOperationKey: resumeSourceOperationKey,
        invocation: (
          await db
            .select()
            .from(invocationTable)
            .where(eq(invocationTable.id, fixture.invocation.id))
        )[0]!,
        binding: fixture.binding,
        attempt: fixture.attempt,
        runtimeClient: conflicting,
        runtimeEndpoint: runtime.endpoint,
        auth: { mode: "none" },
        callbackEndpoints,
        intentType: "resume",
        recovery: { kind: "resume", anchor: "reference-suspension", anchorDigest },
      }),
    ).rejects.toThrow("ProtocolViolation");
    const preserved = await getRuntimeSessionBindingById(
      fixture.tenantId,
      resumedSession?.id ?? "",
    );
    expect(preserved).toMatchObject({
      remoteSessionRef: resumed.remoteSessionRef,
      remoteExecutionRef: resumed.remoteExecutionRef,
    });
  });

  it("START-10/START-11: runtimes missing heartbeat and old protocol requests fail closed before publication or transport side effects", async () => {
    const missingHeartbeat = {
      ...defaultRuntimeCapabilities(),
      features: { ...defaultRuntimeCapabilities().features, heartbeat: false },
    } as unknown as RuntimeCapabilities;
    expect(() => validateRuntimeProtocolCapabilities(missingHeartbeat)).toThrow();

    const fixture = await seedStartFixture();
    runtime = new DurableReferenceRuntime(fixture.tenantId, fixture.binding.runtimeRevisionId);
    await runtime.start();
    const started = await startFixture(fixture, runtime.endpoint);
    const request = runtime.requests[0]?.request;
    expect(request).toBeDefined();
    await expect(
      createHttpRuntimeClient().startInvocation({
        runtimeEndpoint: runtime.endpoint,
        auth: { mode: "none" },
        idempotencyKey: `start:${started.authority.ownershipId}:old-contract`,
        request: { ...request!, protocolVersion: 2 } as unknown as RuntimeStartRequest,
      }),
    ).rejects.toBeDefined();
    expect(runtime.requests).toHaveLength(1);
  });
});
