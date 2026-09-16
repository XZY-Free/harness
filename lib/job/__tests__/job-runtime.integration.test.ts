import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import { sameAuthority } from "@/lib/executions/domain/execution-authority";
import { createAttempt } from "@/lib/executions/persistence/attempt-store";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { consumeJobCommand } from "@/lib/job/job-command-consumer";
import { createCancelCommand, createRetryCommand } from "@/lib/job/job-command-queries";
import { processRetryCommand } from "@/lib/job/job-control-queries";
import {
  JobExecutionConflictError,
  createJobInvocation,
  createJobInvocationInTransaction,
} from "@/lib/job/job-execution";
import { createJob, getJobById } from "@/lib/job/job-queries";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { invocationTable } from "@/lib/persistence/schema/executions";
import type { NewExecutionBinding } from "@/lib/persistence/schema/executions";
import { jobCommandTable, jobEventTable } from "@/lib/persistence/schema/job";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import type { RuntimeStartRequest, RuntimeStartResponse } from "@/lib/runtime/runtime-protocol";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

// CallbackEndpoints 的合法形状（与 runtime-start-recovery 测试一致）：
// 空对象会在 buildRuntimeStartRequestForInvocation 的 zod 校验处提前抛错，无法到达 transport。
const callbackEndpoints = {
  events: "http://127.0.0.1/runtime/events",
  heartbeat: "http://127.0.0.1/runtime/heartbeat",
  context: "http://127.0.0.1/gateway/context",
  capabilityActions: "http://127.0.0.1/gateway/capability-actions",
  toolCalls: "http://127.0.0.1/gateway/tool-calls",
  userActions: "http://127.0.0.1/gateway/user-actions",
};

function jobBindingFingerprintInput(): Omit<NewExecutionBinding, "tenantId" | "invocationId"> {
  const digest = (value: string) => protocolDigest(value);
  return {
    runtimeRevisionId: randomUUID(),
    deploymentRouteId: "job-test-route",
    routeRevisionId: randomUUID(),
    routeActivationId: randomUUID(),
    routeContentDigest: digest("route-content"),
    modelProvider: "test",
    modelId: "test-model",
    modelRevisionRef: null,
    workspaceBindingId: "",
    policyRevisionId: randomUUID(),
    policyRulesDigest: digest("policy-rules"),
    governanceConfigRevisionId: randomUUID(),
    governanceConfigDigest: digest("governance-config"),
    runtimeArtifactId: null,
    runtimeArtifactDigest: null,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest("target"),
    runtimeConfigDigest: digest("runtime-config"),
    capabilityManifestDigest: digest("manifest"),
    runtimeAttestationIds: [],
    runtimePublicationRecordId: randomUUID(),
    conformanceRunId: randomUUID(),
    resolutionInputDigest: digest("resolution"),
    projectionVersionNo: 1,
    environmentDefinitionRevisionId: null,
    environmentMode: "NO_PLATFORM_ENVIRONMENT",
    principalType: "service",
    principalId: "job-scheduler",
    principalSource: "trusted_service",
    principalFrozenAt: new Date(),
    capabilityCatalogDigest: digest("catalog"),
    capabilityCatalogJson: { fixture: "job-test" },
    capabilityCatalogCreatedAt: new Date(),
    capabilityCatalogVersion: "1",
    capabilityCatalogSourceRefs: [],
    configHash: digest("binding-config"),
    controlPlaneEvidence: {
      kind: "job-binding",
      routeRevisionId: digest("route-revision"),
      routeActivationId: digest("route-activation"),
      routeContentDigest: digest("route-content"),
      resolutionInputDigest: digest("resolution"),
    },
  } as Omit<NewExecutionBinding, "tenantId" | "invocationId">;
}

async function seedPublishedRuntimeRevision(): Promise<string> {
  const { runtimeTable, runtimeRevisionTable } = await import("@/lib/persistence/schema/runtimes");
  const runtimeId = randomUUID();
  const revisionId = randomUUID();
  const digest = protocolDigest({
    runtimeId,
    runtimeRevisionId: revisionId,
    fixture: "job-runtime",
  });
  await db.insert(runtimeTable).values({
    id: runtimeId,
    tenantId: TENANT_ID,
    runtimeKey: `job-runtime-${runtimeId}`,
    displayName: "Job Runtime",
    runtimeKind: "external",
    ownerUserId: "test-user",
    lifecycleState: "enabled",
    currentRevisionId: revisionId,
    versionNo: 1,
  });
  const { defaultRuntimeCapabilities } = await import("@/lib/runtime/runtime-client");
  await db.insert(runtimeRevisionTable).values({
    id: revisionId,
    tenantId: TENANT_ID,
    runtimeId,
    revisionNo: 1,
    protocolType: "harness_runtime_protocol",
    protocolVersion: 3,
    protocolContractDigest: digest,
    runtimeEvidenceKind: "external_endpoint",
    runtimeTargetDigest: digest,
    endpointRef: "http://127.0.0.1/job-runtime",
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
  return revisionId;
}

async function seedJobFixture(
  input: {
    inputJson?: unknown;
    creationKey?: string;
    triggerRef?: string;
    runtimeRevisionId?: string;
  } = {},
) {
  const inputJson = input.inputJson ?? { task: "job-fixture" };
  const { job } = await createJob({
    tenantId: TENANT_ID,
    agentId: randomUUID(),
    jobType: "batch",
    triggerRef: input.triggerRef ?? `trigger:${randomUUID()}`,
    creationKey: input.creationKey,
    completionPolicyJson: { policy: "all_success" },
    inputJson,
  });
  const workspace = await createNoPlatformWorkspaceBinding(TENANT_ID, "test-service");
  const bindingInput = { ...jobBindingFingerprintInput(), workspaceBindingId: workspace.id };
  if (input.runtimeRevisionId) bindingInput.runtimeRevisionId = input.runtimeRevisionId;
  const created = await createJobInvocation({
    tenantId: TENANT_ID,
    jobId: job.id,
    binding: bindingInput,
  });
  return { workspace, bindingInput, ...created };
}

function startResponseStub(
  transportRequest: {
    request: RuntimeStartRequest;
  },
  // External start capability 一致性：默认摘要仅用于无发布事实的旧用例；
  // 有真实 RuntimeRevision 的用例必须传 computeCapabilityManifestDigest 结果。
  capabilitiesDigest: string = protocolDigest({ capabilities: "job-test" }),
): RuntimeStartResponse {
  const request = transportRequest.request;
  return {
    protocolVersion: 3,
    accepted: true,
    acceptedAt: Date.now(),
    semanticRequestDigest: request.semanticRequestDigest,
    authority: request.authority,
    remoteSessionRef: `remote-session:${randomUUID()}`,
    remoteExecutionRef: `remote-execution:${randomUUID()}`,
    capabilitiesDigest,
  } as RuntimeStartResponse;
}

describe("Thread-independent Job runtime integration", () => {
  let originalSigningKeyId: string | undefined;

  beforeAll(() => {
    originalSigningKeyId = process.env.WORKLOAD_SIGNING_KEY_ID;
    process.env.WORKLOAD_SIGNING_KEY_ID = "test-job-runtime-key";
  });

  afterAll(() => {
    if (originalSigningKeyId === undefined) process.env.WORKLOAD_SIGNING_KEY_ID = undefined;
    else process.env.WORKLOAD_SIGNING_KEY_ID = originalSigningKeyId;
  });

  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("JOB-01: a pure Job executes Initial→terminal→Job complete without any Thread or Turn", async () => {
    const fixture = await seedJobFixture();
    expect(fixture.invocation.subjectType).toBe("job");
    expect(fixture.invocation.threadId).toBeNull();
    expect(fixture.invocation.turnId).toBeNull();
    expect(fixture.invocation.inputDigest).toBe(fixture.job.inputHash);
    // 不创建 Thread/Turn。
    const threads = await db.select().from(threadTable).where(eq(threadTable.tenantId, TENANT_ID));
    expect(threads).toEqual([]);
    // 唯一终态路径：completed 终态与 Job 桥同事务持久化。
    const terminal = await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/ref",
        resultDigest: protocolDigest({ result: "ok" }),
      }),
    );
    expect(terminal.executionState).toBe("completed");
    const [command] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    expect(command?.commandState).toBe("queued");
    // 消费终态命令 → Job completed。
    const consumed = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(consumed.outcome).toBe("terminal_applied");
    expect(consumed.job.jobState).toBe("completed");
    const job = await getJobById(TENANT_ID, fixture.job.id);
    expect(job?.resultRef).toBe("job://result/ref");
  });

  it("JOB-02: two racing scheduler deliveries return the identical frozen Invocation and Binding", async () => {
    const fixture = await seedJobFixture();
    const { job } = fixture;
    const bindingInput = fixture.bindingInput;
    const firstDelivery = createJobInvocation({
      tenantId: TENANT_ID,
      jobId: job.id,
      binding: bindingInput,
    });
    const secondDelivery = createJobInvocation({
      tenantId: TENANT_ID,
      jobId: job.id,
      binding: bindingInput,
    });
    const [firstResult, secondResult] = await Promise.all([firstDelivery, secondDelivery]);
    expect(firstResult.invocation.id).toBe(secondResult.invocation.id);
    expect(firstResult.binding.invocationId).toBe(secondResult.binding.invocationId);
    // seedJobFixture 已创建过一次，重复投递是幂等重放：created=false，ID 不变。
    expect(firstResult.created).toBe(false);
    expect(secondResult.created).toBe(false);
    const invocations = await db
      .select()
      .from(invocationTable)
      .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.jobId, job.id)));
    expect(invocations).toHaveLength(1);
  });

  it("JOB-03: the same creationKey with a different input hash conflicts and never overwrites the input", async () => {
    await createJob({
      tenantId: TENANT_ID,
      agentId: randomUUID(),
      jobType: "batch",
      triggerRef: "trigger:duplicate",
      creationKey: "creation:duplicate",
      completionPolicyJson: {},
      inputJson: { task: "original" },
    });
    await expect(
      createJob({
        tenantId: TENANT_ID,
        agentId: randomUUID(),
        jobType: "batch",
        triggerRef: "trigger:duplicate",
        creationKey: "creation:duplicate",
        completionPolicyJson: {},
        inputJson: { task: "tampered" },
      }),
    ).rejects.toMatchObject({ name: "InputDigestMismatch" });
    const jobs = await db
      .select()
      .from((await import("@/lib/persistence/schema/job")).jobTable)
      .where(
        and(
          eq((await import("@/lib/persistence/schema/job")).jobTable.tenantId, TENANT_ID),
          eq(
            (await import("@/lib/persistence/schema/job")).jobTable.creationKey,
            "creation:duplicate",
          ),
        ),
      );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.inputJson).toEqual({ task: "original" });
  });

  it("JOB-04: a resolved input digest that diverges from the frozen input is rejected before runtime start", async () => {
    const { startRuntimeInvocation } = await import("@/lib/runtime/application/runtime-start");
    const fixture = await seedJobFixture();
    const attempt = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    const tamperedDigest = protocolDigest({ task: "tampered-provider-content" });
    await expect(
      startRuntimeInvocation({
        tenantId: TENANT_ID,
        invocation: fixture.invocation,
        attempt,
        binding: fixture.binding,
        runtimeClient: {} as RuntimeHttpClient,
        runtimeEndpoint: "http://127.0.0.1/stub",
        auth: { mode: "none" },
        callbackEndpoints,
        expectedInputDigest: tamperedDigest,
      }),
    ).rejects.toThrow("InputDigestMismatch");
    // 冻结摘要一致时可通过该校验（后续才是正常派发路径）。
    const [freshInvocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(freshInvocation?.inputDigest).toBe(fixture.job.inputHash);
  });

  it("JOB-05: a transport retry of the same start intent keeps Invocation, Attempt, Ownership and StartKey identical", async () => {
    const { startRuntimeInvocation } = await import("@/lib/runtime/application/runtime-start");
    const revisionId = await seedPublishedRuntimeRevision();
    const fixture = await seedJobFixture({ runtimeRevisionId: revisionId });
    const attempt = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    let failing = true;
    // 幂等 Runtime：同一 idempotencyKey 的重放必须返回完全相同的 remote refs。
    const replayCache = new Map<string, RuntimeStartResponse>();
    const { computeCapabilityManifestDigest } = await import(
      "@/lib/routes/domain/route-resolution-policy"
    );
    const { defaultRuntimeCapabilities } = await import("@/lib/runtime/runtime-client");
    const publishedDigest = computeCapabilityManifestDigest({
      runtimeRevisionId: revisionId,
      runtimeCapabilities: defaultRuntimeCapabilities(),
    });
    const client: RuntimeHttpClient = {
      probeCapabilities: async () => {
        throw new Error("not used");
      },
      startInvocation: async (request) => {
        if (failing) {
          failing = false;
          throw new RuntimeHttpClientError("network", "响应丢失");
        }
        const cached = replayCache.get(request.idempotencyKey);
        if (cached) return cached;
        const response = startResponseStub(request, publishedDigest);
        replayCache.set(request.idempotencyKey, response);
        return response;
      },
      resumeInvocation: async (request) => startResponseStub(request, publishedDigest),
      postEventBatch: async () => {
        throw new Error("not used");
      },
      heartbeat: async () => {
        throw new Error("not used");
      },
      cancelInvocation: async () => {
        throw new Error("not used");
      },
      steerInvocation: async () => {
        throw new Error("not used");
      },
      requestSafePoint: async () => {
        throw new Error("not used");
      },
      releaseSafePoint: async () => undefined,
    };
    const startInput = {
      tenantId: TENANT_ID,
      invocation: fixture.invocation,
      attempt,
      binding: fixture.binding,
      runtimeClient: client,
      runtimeEndpoint: "http://127.0.0.1/stub",
      auth: { mode: "none" } as const,
      callbackEndpoints,
    };
    await expect(startRuntimeInvocation(startInput)).rejects.toBeInstanceOf(RuntimeHttpClientError);
    const retry = await startRuntimeInvocation(startInput);
    expect(retry.sessionBindingId).toBeTruthy();
    // 同一 Invocation 只有一个 Attempt、一个 active Ownership、一个 StartKey。
    const invocations = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(invocations).toHaveLength(1);
    const retryAgain = await startRuntimeInvocation(startInput);
    expect(retryAgain.sessionBindingId).toBe(retry.sessionBindingId);
    expect(retryAgain.authority.ownershipId).toBe(retry.authority.ownershipId);
    expect(retryAgain.authority.leaseEpoch).toBe(retry.authority.leaseEpoch);
  });

  it("JOB-06: redispatch keeps Job, Invocation and Binding frozen while creating a new Attempt and Owner", async () => {
    const fixture = await seedJobFixture();
    const attempt2 = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      retryReasonCode: "instance_lost",
    });
    expect(attempt2.attemptNo).toBeGreaterThan(fixture.invocation.lastOwnershipEpoch);
    const [bindingRow] = await db
      .select()
      .from((await import("@/lib/persistence/schema/executions")).executionBindingTable)
      .where(
        eq(
          (await import("@/lib/persistence/schema/executions")).executionBindingTable.invocationId,
          fixture.invocation.id,
        ),
      );
    // Binding 冻结不变（同 configHash/同一行）。
    expect(bindingRow?.configHash).toBe(fixture.binding.configHash);
    const invocations = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.jobId, fixture.job.id));
    expect(invocations).toHaveLength(1);
  });

  it("JOB-07: terminal and Job bridge are one transaction — a crash rolls both back", async () => {
    const fixture = await seedJobFixture();
    await expect(
      db.transaction(async (tx) => {
        await transitionInvocation(tx, {
          tenantId: TENANT_ID,
          invocationId: fixture.invocation.id,
          nextState: "completed",
          resultRef: "job://result/ref",
          resultDigest: protocolDigest({ result: "ok" }),
        });
        throw new Error("simulated consumer crash before commit");
      }),
    ).rejects.toThrow("simulated consumer crash before commit");
    // Invocation 终态与 JobCommand 桥全部回滚，不出现卡住的半程状态。
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, fixture.invocation.id));
    expect(invocation?.executionState).toBe("queued");
    const commands = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    expect(commands).toEqual([]);
  });

  it("JOB-08: a durable terminal command survives consumer restart; replay does not duplicate", async () => {
    const fixture = await seedJobFixture();
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/ref",
        resultDigest: protocolDigest({ result: "ok" }),
      }),
    );
    const [command] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    const first = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(first.outcome).toBe("terminal_applied");
    // 消费进程崩溃重启后重复投递同一命令：terminal_replayed，不重复修改或事件。
    const replay = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(replay.outcome).toBe("terminal_replayed");
    const events = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.tenantId, TENANT_ID),
          eq(jobEventTable.jobId, fixture.job.id),
          eq(jobEventTable.eventType, "job.completed"),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it("JOB-09: an unresolved effect moves the Job to waiting_external with a durable retry timestamp", async () => {
    const fixture = await seedJobFixture();
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/ref",
        resultDigest: protocolDigest({ result: "ok" }),
      }),
    );
    const [command] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    const waiting = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: command!.id,
      unknownEffectVerifier: async () => false,
    });
    expect(waiting.outcome).toBe("waiting_external");
    expect(waiting.job.jobState).toBe("waiting_external");
    expect(waiting.command.commandState).toBe("waiting");
    expect(waiting.command.nextAttemptAt).not.toBeNull();
    // 持久唤醒：核对通过后同一命令恢复并完成 Job。
    const resumed = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: command!.id,
      unknownEffectVerifier: async () => true,
    });
    expect(resumed.outcome).toBe("terminal_applied");
    expect(resumed.job.jobState).toBe("completed");
  });

  it("JOB-10: a duplicate retry request creates exactly one replacement and never reopens the original Job", async () => {
    const fixture = await seedJobFixture({ triggerRef: "t10" });
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "failed",
        errorCode: "test_failure",
        errorSummary: "job failed",
      }),
    );
    const [command] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    const firstRetry = await createRetryCommand({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      requestedBy: "scheduler",
      idempotencyKey: "retry:job-10",
    });
    expect(firstRetry.replayed).toBe(false);
    const duplicateRetry = await createRetryCommand({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      requestedBy: "scheduler",
      idempotencyKey: "retry:job-10",
    });
    expect(duplicateRetry.replayed).toBe(true);
    expect(duplicateRetry.command.id).toBe(firstRetry.command.id);
    const processed = await processRetryCommand({
      tenantId: TENANT_ID,
      commandId: firstRetry.command.id,
    });
    const processedAgain = await processRetryCommand({
      tenantId: TENANT_ID,
      commandId: firstRetry.command.id,
    });
    // 重复消费同一 retry 命令：同一个 Replacement，不产生第二个。
    const replacementIds = [processed.replacementJob?.id, processedAgain.replacementJob?.id].filter(
      Boolean,
    );
    expect(replacementIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(replacementIds).size).toBe(1);
    // 原始 Job 不被重开：仍是终态。
    const original = await getJobById(TENANT_ID, fixture.job.id);
    expect(["failed", "completed", "cancelled"]).toContain(original?.jobState);
    if (processed.replacementJob) {
      expect(processed.replacementJob.replacesJobId).toBe(fixture.job.id);
    }
  });

  it("JOB-11: a cancel racing a completion converges on the Job authority without overwriting the terminal state", async () => {
    const fixture = await seedJobFixture();
    const cancel = await createCancelCommand({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      requestedBy: "user",
      idempotencyKey: "cancel:job-11",
    });
    expect(cancel.replayed).toBe(false);
    // 完成先落定：Invocation completed → 终态命令消费 → Job completed。
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/ref",
        resultDigest: protocolDigest({ result: "ok" }),
      }),
    );
    const [terminalCommand] = await db
      .select()
      .from(jobCommandTable)
      .where(
        and(
          eq(jobCommandTable.tenantId, TENANT_ID),
          eq(jobCommandTable.jobId, fixture.job.id),
          eq(jobCommandTable.commandType, "execution_terminal"),
        ),
      );
    const applied = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: terminalCommand!.id,
    });
    expect(applied.outcome).toBe("terminal_applied");
    // 取消命令在终态之后被消费：不得覆盖既有终态。
    const consumed = await consumeJobCommand({ tenantId: TENANT_ID, commandId: cancel.command.id });
    expect(["rejected_job_terminal", "cancelled", "waiting_invocations"]).toContain(
      consumed.outcome,
    );
    const finalJob = await getJobById(TENANT_ID, fixture.job.id);
    expect(finalJob?.jobState).toBe("completed");
    expect(finalJob?.resultRef).toBe("job://result/ref");
  });

  it("JOB-12: ContextHandle subjects are strictly isolated between Job and Thread", async () => {
    const { issueContextHandle, resolveContextHandle } = await import(
      "@/lib/context/context-handle"
    );
    const fixture = await seedJobFixture();
    // Job Handle：subject.type=job，携带 jobId / inputHash，不携带 Thread 字段。
    const jobHandle = await resolveContextHandle(
      await issueContextHandle({ tenantId: TENANT_ID, invocationId: fixture.invocation.id }),
      { tenantId: TENANT_ID, invocationId: fixture.invocation.id },
    );
    expect(jobHandle.subject.type).toBe("job");
    if (jobHandle.subject.type === "job") {
      expect(jobHandle.subject.jobId).toBe(fixture.job.id);
      expect("threadId" in jobHandle.subject).toBe(false);
      expect("turnId" in jobHandle.subject).toBe(false);
    }
    // Thread Handle 不携带 Job 字段。
    const { threadId, invocationId: threadInvocationId } = await (
      await import("@/lib/executions/test-support/seed-runtime-authority")
    )
      .seedPreparedRuntimeAttempt()
      .then((r) => ({ threadId: r.threadId, invocationId: r.invocation.id }));
    const threadHandle = await resolveContextHandle(
      await issueContextHandle({ tenantId: TENANT_ID, invocationId: threadInvocationId }),
      { tenantId: TENANT_ID, invocationId: threadInvocationId },
    );
    expect(threadHandle.subject.type).toBe("thread");
    if (threadHandle.subject.type === "thread") {
      expect(threadHandle.subject.threadId).toBe(threadId);
      expect("jobId" in threadHandle.subject).toBe(false);
    }
  });
});
