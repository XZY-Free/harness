/**
 * Thread 无关的 Job runtime 集成回归 + `manifests/tests.json` 验收义务。
 *
 * 编号约定（必须遵守，否则验收映射会失真）：
 * - `JOB-01..JOB-09` 是 `docs/topic02/.../manifests/tests.json` 定义的**验收义务**，
 *   只有场景与 `mustAssert` 完全对应时才可使用该编号。
 * - 其余用例一律用 `JOB-REG-nn`（补充回归），不得占用验收编号。
 */
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { workspaceConfig } from "@/lib/config";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { issueContextHandle, resolveContextHandle } from "@/lib/context/context-handle";
import { db, openMigrationConnection } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import { sameAuthority } from "@/lib/executions/domain/execution-authority";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import {
  acquireTestRuntimeAuthority,
  seedPreparedJobRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import {
  ALL_SUCCESS_COMPLETION_POLICY,
  UNKNOWN_EFFECT_HANDLING,
} from "@/lib/job/completion-policy";
import { admitQueuedJob, resolveJobBindingCommand } from "@/lib/job/job-admission";
import { consumeJobCommand } from "@/lib/job/job-command-consumer";
import { createCancelCommand, createRetryCommand } from "@/lib/job/job-command-queries";
import { processRetryCommand } from "@/lib/job/job-control-queries";
import { createJobInvocation } from "@/lib/job/job-execution";
import { computeJobInputDigest } from "@/lib/job/job-input-digest";
import { storeJobInputReference } from "@/lib/job/job-input-reference";
import { createJob, getJobById } from "@/lib/job/job-queries";
import {
  admitJobStep,
  completeJobStep,
  computeJobStepKey,
  computeJobStepOperationKey,
  failJobStep,
  runJobStepEffect,
} from "@/lib/job/job-step-effects";
import { spawnJobConsumerCrashProcess } from "@/lib/job/test-support/job-consumer-crash-process";
import { threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  executionBindingTable,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { jobCommandTable, jobEventTable, jobTable } from "@/lib/persistence/schema/job";
import { ingressRuntimeEvents } from "@/lib/runtime/application/ingress-runtime-events";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { redispatchRuntimeInvocation } from "@/lib/runtime/application/runtime-redispatch";
import { createConfiguredHostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { startRuntimeInvocation } from "@/lib/runtime/application/runtime-start";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { createDirectResponsePorts } from "@/lib/runtime/harness-loop/test-ports";
import { getRuntimeSessionBindingsByInvocation } from "@/lib/runtime/persistence/runtime-session-store";
import { DISPATCH_STUCK_GRACE_MS } from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  runDueUndispatchedIntentRecoveries,
  scanUndispatchedInvocations,
} from "@/lib/runtime/retry/undispatched-intent-lane";
import { createHttpRuntimeClient, createMockRuntimeClient } from "@/lib/runtime/runtime-client";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import {
  type RuntimeStartRequest,
  RuntimeStartRequestSchema,
  type RuntimeStartResponse,
} from "@/lib/runtime/runtime-protocol";
import { canonicalizeJson, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { applyRuntimeSessionDispatchForTest } from "@/lib/runtime/test-support/session-write-fixtures";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";
import { seedRuntimeRouteAuthority } from "@/lib/test-support/seed-runtime-route-authority";
import { createProductionWorkerRole } from "@/lib/workers/production-worker-role";
import { createWorkspace, createWorkspaceBinding } from "@/lib/workspace/workspace-queries";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

/** 重新签名测试凭据，以验证有合法签名但混入另一类主体字段时仍被正式读取入口拒绝。 */
function signedContextWithExtraSubjectField(issued: string, field: string, value: string): string {
  const [, header, payload] = issued.split(".");
  if (!header || !payload) throw new Error("测试 ContextHandle 格式非法");
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  parsed.subject[field] = value;
  const changedPayload = Buffer.from(canonicalizeJson(parsed), "utf8").toString("base64url");
  const secret =
    process.env.SNOW_CONTEXT_HANDLE_SECRET?.trim() || "snow-context-handle-test-secret-32-bytes";
  const mac = createHmac("sha256", secret)
    .update(`snowharness.context\0${header}.${changedPayload}`, "utf8")
    .digest("base64url");
  return `ch.${header}.${changedPayload}.${mac}`;
}

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

/** Job 夹具使用的 Runtime 能力集（与发布证据一起冻结进 Binding）。 */
const JOB_RUNTIME_CAPABILITIES = ["event_stream"];

/** 幂等建出默认租户 + 默认 owner（Job admission 需要可信 principal 事实）。 */
async function ensureDefaultTenantOwner(): Promise<string> {
  await ensureDefaultTenant();
  const identity = await upsertUserIdentity({
    tenantId: TENANT_ID,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return identity.id;
}

/**
 * 建出可直接被默认 Route Resolver 解析的 RuntimeRevision（真实发布链 + Route 权威）。
 *
 * §27/§2：Job 的 Binding 走与 Thread 同一个 Binding Authority，因此夹具必须提供真实
 * Route/Publication/Conformance/Projection 证据，不能伪造 Projection 或直接插台账行。
 */
async function seedJobRuntimeAuthority(): Promise<{
  runtimeRevisionId: string;
  capabilities: string[];
}> {
  const ownerId = await ensureDefaultTenantOwner();
  const suffix = randomUUID().slice(0, 8);
  const { revision } = await seedPublishedRuntimeRevision(
    TENANT_ID,
    ownerId,
    `job-runtime-${suffix}`,
    JOB_RUNTIME_CAPABILITIES,
    suffix,
  );
  await seedRuntimeRouteAuthority({
    tenantId: TENANT_ID,
    runtimeRevisionId: revision.id,
    actorId: "job-fixture",
  });
  return { runtimeRevisionId: revision.id, capabilities: JOB_RUNTIME_CAPABILITIES };
}

/**
 * 建出"已接纳"的纯 Job：Job → 唯一 Invocation → 完整 Binding，全部走
 * `admitQueuedJob`（R01 §2/§3）。测试不自行拼装 Binding 台账行。
 */
async function seedJobFixture(
  input: {
    inputJson?: unknown;
    creationKey?: string;
    triggerRef?: string;
    /** 复用已建好的 Runtime 权威（含 capabilities，供 Start 一致性断言使用）。 */
    runtime?: { runtimeRevisionId: string; capabilities: string[] };
  } = {},
) {
  const inputJson = input.inputJson ?? { task: "job-fixture" };
  const runtime = input.runtime ?? (await seedJobRuntimeAuthority());
  const { job } = await createJob({
    tenantId: TENANT_ID,
    agentId: randomUUID(),
    jobType: "batch",
    triggerRef: input.triggerRef ?? `trigger:${randomUUID()}`,
    creationKey: input.creationKey,
    completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
    inputJson,
  });
  const admitted = await admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id });
  if (admitted.outcome !== "admitted") {
    throw new Error(`seedJobFixture: Job admission 未接纳（${admitted.outcome}）`);
  }
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, admitted.invocationId))
    .limit(1);
  const binding = await getExecutionBindingByInvocation(TENANT_ID, admitted.invocationId);
  if (!invocation || !binding)
    throw new Error("seedJobFixture: 接纳后回读 Invocation/Binding 失败");
  return { job, invocation, binding, runtime };
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

// ─── JOB-08（CompletionPolicy）夹具 ───────────────────────

/** 首次派发的 Provider 证据（不含凭据明文），与 EFFECT 用例保持同一形状。 */
const JOB08_PROVIDER = {
  providerType: "test_provider",
  connectionId: "conn-job-08",
  endpointFingerprint: protocolDigest({ endpoint: "https://provider.test/job-08" }),
};

/**
 * 按**指定冻结策略**建出 Job，并推到 `executing`（这样 Ingress 才接纳 `job.step.*`）。
 *
 * 策略在 `createJob` 时冻结且此后不可改写，因此每个场景必须使用自己的 Job。
 * Route 权威是租户级且唯一键固定，所以同一测试内的后续场景必须复用第一次建好的
 * 权威（`reuseRuntimeAuthority`），不能重复建 RouteSet。
 */
async function seedExecutingJobForPolicy(
  policyJson: Record<string, unknown>,
  reuseRuntimeAuthority?: { runtimeRevisionId: string },
) {
  const fixture = await seedPreparedJobRuntimeAttempt({
    completionPolicyJson: policyJson,
    ...(reuseRuntimeAuthority ? { reuseRuntimeAuthority } : {}),
  });
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    phase: "executing",
  });
  await applyRuntimeSessionDispatchForTest(fixture.tenantId, acquired.session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "job-08-completion-policy" },
    semanticRequestDigest: protocolDigest({ kind: "job-08-completion-policy" }),
    remoteSessionRef: `job-08-session:${fixture.invocation.id}`,
    remoteExecutionRef: `job-08-execution:${fixture.invocation.id}`,
    startedEventId: randomUUID(),
  });
  return { fixture, authority: acquired.authority };
}

type PolicyScenario = Awaited<ReturnType<typeof seedExecutingJobForPolicy>>;

/** 构造冻结的 `threshold` 策略（契约要求 threshold.successRatio ∈ (0, 1]）。 */
function thresholdPolicy(successRatio: number): Record<string, unknown> {
  return {
    kind: "threshold",
    scope: "root_invocation_and_required_children",
    unknownEffects: UNKNOWN_EFFECT_HANDLING,
    threshold: { successRatio },
  };
}

/** 稳定派生 step 规格（不含 Attempt / 时间，重试得到同一 stepKey）。 */
function makePolicyStep(stage: string, seed: string) {
  const inputRefs = [{ ref: `source://kb/${seed}`, digest: protocolDigest({ source: seed }) }];
  const processorDigest = protocolDigest({ processor: stage, revision: 1 });
  return {
    stage,
    inputRefs,
    processorDigest,
    profileDigest: protocolDigest({ profile: stage }),
    requestDigest: protocolDigest({ stage, seed, processorDigest }),
    stepKey: computeJobStepKey({ stage, inputRefs, processorDigest }),
  };
}

/** 只接纳、不给终态结果 —— 即"仍在运行"的成员（必须让 Job 等，不能算成功）。 */
async function admitPolicyStep(scenario: PolicyScenario, stage: string, seed: string) {
  const step = makePolicyStep(stage, seed);
  const admission = await admitJobStep({
    tenantId: TENANT_ID,
    jobId: scenario.fixture.job.id,
    authority: scenario.authority,
    stepKey: step.stepKey,
    stage: step.stage,
    inputRefs: step.inputRefs,
    processorDigest: step.processorDigest,
    profileDigest: step.profileDigest,
    requestDigest: step.requestDigest,
  });
  return { ...step, ownerRef: admission.ownerRef };
}

/** 接纳 + 提交成功结果（该步骤无外部 Effect，因此 operationKeys 为空）。 */
async function completePolicyStep(scenario: PolicyScenario, stage: string, seed: string) {
  const step = await admitPolicyStep(scenario, stage, seed);
  await completeJobStep({
    tenantId: TENANT_ID,
    authority: scenario.authority,
    ownerRef: step.ownerRef,
    invocationId: scenario.fixture.invocation.id,
    stepKey: step.stepKey,
    stage: step.stage,
    operationKeys: [],
    resultRef: `artifact://job-08/${step.stepKey}`,
    resultDigest: protocolDigest({ step: step.stepKey, outcome: "ok" }),
  });
  return step;
}

/** 接纳 + 提交确定失败（错误必须是稳定引用，不是 Unknown）。 */
async function failPolicyStep(scenario: PolicyScenario, stage: string, seed: string) {
  const step = await admitPolicyStep(scenario, stage, seed);
  await failJobStep({
    tenantId: TENANT_ID,
    authority: scenario.authority,
    ownerRef: step.ownerRef,
    invocationId: scenario.fixture.invocation.id,
    stepKey: step.stepKey,
    stage: step.stage,
    operationKeys: [],
    errorRef: `error://job-08/${step.stepKey}`,
    errorDigest: protocolDigest({ step: step.stepKey, outcome: "failed" }),
    errorCode: "step_failed",
  });
  return step;
}

/** 顶层 Invocation 收口，并回读同事务产生的 `execution_terminal` 命令。 */
async function terminateRootInvocation(scenario: PolicyScenario) {
  await db.transaction((tx) =>
    transitionInvocation(tx, {
      tenantId: TENANT_ID,
      invocationId: scenario.fixture.invocation.id,
      nextState: "completed",
      resultRef: "job://result/job-08",
      resultDigest: protocolDigest({ result: "job-08" }),
    }),
  );
  const [command] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(
        eq(jobCommandTable.tenantId, TENANT_ID),
        eq(jobCommandTable.jobId, scenario.fixture.job.id),
        eq(jobCommandTable.commandType, "execution_terminal"),
      ),
    );
  if (!command) throw new Error("JOB-08: execution_terminal 命令未生成");
  return command;
}

/** 该 Job 上已落库的 `job.completed` 事实条数（用于断言"没有伪成功"）。 */
async function countJobCompletedEvents(jobId: string): Promise<number> {
  const rows = await db
    .select({ id: jobEventTable.id })
    .from(jobEventTable)
    .where(
      and(
        eq(jobEventTable.tenantId, TENANT_ID),
        eq(jobEventTable.jobId, jobId),
        eq(jobEventTable.eventType, "job.completed"),
      ),
    );
  return rows.length;
}

// ─── 真实 Runtime Event Batch 夹具（JOB-02 / JOB-03 / JOB-04 / JOB-05）─────

/** R02 §3：夹具 Session 冻结的发布能力证据（Hosted Revision 的能力名列表）。 */
const JOB_INGRESS_CAPABILITIES = ["event_stream"];

/**
 * 用**真实生产链路**把 Job 的顶层 Invocation 推到 `executing`。
 *
 * Attempt(prepared) → Runtime 权威 + start 会话(dispatching) → Ingress 接纳 `execution.started`。
 *
 * 终态必须经真实 `ingressRuntimeEvents` 提交才能复现 Job 终态桥的版本语义；
 * 因此这里不直接 UPDATE Invocation，每一步都走正式写入点。
 */
async function startJobRuntimeViaIngress(input?: {
  reuseRuntimeAuthority?: { runtimeRevisionId: string };
}) {
  const fixture = await seedPreparedJobRuntimeAttempt(
    input?.reuseRuntimeAuthority ? { reuseRuntimeAuthority: input.reuseRuntimeAuthority } : {},
  );
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: JOB_INGRESS_CAPABILITIES,
  });
  // 生产时序：Start 在派发前固定激活证据，此时 executionPhase 仍是 dispatching。
  const activationEvidence = {
    kind: "job-ingress-activated",
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

  const semanticRequest = { invocationId: fixture.invocation.id, fixture: "job-ingress" };
  const semanticRequestDigest = protocolDigest(semanticRequest);
  const remoteSessionRef = `runtime-session:${acquired.session.id}`;
  const remoteExecutionRef = `runtime-execution:${fixture.invocation.id}`;
  const capabilitiesDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    runtimeCapabilitiesJson: JOB_INGRESS_CAPABILITIES,
  });
  await applyRuntimeSessionDispatchForTest(fixture.tenantId, acquired.session.id, {
    bindingState: "dispatching",
    semanticRequestJson: semanticRequest,
    semanticRequestDigest,
    remoteSessionRef,
    remoteExecutionRef,
    transportAcknowledgement: { capabilitiesDigest },
  });
  await ingressRuntimeEvents({
    tenantId: fixture.tenantId,
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
  return { fixture, acquired };
}

type JobIngressScenario = Awaited<ReturnType<typeof startJobRuntimeViaIngress>>;

/** 经真实 Ingress 提交本 Invocation 的终态事件（sequence=2，紧跟 execution.started）。 */
async function ingressTerminalEvent(
  scenario: JobIngressScenario,
  event: {
    type: "execution.completed" | "execution.failed" | "execution.cancelled";
    payload: Record<string, unknown>;
  },
) {
  return ingressRuntimeEvents({
    tenantId: scenario.fixture.tenantId,
    invocationId: scenario.fixture.invocation.id,
    batch: {
      protocolVersion: 3,
      authority: scenario.acquired.authority,
      events: [
        {
          eventId: randomUUID(),
          producerSequence: "2",
          type: event.type,
          schemaVersion: 1,
          payload: event.payload,
        },
      ],
    },
  });
}

/** 回读该 Job 的 `execution_terminal` 命令（终态桥的唯一持久产物）。 */
async function readTerminalCommand(jobId: string) {
  const [command] = await db
    .select()
    .from(jobCommandTable)
    .where(
      and(
        eq(jobCommandTable.tenantId, TENANT_ID),
        eq(jobCommandTable.jobId, jobId),
        eq(jobCommandTable.commandType, "execution_terminal"),
      ),
    );
  if (!command) throw new Error("execution_terminal 命令未生成");
  return command;
}

/**
 * 「同事务可恢复」的判据。
 *
 * R06 §3：命令只记录**最终提交**的 Invocation version。消费者在消费时会按同一组规则
 * 重新比对 payloadHash 与 Invocation 的 state/version/refs；这里先按同一组规则断言，
 * 证明崩溃后的接管者能原样恢复，而不是靠"再读一次当前状态"补齐。
 */
async function assertTerminalCommandRecoverable(jobId: string, invocationId: string) {
  const command = await readTerminalCommand(jobId);
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  if (!invocation) throw new Error("Invocation 不存在");
  const payload = command.payloadJson as Record<string, unknown>;
  expect(command.commandState).toBe("queued");
  expect(command.payloadHash).toBe(protocolDigest(payload));
  expect(payload.invocationId).toBe(invocation.id);
  expect(payload.terminalState).toBe(invocation.executionState);
  expect(payload.terminalVersion).toBe(invocation.versionNo);
  expect(payload.resultRef).toBe(invocation.resultRef);
  expect(payload.resultDigest).toBe(invocation.resultDigest);
  expect(payload.errorCode).toBe(invocation.errorCode);
  return command;
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

  it("JOB-REG-01: a pure Job executes Initial→terminal→Job complete without any Thread or Turn", async () => {
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

  it("JOB-REG-13: 无 Thread Job 接纳后由持久消费者创建首次 Attempt 和 Session", async () => {
    const fixture = await seedJobFixture({ inputJson: { task: "run from job admission" } });
    expect(
      await db
        .select()
        .from(executionOwnershipTable)
        .where(eq(executionOwnershipTable.invocationId, fixture.invocation.id)),
    ).toEqual([]);
    expect(await getRuntimeSessionBindingsByInvocation(TENANT_ID, fixture.invocation.id)).toEqual(
      [],
    );
    const due = new Date(Date.now() + DISPATCH_STUCK_GRACE_MS + 1_000);
    const candidates = await scanUndispatchedInvocations({ now: due, limit: 10 });
    expect(candidates.map((candidate) => candidate.invocationId)).toContain(fixture.invocation.id);

    let observedOwnerBeforeUserTask: string | null = null;
    const service = createConfiguredHostedRuntimeApplicationService({
      ...createDirectResponsePorts(async () => {
        const owners = await db
          .select()
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.invocationId, fixture.invocation.id),
              eq(executionOwnershipTable.ownershipState, "active"),
            ),
          );
        const sessions = await getRuntimeSessionBindingsByInvocation(
          TENANT_ID,
          fixture.invocation.id,
        );
        expect(owners).toHaveLength(1);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.ownershipId).toBe(owners[0]?.id);
        observedOwnerBeforeUserTask = owners[0]?.id ?? null;
        return "job consumer completed";
      }),
      modelRef: "test-managed-model",
    });
    const summary = await runDueUndispatchedIntentRecoveries({
      now: due,
      dependencies: { hostedApplicationService: service },
    });
    expect(summary.invocations.recovered).toBe(1);
    const attempts = await db
      .select()
      .from(invocationAttemptTable)
      .where(eq(invocationAttemptTable.invocationId, fixture.invocation.id));
    expect(attempts).toHaveLength(1);
    const sessions = await getRuntimeSessionBindingsByInvocation(TENANT_ID, fixture.invocation.id);
    expect(sessions).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (
            await db
              .select({ state: invocationTable.executionState })
              .from(invocationTable)
              .where(eq(invocationTable.id, fixture.invocation.id))
              .limit(1)
          )[0]?.state,
        { interval: 50, timeout: 10_000 },
      )
      .toBe("completed");
    expect(observedOwnerBeforeUserTask).not.toBeNull();
    const worker = createProductionWorkerRole("job-worker");
    await worker.pollOnce();
    expect((await getJobById(TENANT_ID, fixture.job.id))?.jobState).toBe("completed");
  });

  it("JOB-01: 未接纳的纯 Job 经正式双 Worker 链初次执行并完成", async () => {
    await seedJobRuntimeAuthority();
    const ownerId = await ensureDefaultTenantOwner();
    const { job } = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey: `creation:${randomUUID()}`,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputJson: { task: "complete the initial Job dispatch" },
      createdBy: ownerId,
    });
    expect(job.threadId).toBeNull();
    expect(
      await db.select().from(invocationTable).where(eq(invocationTable.jobId, job.id)),
    ).toEqual([]);

    // 正式 Job Worker 从持久 queued Job 建立唯一 Invocation/Binding。
    const jobWorker = createProductionWorkerRole("job-worker");
    const admission = await jobWorker.pollOnce();
    expect(admission).toMatchObject({ admittedJobs: 1 });
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.jobId, job.id)));
    expect(invocation?.subjectType).toBe("job");
    expect(invocation?.threadId).toBeNull();
    expect(invocation?.turnId).toBeNull();
    expect(invocation?.inputDigest).toBe(job.inputHash);
    const binding = await getExecutionBindingByInvocation(TENANT_ID, invocation!.id);
    expect(binding).not.toBeNull();

    const context = await resolveContextHandle(
      await issueContextHandle({ tenantId: TENANT_ID, invocationId: invocation!.id }),
      { tenantId: TENANT_ID, invocationId: invocation!.id },
    );
    expect(context.subject).toMatchObject({ type: "job", jobId: job.id, inputHash: job.inputHash });

    // 正式持久初次调度 lane 从 queued Invocation 建立 Attempt/Owner/Session 并执行 Hosted Runtime。
    const due = new Date(Date.now() + DISPATCH_STUCK_GRACE_MS + 1_000);
    const service = createConfiguredHostedRuntimeApplicationService({
      ...createDirectResponsePorts(() => "initial Job dispatch completed"),
      modelRef: "test-managed-model",
    });
    const dispatched = await runDueUndispatchedIntentRecoveries({
      now: due,
      dependencies: { hostedApplicationService: service },
    });
    expect(dispatched.invocations.recovered).toBe(1);
    await expect
      .poll(
        async () =>
          (
            await db
              .select({ state: invocationTable.executionState })
              .from(invocationTable)
              .where(eq(invocationTable.id, invocation!.id))
              .limit(1)
          )[0]?.state,
        { interval: 50, timeout: 10_000 },
      )
      .toBe("completed");
    expect(
      await db
        .select()
        .from(invocationAttemptTable)
        .where(eq(invocationAttemptTable.invocationId, invocation!.id)),
    ).toHaveLength(1);
    expect(await getRuntimeSessionBindingsByInvocation(TENANT_ID, invocation!.id)).toHaveLength(1);
    const terminal = await jobWorker.pollOnce();
    expect(terminal).toMatchObject({ commandsConsumed: 1 });
    expect((await getJobById(TENANT_ID, job.id))?.jobState).toBe("completed");
    expect(await db.select().from(threadTable).where(eq(threadTable.tenantId, TENANT_ID))).toEqual(
      [],
    );
    expect(await db.select().from(turnTable)).toEqual([]);
  });

  it("JOB-REG-02: two racing scheduler deliveries return the identical frozen Invocation and Binding", async () => {
    const fixture = await seedJobFixture();
    const { job } = fixture;
    // 两条 lane 并发接纳同一 Job：Job 根锁序列化，只能有一条建图。
    const [firstResult, secondResult] = await Promise.all([
      admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id }),
      admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id }),
    ]);
    expect(firstResult.outcome).toBe("admitted");
    expect(secondResult.outcome).toBe("admitted");
    if (firstResult.outcome !== "admitted" || secondResult.outcome !== "admitted") return;
    expect(firstResult.invocationId).toBe(fixture.invocation.id);
    expect(secondResult.invocationId).toBe(fixture.invocation.id);
    // seedJobFixture 已接纳过一次，重复投递是幂等重放：created=false，ID 不变。
    expect(firstResult.created).toBe(false);
    expect(secondResult.created).toBe(false);
    const invocations = await db
      .select()
      .from(invocationTable)
      .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.jobId, job.id)));
    expect(invocations).toHaveLength(1);
    const bindings = await db
      .select()
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, fixture.invocation.id));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.configHash).toBe(fixture.binding.configHash);
  });

  it("ENV-11: 正式 Binding Authority 拒绝无平台环境搭配平台 Workspace", async () => {
    await seedJobRuntimeAuthority();
    const ownerId = await ensureDefaultTenantOwner();
    const logical = await createWorkspace({
      tenantId: TENANT_ID,
      workspaceKey: `env11-${randomUUID()}`,
      displayName: "ENV-11 managed workspace",
    });
    const managed = await createWorkspaceBinding({
      tenantId: TENANT_ID,
      workspaceId: logical.id,
      continuityMode: "SHARED_DURABLE",
      bindingType: "cloud",
      locationRef: `managed://env11-${randomUUID()}`,
      storageScopeDigest: protocolDigest({ scope: "env11" }),
      backendKind: "managed_host",
      hostIdentity: "env11-host",
      storageIdentity: "env11-storage",
      accessMode: "read_write",
      contractDigest: protocolDigest({ contract: "env11" }),
      createdBy: ownerId,
    });
    const { job } = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey: `creation:${randomUUID()}`,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputJson: { task: "reject mismatched environment and workspace" },
      createdBy: ownerId,
    });
    const resolved = await resolveJobBindingCommand({ tenantId: TENANT_ID, job, thread: null });
    if (!resolved.resolved) throw new Error("正式 Binding 候选未解析");
    expect(resolved.binding.environmentMode).toBe("NO_PLATFORM_ENVIRONMENT");
    await expect(
      createJobInvocation({
        tenantId: TENANT_ID,
        jobId: job.id,
        binding: { ...resolved.binding, workspaceBindingId: managed.id },
        capabilityCatalog: resolved.capabilityCatalog,
      }),
    ).rejects.toThrow("EnvironmentWorkspaceMismatch");
    expect(
      await db.select().from(invocationTable).where(eq(invocationTable.jobId, job.id)),
    ).toEqual([]);
  });

  it("JOB-REG-03: the same creationKey with a different input hash conflicts and never overwrites the input", async () => {
    await createJob({
      tenantId: TENANT_ID,
      agentId: randomUUID(),
      jobType: "batch",
      triggerRef: "trigger:duplicate",
      creationKey: "creation:duplicate",
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputJson: { task: "original" },
    });
    await expect(
      createJob({
        tenantId: TENANT_ID,
        agentId: randomUUID(),
        jobType: "batch",
        triggerRef: "trigger:duplicate",
        creationKey: "creation:duplicate",
        completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
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

  it("JOB-REG-04: a resolved input digest that diverges from the frozen input is rejected before runtime start", async () => {
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
        sourceOperationKey: `invocation:${fixture.invocation.id}`,
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

  it("JOB-REG-05: a transport retry of the same start intent keeps Invocation, Attempt, Ownership and StartKey identical", async () => {
    const { RuntimeStartTransportError, startRuntimeInvocation } = await import(
      "@/lib/runtime/application/runtime-start"
    );
    const runtimeAuthority = await seedJobRuntimeAuthority();
    const fixture = await seedJobFixture({ runtime: runtimeAuthority });
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
    const publishedDigest = computeCapabilityManifestDigest({
      runtimeRevisionId: runtimeAuthority.runtimeRevisionId,
      runtimeCapabilities: runtimeAuthority.capabilities,
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
      // A05：投递重试仍是**同一个**来源意图。
      sourceOperationKey: `invocation:${fixture.invocation.id}`,
      invocation: fixture.invocation,
      attempt,
      binding: fixture.binding,
      runtimeClient: client,
      runtimeEndpoint: "http://127.0.0.1/stub",
      auth: { mode: "none" } as const,
      callbackEndpoints,
    };
    let firstFailure: InstanceType<typeof RuntimeStartTransportError> | null = null;
    try {
      await startRuntimeInvocation(startInput);
    } catch (error) {
      expect(error).toMatchObject({
        name: "RuntimeStartTransportError",
        originalError: expect.any(RuntimeHttpClientError),
        dispatchIdentity: expect.objectContaining({ attemptId: attempt.id }),
      } satisfies Partial<InstanceType<typeof RuntimeStartTransportError>>);
      firstFailure = error as InstanceType<typeof RuntimeStartTransportError>;
    }
    if (!firstFailure) throw new Error("预期首轮 Transport 回执丢失");
    const retry = await startRuntimeInvocation({
      ...startInput,
      sessionDispatchClaim: firstFailure.dispatchIdentity,
    });
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

  it("JOB-05: 真实 HTTP 503 后重投复用 Job 执行身份与 StartKey", async () => {
    const { RuntimeStartTransportError, startRuntimeInvocation } = await import(
      "@/lib/runtime/application/runtime-start"
    );
    const runtime = await seedJobRuntimeAuthority();
    const fixture = await seedJobFixture({ runtime });
    const attempt = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    const { computeCapabilityManifestDigest } = await import(
      "@/lib/routes/domain/route-resolution-policy"
    );
    const publishedDigest = computeCapabilityManifestDigest({
      runtimeRevisionId: runtime.runtimeRevisionId,
      runtimeCapabilities: runtime.capabilities,
    });
    const requests: Array<{ key: string; body: RuntimeStartRequest }> = [];
    let accepted: RuntimeStartResponse | null = null;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = RuntimeStartRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
        requests.push({ key: String(request.headers["idempotency-key"]), body });
        response.setHeader("content-type", "application/json");
        if (requests.length === 1) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: { code: "RUNTIME_UNAVAILABLE", message: "busy" } }));
          return;
        }
        accepted ??= startResponseStub({ request: body }, publishedDigest);
        response.writeHead(202);
        response.end(JSON.stringify(accepted));
      })().catch((error) => {
        response.writeHead(500);
        response.end(
          JSON.stringify({ error: { code: "TEST_SERVER_ERROR", message: String(error) } }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    try {
      const startInput = {
        tenantId: TENANT_ID,
        sourceOperationKey: `invocation:${fixture.invocation.id}`,
        invocation: fixture.invocation,
        attempt,
        binding: fixture.binding,
        runtimeClient: createHttpRuntimeClient(),
        runtimeEndpoint: `http://127.0.0.1:${address.port}`,
        auth: { mode: "none" } as const,
        callbackEndpoints,
      };
      let claim: InstanceType<typeof RuntimeStartTransportError>["dispatchIdentity"] | null = null;
      try {
        await startRuntimeInvocation(startInput);
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeStartTransportError);
        expect(
          (error as InstanceType<typeof RuntimeStartTransportError>).originalError,
        ).toMatchObject({ kind: "http", httpStatus: 503, retryable: true });
        claim = (error as InstanceType<typeof RuntimeStartTransportError>).dispatchIdentity;
      }
      if (!claim) throw new Error("预期首次真实 HTTP 503");
      const retried = await startRuntimeInvocation({ ...startInput, sessionDispatchClaim: claim });
      expect(retried.response.accepted).toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[0]?.key).toBe(requests[1]?.key);
      expect(requests[0]?.body.semanticRequestDigest).toBe(requests[1]?.body.semanticRequestDigest);
      expect(requests[0]?.key).toBe(`start:${retried.authority.ownershipId}`);
      expect(retried.authority.attemptId).toBe(attempt.id);
      const sessions = await getRuntimeSessionBindingsByInvocation(
        TENANT_ID,
        fixture.invocation.id,
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(retried.sessionBindingId);
      expect(sessions[0]?.ownershipId).toBe(retried.authority.ownershipId);
      expect(
        await db
          .select()
          .from(invocationAttemptTable)
          .where(eq(invocationAttemptTable.invocationId, fixture.invocation.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(executionOwnershipTable)
          .where(eq(executionOwnershipTable.invocationId, fixture.invocation.id)),
      ).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("JOB-REG-06: redispatch keeps Job, Invocation and Binding frozen while creating a new Attempt and Owner", async () => {
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

  it("JOB-06: 原实例执行权过期后同 Job 重调度建立新 Attempt 与 Owner", async () => {
    const runtime = await seedJobRuntimeAuthority();
    const fixture = await seedJobFixture({ runtime });
    const { computeCapabilityManifestDigest } = await import(
      "@/lib/routes/domain/route-resolution-policy"
    );
    const capabilityDigest = computeCapabilityManifestDigest({
      runtimeRevisionId: runtime.runtimeRevisionId,
      runtimeCapabilities: runtime.capabilities,
    });
    const client = createMockRuntimeClient({
      startInvocation: async (request) => startResponseStub(request, capabilityDigest),
    });
    const attempt1 = await createAttempt({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    const first = await startRuntimeInvocation({
      tenantId: TENANT_ID,
      sourceOperationKey: `invocation:${fixture.invocation.id}`,
      invocation: fixture.invocation,
      attempt: attempt1,
      binding: fixture.binding,
      runtimeClient: client,
      runtimeEndpoint: "http://127.0.0.1/stub",
      auth: { mode: "none" },
      callbackEndpoints,
    });
    const [firstOwner] = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.id, first.authority.ownershipId));
    if (!firstOwner) throw new Error("首次执行权未持久化");
    await db
      .update(executionOwnershipTable)
      .set({
        leaseExpiresAt: new Date(firstOwner.acquiredAt.getTime() + 1),
        lastHeartbeatAt: firstOwner.acquiredAt,
      })
      .where(eq(executionOwnershipTable.id, first.authority.ownershipId));

    const second = await redispatchRuntimeInvocation({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      retryReasonCode: "instance_lost",
      runtimeClient: client,
      runtimeEndpoint: "http://127.0.0.1/stub",
      auth: { mode: "none" },
      callbackEndpoints,
    });
    expect(second.redispatched).toBe(true);
    expect(second.attempt.id).not.toBe(attempt1.id);
    expect(second.attempt.attemptNo).toBe(attempt1.attemptNo + 1);
    const owners = await db
      .select()
      .from(executionOwnershipTable)
      .where(eq(executionOwnershipTable.invocationId, fixture.invocation.id));
    expect(owners).toHaveLength(2);
    expect(owners.find((row) => row.id === first.authority.ownershipId)?.ownershipState).toBe(
      "lost",
    );
    const nextOwner = owners.find((row) => row.attemptId === second.attempt.id);
    expect(nextOwner?.ownershipState).toBe("active");
    expect(nextOwner?.leaseEpoch).toBeGreaterThan(BigInt(first.authority.leaseEpoch));
    expect(client.calls.startInvocation.map((request) => request.idempotencyKey)).toEqual([
      `start:${first.authority.ownershipId}`,
      `start:${nextOwner?.id}`,
    ]);
    expect(
      await db.select().from(invocationTable).where(eq(invocationTable.jobId, fixture.job.id)),
    ).toHaveLength(1);
    const [frozenBinding] = await db
      .select()
      .from(executionBindingTable)
      .where(eq(executionBindingTable.invocationId, fixture.invocation.id));
    expect(frozenBinding?.invocationId).toBe(fixture.invocation.id);
    expect(frozenBinding?.configHash).toBe(fixture.binding.configHash);
    expect((await getJobById(TENANT_ID, fixture.job.id))?.id).toBe(fixture.job.id);
  });

  it("JOB-REG-07: terminal and Job bridge are one transaction — a crash rolls both back", async () => {
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

  it("JOB-REG-08: a durable terminal command survives consumer restart; replay does not duplicate", async () => {
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

  it("JOB-08: 消费事务写入 Job/Event 后进程崩溃，新 Worker 重启只完成一次", async () => {
    const fixture = await seedJobFixture();
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/crash",
        resultDigest: protocolDigest({ result: "crash-recovery" }),
      }),
    );
    const command = await readTerminalCommand(fixture.job.id);
    const gate = `t02_j08_gate_${randomUUID().slice(0, 12)}`;
    const marker = `t02_j08_mark_${randomUUID().slice(0, 12)}`;
    const trigger = "topic02_job08_ack_gate";
    const control = await openMigrationConnection();
    let child: ReturnType<typeof spawnJobConsumerCrashProcess> | null = null;
    try {
      await control.query("SELECT GET_LOCK(?, 0)", [gate]);
      // Job 状态与 Event 已在本事务内写完；Ack 的 Trigger 挡在提交前。
      await db.execute(
        sql.raw(
          `CREATE TRIGGER ${trigger} BEFORE UPDATE ON JobCommand FOR EACH ROW BEGIN IF NEW.commandState = 'acknowledged' THEN DO GET_LOCK('${marker}', 30); DO GET_LOCK('${gate}', 30); DO RELEASE_LOCK('${gate}'); DO RELEASE_LOCK('${marker}'); END IF; END`,
        ),
      );
      child = spawnJobConsumerCrashProcess(TENANT_ID, command.id);
      let reachedAck = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [rows] = await control.query("SELECT IS_USED_LOCK(?) AS owner", [marker]);
        if ((rows as unknown as Array<{ owner: number | null }>)[0]?.owner != null) {
          reachedAck = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reachedAck).toBe(true);
      // 另一连接只能看到事务前事实，不能看到一半的 Job 或 Event。
      expect((await getJobById(TENANT_ID, fixture.job.id))?.jobState).toBe("queued");
      expect(await countJobCompletedEvents(fixture.job.id)).toBe(0);
      const [beforeCrashCommand] = await db
        .select()
        .from(jobCommandTable)
        .where(eq(jobCommandTable.id, command.id));
      expect(beforeCrashCommand?.commandState).toBe("queued");

      child.kill();
      await control.query("SELECT RELEASE_LOCK(?)", [gate]);
      const exit = await child.exited;
      expect(exit.signal).toBe("SIGKILL");
      await expect
        .poll(async () => (await getJobById(TENANT_ID, fixture.job.id))?.jobState, {
          interval: 50,
          timeout: 5_000,
        })
        .toBe("queued");
      expect(await countJobCompletedEvents(fixture.job.id)).toBe(0);
      const [rolledBackCommand] = await db
        .select()
        .from(jobCommandTable)
        .where(eq(jobCommandTable.id, command.id));
      expect(rolledBackCommand?.commandState).toBe("queued");
    } finally {
      child?.kill();
      await control.query("SELECT RELEASE_LOCK(?)", [gate]);
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger}`));
      control.release();
    }

    const restarted = createProductionWorkerRole("job-worker");
    expect(await restarted.pollOnce()).toMatchObject({ commandsConsumed: 1 });
    const completed = await getJobById(TENANT_ID, fixture.job.id);
    expect(completed?.jobState).toBe("completed");
    expect(completed?.resultRef).toBe("job://result/crash");
    expect(await countJobCompletedEvents(fixture.job.id)).toBe(1);
    const [acknowledged] = await db
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, command.id));
    expect(acknowledged?.commandState).toBe("acknowledged");
    expect(await restarted.pollOnce()).toMatchObject({ commandsConsumed: 0 });
    expect(await countJobCompletedEvents(fixture.job.id)).toBe(1);
  }, 30_000);

  it("JOB-REG-09: an unresolved effect moves the Job to waiting_external with a durable retry timestamp", async () => {
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

  it("JOB-REG-10: a duplicate retry request creates exactly one replacement and never reopens the original Job", async () => {
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

  it("JOB-REG-11: a cancel racing a completion converges on the Job authority without overwriting the terminal state", async () => {
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

  it("JOB-11: 取消与完成命令并发消费只产生一个终态", async () => {
    const fixture = await seedJobFixture();
    const cancel = await createCancelCommand({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      requestedBy: "user",
      idempotencyKey: `cancel:${randomUUID()}`,
    });
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/race",
        resultDigest: protocolDigest({ result: "race" }),
      }),
    );
    const terminal = await readTerminalCommand(fixture.job.id);
    const [cancelOutcome, completionOutcome] = await Promise.all([
      consumeJobCommand({ tenantId: TENANT_ID, commandId: cancel.command.id }),
      consumeJobCommand({ tenantId: TENANT_ID, commandId: terminal.id }),
    ]);
    expect(["cancelled", "rejected_job_terminal"]).toContain(cancelOutcome.outcome);
    expect(["terminal_applied", "terminal_replayed"]).toContain(completionOutcome.outcome);

    const finalJob = await getJobById(TENANT_ID, fixture.job.id);
    expect(["cancelled", "completed"]).toContain(finalJob?.jobState);
    const terminalEvents = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.tenantId, TENANT_ID),
          eq(jobEventTable.jobId, fixture.job.id),
          inArray(jobEventTable.eventType, ["job.cancelled", "job.completed"]),
        ),
      );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.eventType).toBe(`job.${finalJob?.jobState}`);
    const [cancelCommand, terminalCommand] = await Promise.all([
      db.select().from(jobCommandTable).where(eq(jobCommandTable.id, cancel.command.id)).limit(1),
      db.select().from(jobCommandTable).where(eq(jobCommandTable.id, terminal.id)).limit(1),
    ]);
    expect(["acknowledged", "rejected"]).toContain(cancelCommand[0]?.commandState);
    expect(terminalCommand[0]?.commandState).toBe("acknowledged");
    if (finalJob?.jobState === "completed") {
      expect(finalJob.resultRef).toBe("job://result/race");
    } else {
      expect(finalJob?.resultRef).toBeNull();
    }
  });

  it("JOB-REG-12: ContextHandle subjects are strictly isolated between Job and Thread", async () => {
    const { issueContextHandle, resolveContextHandle } = await import(
      "@/lib/context/context-handle"
    );
    const fixture = await seedJobFixture();
    // Job Handle：subject.type=job，携带 jobId / inputHash，不携带 Thread 字段。
    const jobToken = await issueContextHandle({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
    const jobHandle = await resolveContextHandle(jobToken, {
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
    });
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
    const threadToken = await issueContextHandle({
      tenantId: TENANT_ID,
      invocationId: threadInvocationId,
    });
    const threadHandle = await resolveContextHandle(threadToken, {
      tenantId: TENANT_ID,
      invocationId: threadInvocationId,
    });
    expect(threadHandle.subject.type).toBe("thread");
    if (threadHandle.subject.type === "thread") {
      expect(threadHandle.subject.threadId).toBe(threadId);
      expect("jobId" in threadHandle.subject).toBe(false);
    }

    // 这两枚凭据的签名均有效；正式读取仍必须按判别分支严格拒绝混入字段。
    await expect(
      resolveContextHandle(signedContextWithExtraSubjectField(jobToken, "threadId", threadId), {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      resolveContextHandle(
        signedContextWithExtraSubjectField(threadToken, "jobId", fixture.job.id),
        { tenantId: TENANT_ID, invocationId: threadInvocationId },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("JOB-02: Runtime Event Batch 含 completed 后，真实 Job 消费者按最后提交的 Invocation 版本收口", async () => {
    const scenario = await startJobRuntimeViaIngress();
    const resultRef = "artifact://job-02/result";
    const resultDigest = protocolDigest({ result: "job-02" });
    await ingressTerminalEvent(scenario, {
      type: "execution.completed",
      payload: { resultRef, resultDigest },
    });

    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, scenario.fixture.invocation.id))
      .limit(1);
    expect(invocation?.executionState).toBe("completed");

    // 桥接发生在终态提交的**同一条**版本上：命令持久化时即已对齐最后提交的 versionNo。
    const pending = await assertTerminalCommandRecoverable(
      scenario.fixture.job.id,
      scenario.fixture.invocation.id,
    );

    // 真实 Job 消费者（生产角色）处理同一条命令。
    const worker = createProductionWorkerRole("job-worker");
    const tick = (await worker.pollOnce()) as { commandsConsumed: number };
    expect(tick.commandsConsumed).toBeGreaterThanOrEqual(1);

    const consumed = await readTerminalCommand(scenario.fixture.job.id);
    expect(consumed.id).toBe(pending.id);
    expect(consumed.commandState).toBe("acknowledged");
    // 严格版本比较通过：既没有被判 InputDigestMismatch，也没有留下 lease。
    expect(consumed.lastErrorCode).toBeNull();
    expect(consumed.leaseOwner).toBeNull();
    expect(consumed.completedAt).not.toBeNull();

    const job = await getJobById(TENANT_ID, scenario.fixture.job.id);
    expect(job?.jobState).toBe("completed");
    expect(job?.resultRef).toBe(resultRef);
    expect(job?.resultHash).toBe(resultDigest);
  });

  it("JOB-03: Runtime failed / cancelled 与平台 lost 三种终态来源各自留下同事务可恢复的命令并按领域收口", async () => {
    // ── A. Runtime failed（真实 Ingress）──
    const failed = await startJobRuntimeViaIngress();
    const runtimeAuthority = { runtimeRevisionId: failed.fixture.binding.runtimeRevisionId };
    await ingressTerminalEvent(failed, {
      type: "execution.failed",
      payload: { errorCode: "runtime_failed", errorSummary: "runtime reported failure" },
    });
    const [failedInvocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, failed.fixture.invocation.id))
      .limit(1);
    expect(failedInvocation?.executionState).toBe("failed");
    const failedCommand = await assertTerminalCommandRecoverable(
      failed.fixture.job.id,
      failed.fixture.invocation.id,
    );
    const failedDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: failedCommand.id,
    });
    expect(failedDecision.outcome).toBe("terminal_applied");
    expect(failedDecision.job.jobState).toBe("failed");
    expect(failedDecision.job.errorCode).toBe("RootInvocationFailed");

    // ── B. Runtime cancelled（真实 Ingress）──
    const cancelled = await startJobRuntimeViaIngress({ reuseRuntimeAuthority: runtimeAuthority });
    await ingressTerminalEvent(cancelled, {
      type: "execution.cancelled",
      payload: { errorCode: "runtime_cancelled" },
    });
    const cancelledCommand = await assertTerminalCommandRecoverable(
      cancelled.fixture.job.id,
      cancelled.fixture.invocation.id,
    );
    const cancelledDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: cancelledCommand.id,
    });
    expect(cancelledDecision.outcome).toBe("terminal_applied");
    expect(cancelledDecision.job.jobState).toBe("cancelled");
    const cancelledJob = await getJobById(TENANT_ID, cancelled.fixture.job.id);
    expect(cancelledJob?.jobState).toBe("cancelled");

    // ── C. 平台不可恢复 lost：没有 Runtime 事件，只有平台侧判定 ──
    const lost = await startJobRuntimeViaIngress({ reuseRuntimeAuthority: runtimeAuthority });
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: lost.fixture.invocation.id,
        nextState: "lost",
        errorCode: "platform_lost",
        errorSummary: "runtime instance unrecoverable",
      }),
    );
    const lostCommand = await assertTerminalCommandRecoverable(
      lost.fixture.job.id,
      lost.fixture.invocation.id,
    );
    const lostDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: lostCommand.id,
    });
    expect(lostDecision.outcome).toBe("terminal_applied");
    expect(lostDecision.job.jobState).toBe("failed");
    expect(lostDecision.job.errorCode).toBe("RootInvocationFailed");
  });

  it("JOB-04: 终态提交后、消费者执行前 Worker 被终止并重启，持久命令由重启后的 Worker 自动消费", async () => {
    const scenario = await startJobRuntimeViaIngress();
    await ingressTerminalEvent(scenario, {
      type: "execution.completed",
      payload: {
        resultRef: "artifact://job-04/result",
        resultDigest: protocolDigest({ result: "job-04" }),
      },
    });
    const durable = await readTerminalCommand(scenario.fixture.job.id);
    expect(durable.commandState).toBe("queued");

    // 消费者进程在领取之前被终止：只创建、随即 stop，不曾 pollOnce。
    const terminated = createProductionWorkerRole("job-worker");
    terminated.stop();

    // 命令事实仍在库里，重启后的 Worker 自行发现并消费。
    const beforeRestart = await readTerminalCommand(scenario.fixture.job.id);
    expect(beforeRestart.commandState).toBe("queued");
    expect(beforeRestart.deliveryCount).toBe(0);

    const restarted = createProductionWorkerRole("job-worker");
    const tick = (await restarted.pollOnce()) as { commandsConsumed: number };
    expect(tick.commandsConsumed).toBeGreaterThanOrEqual(1);

    // 本用例**不**调用任何消费函数：收口完全由重启后的 Worker 自动完成。
    const consumed = await readTerminalCommand(scenario.fixture.job.id);
    expect(consumed.commandState).toBe("acknowledged");
    expect(consumed.completedAt).not.toBeNull();
    const job = await getJobById(TENANT_ID, scenario.fixture.job.id);
    expect(job?.jobState).toBe("completed");
    expect(job?.resultRef).toBe("artifact://job-04/result");
  });

  it("JOB-05: Job 已 terminal 时迟到/重复的终态命令被幂等确认，不永久留 queued/waiting", async () => {
    const scenario = await startJobRuntimeViaIngress();
    // 平台 lost 先让顶层 Invocation 终态并留下**待处理**的终态命令。
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: scenario.fixture.invocation.id,
        nextState: "lost",
        errorCode: "platform_lost",
        errorSummary: "runtime instance unrecoverable",
      }),
    );
    const pendingTerminal = await readTerminalCommand(scenario.fixture.job.id);
    expect(pendingTerminal.commandState).toBe("queued");

    // Job 先被正式 cancel 命令收口为终态，此时终态命令仍未被消费。
    const cancel = await createCancelCommand({
      tenantId: TENANT_ID,
      jobId: scenario.fixture.job.id,
      requestedBy: "scheduler",
      idempotencyKey: "cancel:job-05",
    });
    const cancelled = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: cancel.command.id,
    });
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.job.jobState).toBe("cancelled");

    // 「其他」待处理终态命令：Job 已 terminal，命令仍必须被幂等 acknowledgement 落定。
    const worker = createProductionWorkerRole("job-worker");
    const firstTick = (await worker.pollOnce()) as {
      commandsScanned: number;
      commandsConsumed: number;
    };
    expect(firstTick.commandsScanned).toBeGreaterThanOrEqual(1);
    expect(firstTick.commandsConsumed).toBeGreaterThanOrEqual(1);

    const acknowledged = await readTerminalCommand(scenario.fixture.job.id);
    expect(acknowledged.commandState).toBe("acknowledged");
    expect(acknowledged.completedAt).not.toBeNull();
    expect(acknowledged.lastErrorCode).toBeNull();
    expect(acknowledged.leaseOwner).toBeNull();
    expect((acknowledged.resultJson as Record<string, unknown>).replayedAgainstTerminalJob).toBe(
      true,
    );

    // 「同」一命令重复投递：不再进入队列（scan 不再发现它），Job 仍保持 terminal。
    const secondTick = (await worker.pollOnce()) as { commandsScanned: number };
    expect(secondTick.commandsScanned).toBe(0);
    const stable = await readTerminalCommand(scenario.fixture.job.id);
    expect(stable.commandState).toBe("acknowledged");
    expect(stable.versionNo).toBe(acknowledged.versionNo);
    const job = await getJobById(TENANT_ID, scenario.fixture.job.id);
    expect(job?.jobState).toBe("cancelled");
    expect(await countJobCompletedEvents(scenario.fixture.job.id)).toBe(0);
  });

  it("JOB-06: 两个 Scheduler 并发首次创建同一 Job 的执行意图，只建立一个 Invocation 与严格校验的 Binding", async () => {
    const runtimeAuthority = await seedJobRuntimeAuthority();
    const ownerId = await ensureDefaultTenantOwner();
    // 尚未接纳的 queued Job：本用例考的是「首次建立」，不是「已建立后的重复读取」。
    const { job } = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey: `creation:${randomUUID()}`,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputJson: { task: "job-06-first-admission" },
      createdBy: ownerId,
    });
    expect(
      await db
        .select({ id: invocationTable.id })
        .from(invocationTable)
        .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.jobId, job.id))),
    ).toEqual([]);

    // 两条调度 lane 并发投递**第一次**接纳意图。
    const outcomes = await Promise.all([
      admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id }),
      admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id }),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "admitted")).toBe(true);
    const admitted = outcomes.flatMap((outcome) =>
      outcome.outcome === "admitted" ? [outcome] : [],
    );
    expect(admitted).toHaveLength(2);
    const invocationIds = new Set(admitted.map((outcome) => outcome.invocationId));
    expect(invocationIds.size).toBe(1);
    // 恰好一条真正建立了执行意图；另一条只能返回已冻结关联。
    expect(admitted.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(admitted.filter((outcome) => !outcome.created)).toHaveLength(1);

    const invocationId = [...invocationIds][0]!;
    const invocations = await db
      .select()
      .from(invocationTable)
      .where(and(eq(invocationTable.tenantId, TENANT_ID), eq(invocationTable.jobId, job.id)));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.inputDigest).toBe(job.inputHash);
    expect(invocations[0]?.subjectType).toBe("job");

    // Binding 由严格 Authority 产生：冻结证据必须真实非空，不是被直接 INSERT 的台账行。
    const bindings = await db
      .select()
      .from(executionBindingTable)
      .where(
        and(
          eq(executionBindingTable.tenantId, TENANT_ID),
          eq(executionBindingTable.invocationId, invocationId),
        ),
      );
    expect(bindings).toHaveLength(1);
    const binding = bindings[0]!;
    expect(binding.runtimeRevisionId).toBe(runtimeAuthority.runtimeRevisionId);
    expect(binding.deploymentRouteId).toBeTruthy();
    expect(binding.routeRevisionId).toBeTruthy();
    expect(binding.routeActivationId).toBeTruthy();
    expect(binding.runtimePublicationRecordId).toBeTruthy();
    expect(binding.conformanceRunId).toBeTruthy();
    expect(binding.policyRevisionId).toBeTruthy();
    expect(binding.governanceConfigRevisionId).toBeTruthy();
    for (const digest of [
      binding.policyRulesDigest,
      binding.governanceConfigDigest,
      binding.routeContentDigest,
      binding.resolutionInputDigest,
      binding.capabilityCatalogDigest,
      binding.configHash,
    ]) {
      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    // 无 Agent 的 Job 仍必须是可信 service principal，不能退化成匿名主体。
    expect(binding.principalType).toBe("service");
    expect(binding.principalId).toBe(job.createdBy);
    expect(binding.principalSource).toBe("trusted_service");
  });

  it("JOB-07: 同输入 Key 不同输入 Hash 稳定冲突；reference 内容被改后按冻结摘要拒绝执行", async () => {
    const ownerId = await ensureDefaultTenantOwner();
    // reference 输入的 Job 同样需要真实 Route/Runtime 权威才能被接纳。
    await seedJobRuntimeAuthority();
    const originalContent = { task: "original reference content", revision: randomUUID() };
    const { inputRef, inputHash: frozenDigest } = await storeJobInputReference({
      tenantId: TENANT_ID,
      payload: originalContent,
    });
    // reference 输入：Provider 保存内容，Job 冻结摘要，此后不得按当前内容漂移。
    const creationKey = `creation:${randomUUID()}`;
    const { job } = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputRef,
      inputHash: frozenDigest,
      createdBy: ownerId,
    });
    expect(job.inputKind).toBe("reference");
    expect(job.inputJson).toBeNull();
    expect(job.inputHash).toBe(frozenDigest);

    // ── A. 同 Key 不同 Hash：稳定冲突，绝不能覆盖已冻结输入 ──
    const changedContent = { task: "tampered reference content", revision: 2 };
    const changedDigest = computeJobInputDigest(changedContent);
    expect(changedDigest).not.toBe(frozenDigest);
    await expect(
      createJob({
        tenantId: TENANT_ID,
        agentId: null,
        jobType: "batch",
        triggerRef: `trigger:${randomUUID()}`,
        creationKey,
        completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
        inputRef,
        inputHash: changedDigest,
        createdBy: ownerId,
      }),
    ).rejects.toMatchObject({ name: "InputDigestMismatch" });
    // 同 Key 同 Hash 的重复投递是幂等重放，返回同一 Job 且输入未被改写。
    const replayed = await createJob({
      tenantId: TENANT_ID,
      agentId: null,
      jobType: "batch",
      triggerRef: `trigger:${randomUUID()}`,
      creationKey,
      completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
      inputRef,
      inputHash: frozenDigest,
      createdBy: ownerId,
    });
    expect(replayed.job.id).toBe(job.id);
    expect(replayed.job.inputHash).toBe(frozenDigest);
    const jobsWithKey = await db
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.creationKey, creationKey)));
    expect(jobsWithKey).toHaveLength(1);
    expect(jobsWithKey[0]?.inputHash).toBe(frozenDigest);

    // ── B. 实际读取 reference 时内容已被改写：按冻结摘要拒绝，不按当前可变内容执行 ──
    const admitted = await admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id });
    expect(admitted.outcome).toBe("admitted");
    if (admitted.outcome !== "admitted") return;
    const [invocation] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, admitted.invocationId))
      .limit(1);
    const binding = await getExecutionBindingByInvocation(TENANT_ID, admitted.invocationId);
    if (!invocation || !binding) throw new Error("JOB-07: 接纳后回读 Invocation/Binding 失败");
    expect(invocation.inputDigest).toBe(frozenDigest);

    const { startRuntimeInvocation } = await import("@/lib/runtime/application/runtime-start");
    const attempt = await createAttempt({ tenantId: TENANT_ID, invocationId: invocation.id });
    const root = isAbsolute(workspaceConfig.root)
      ? workspaceConfig.root
      : resolve(process.cwd(), workspaceConfig.root);
    await writeFile(
      join(root, ".snow", "job-inputs", TENANT_ID, frozenDigest.slice("sha256:".length)),
      JSON.stringify(changedContent),
    );
    await expect(
      issueContextHandle({ tenantId: TENANT_ID, invocationId: invocation.id }),
    ).rejects.toMatchObject({ code: "input_unavailable", message: "InputDigestMismatch" });
    await expect(
      startRuntimeInvocation({
        tenantId: TENANT_ID,
        sourceOperationKey: `invocation:${invocation.id}`,
        invocation,
        attempt,
        binding,
        runtimeClient: {} as RuntimeHttpClient,
        runtimeEndpoint: "http://127.0.0.1/stub",
        auth: { mode: "none" },
        callbackEndpoints,
      }),
    ).rejects.toThrow("InputDigestMismatch");

    // 拒绝后没有任何执行事实：Invocation/Job 冻结输入不变，也未建立 Session。
    const [afterReject] = await db
      .select()
      .from(invocationTable)
      .where(eq(invocationTable.id, invocation.id));
    expect(afterReject?.executionState).toBe("queued");
    expect(afterReject?.inputDigest).toBe(frozenDigest);
    const afterJob = await getJobById(TENANT_ID, job.id);
    expect(afterJob?.inputHash).toBe(frozenDigest);
    expect(afterJob?.jobState).toBe("queued");
  });

  it("JOB-09: terminal Job 重跑与原终态命令迟到并发，只创建 Replacement 并保存关联", async () => {
    const fixture = await seedJobFixture({ triggerRef: `trigger:${randomUUID()}` });
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "failed",
        errorCode: "job_failed",
        errorSummary: "job failed before retry",
      }),
    );
    const terminalCommand = await readTerminalCommand(fixture.job.id);
    const applied = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: terminalCommand.id,
    });
    expect(applied.outcome).toBe("terminal_applied");
    expect(applied.job.jobState).toBe("failed");

    const retry = await createRetryCommand({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      requestedBy: "scheduler",
      idempotencyKey: `retry:${randomUUID()}`,
    });
    expect(retry.replayed).toBe(false);

    // 「重跑」与「原命令迟到」并发到达同一 Job 权威：两条 lane 都按 Job 根锁串行化，
    // 不会有任一方越权改动对方的结论。
    const [processed, lateDelivery] = await Promise.all([
      processRetryCommand({ tenantId: TENANT_ID, commandId: retry.command.id }),
      consumeJobCommand({ tenantId: TENANT_ID, commandId: terminalCommand.id }),
    ]);
    expect(processed.outcome).toBe("retry_created");
    expect(lateDelivery.outcome).toBe("terminal_replayed");
    const replacement = processed.replacementJob;
    expect(replacement?.replacesJobId).toBe(fixture.job.id);
    if (!replacement) throw new Error("JOB-09: replacement Job 未创建");

    // 只创建一个 Replacement，且关联保存在 Command 处理结果里。
    const replacements = await db
      .select()
      .from(jobTable)
      .where(and(eq(jobTable.tenantId, TENANT_ID), eq(jobTable.replacesJobId, fixture.job.id)));
    expect(replacements).toHaveLength(1);
    expect(replacements[0]?.id).toBe(replacement.id);
    const [retryCommand] = await db
      .select()
      .from(jobCommandTable)
      .where(eq(jobCommandTable.id, retry.command.id))
      .limit(1);
    expect(retryCommand?.commandState).toBe("acknowledged");
    expect((retryCommand?.resultJson as Record<string, unknown>)?.replacementJobId).toBe(
      replacement.id,
    );

    // 旧命令不影响新 Job：新 Job 仍是全新的 queued，只有 job.queued 一条事实。
    const fresh = await getJobById(TENANT_ID, replacement.id);
    expect(fresh?.jobState).toBe("queued");
    expect(fresh?.versionNo).toBe(1);
    expect(fresh?.resultRef).toBeNull();
    const replacementEvents = await db
      .select({ eventType: jobEventTable.eventType })
      .from(jobEventTable)
      .where(and(eq(jobEventTable.tenantId, TENANT_ID), eq(jobEventTable.jobId, replacement.id)));
    expect(replacementEvents.map((event) => event.eventType)).toEqual(["job.queued"]);

    // 原 Job 事实不变：不复活、不重复收口。
    const original = await getJobById(TENANT_ID, fixture.job.id);
    expect(original?.jobState).toBe("failed");
    expect(original?.replacesJobId).toBeNull();
    const originalTerminalEvents = await db
      .select({ id: jobEventTable.id })
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.tenantId, TENANT_ID),
          eq(jobEventTable.jobId, fixture.job.id),
          eq(jobEventTable.eventType, "job.failed"),
        ),
      );
    expect(originalTerminalEvents).toHaveLength(1);
  });

  it("JOB-08: CompletionPolicy 按冻结的必需成员集合真实判定 all_success/fail_fast/threshold；Unknown 持久等待不伪成功", async () => {
    // ── A. all_success：一名成员已成功、另一名仍在运行（已接纳但无终态结果）→
    //     "顶层 Invocation completed" 不等于 Job 完成，必须等待且不得写结果 ──
    const allSuccessPending = await seedExecutingJobForPolicy(ALL_SUCCESS_COMPLETION_POLICY);
    const runtimeAuthority = {
      runtimeRevisionId: allSuccessPending.fixture.binding.runtimeRevisionId,
    };
    await completePolicyStep(allSuccessPending, "parse", "job08-a-done");
    await admitPolicyStep(allSuccessPending, "index", "job08-a-running");
    const pendingCommand = await terminateRootInvocation(allSuccessPending);
    const pendingDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: pendingCommand.id,
    });
    expect(pendingDecision.outcome).toBe("waiting_external");
    expect(pendingDecision.job.jobState).toBe("waiting_external");
    expect(pendingDecision.command.commandState).toBe("waiting");
    expect(pendingDecision.command.lastErrorCode).toBe("RequiredStepPending");
    // 持久等待必须有唤醒时间，否则命令会永久挂起。
    expect(pendingDecision.command.nextAttemptAt).not.toBeNull();
    const pendingJob = await getJobById(TENANT_ID, allSuccessPending.fixture.job.id);
    expect(pendingJob?.jobState).toBe("waiting_external");
    expect(pendingJob?.resultRef).toBeNull();
    expect(await countJobCompletedEvents(allSuccessPending.fixture.job.id)).toBe(0);

    // ── B. all_success：一名成员确定失败 → 策略已不可能满足，Job 失败 ──
    const allSuccessFailed = await seedExecutingJobForPolicy(
      ALL_SUCCESS_COMPLETION_POLICY,
      runtimeAuthority,
    );
    await completePolicyStep(allSuccessFailed, "parse", "job08-b-done");
    await failPolicyStep(allSuccessFailed, "index", "job08-b-failed");
    const failedCommand = await terminateRootInvocation(allSuccessFailed);
    const failedDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: failedCommand.id,
    });
    expect(failedDecision.outcome).toBe("terminal_applied");
    expect(failedDecision.job.jobState).toBe("failed");
    const failedJob = await getJobById(TENANT_ID, allSuccessFailed.fixture.job.id);
    expect(failedJob?.jobState).toBe("failed");
    expect(failedJob?.errorCode).toBe("RequiredStepFailed");
    expect(await countJobCompletedEvents(allSuccessFailed.fixture.job.id)).toBe(0);

    // ── C. fail_fast：已出现确定失败时立即收口，不等其余仍在运行的成员 ──
    const failFast = await seedExecutingJobForPolicy(
      {
        kind: "fail_fast",
        scope: "root_invocation_and_required_children",
        unknownEffects: UNKNOWN_EFFECT_HANDLING,
      },
      runtimeAuthority,
    );
    await failPolicyStep(failFast, "parse", "job08-c-failed");
    await admitPolicyStep(failFast, "index", "job08-c-running");
    const failFastCommand = await terminateRootInvocation(failFast);
    const failFastDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: failFastCommand.id,
    });
    expect(failFastDecision.outcome).toBe("terminal_applied");
    expect(failFastDecision.job.jobState).toBe("failed");
    const [failFastEvent] = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.tenantId, TENANT_ID),
          eq(jobEventTable.jobId, failFast.fixture.job.id),
          eq(jobEventTable.eventType, "job.failed"),
        ),
      );
    // 收口事件必须带判定理由，便于事后解释"为什么这次失败"。
    expect((failFastEvent?.payloadJson as Record<string, unknown>).reasonCode).toBe(
      "RequiredStepFailed",
    );

    // ── D. threshold 0.5：2 名冻结成员中 1 名成功即达标 → Job 完成，分母是冻结集合 ──
    const thresholdMet = await seedExecutingJobForPolicy(thresholdPolicy(0.5), runtimeAuthority);
    await completePolicyStep(thresholdMet, "parse", "job08-d-done");
    await admitPolicyStep(thresholdMet, "index", "job08-d-running");
    const metCommand = await terminateRootInvocation(thresholdMet);
    const metDecision = await consumeJobCommand({ tenantId: TENANT_ID, commandId: metCommand.id });
    expect(metDecision.outcome).toBe("terminal_applied");
    expect(metDecision.job.jobState).toBe("completed");
    const [metEvent] = await db
      .select()
      .from(jobEventTable)
      .where(
        and(
          eq(jobEventTable.tenantId, TENANT_ID),
          eq(jobEventTable.jobId, thresholdMet.fixture.job.id),
          eq(jobEventTable.eventType, "job.completed"),
        ),
      );
    const metPayload = metEvent?.payloadJson as Record<string, unknown>;
    expect(metPayload.completionPolicy).toBe("ThresholdSatisfied");
    // 2 名已接纳成员都进入冻结集合（包含仍在运行的那一名），
    // 因此"当前返回数量"没有资格当分母。
    expect(metPayload.requiredMembers).toBe(2);

    // ── E. threshold 1.0：剩余可能成功数已不足 → 确定失败，不是无限等待 ──
    const thresholdUnreachable = await seedExecutingJobForPolicy(
      thresholdPolicy(1),
      runtimeAuthority,
    );
    await completePolicyStep(thresholdUnreachable, "parse", "job08-e-done");
    await failPolicyStep(thresholdUnreachable, "index", "job08-e-failed");
    const unreachableCommand = await terminateRootInvocation(thresholdUnreachable);
    const unreachableDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: unreachableCommand.id,
    });
    expect(unreachableDecision.outcome).toBe("terminal_applied");
    expect(unreachableDecision.job.jobState).toBe("failed");
    const unreachableJob = await getJobById(TENANT_ID, thresholdUnreachable.fixture.job.id);
    expect(unreachableJob?.errorCode).toBe("ThresholdUnreachable");

    // ── F. 成员持有未确定外部 Effect（job_step 的 Unknown）→ 持久等待，绝不伪成功 ──
    const unknownEffect = await seedExecutingJobForPolicy(
      ALL_SUCCESS_COMPLETION_POLICY,
      runtimeAuthority,
    );
    const unknownStep = await admitPolicyStep(unknownEffect, "index", "job08-f-unknown");
    const unknownRun = await runJobStepEffect({
      tenantId: TENANT_ID,
      ownerRef: unknownStep.ownerRef,
      invocationId: unknownEffect.fixture.invocation.id,
      operationKey: computeJobStepOperationKey({
        stepKey: unknownStep.stepKey,
        action: "upsert_vectors",
        target: "index:kb",
      }),
      requestDigest: unknownStep.requestDigest,
      effectType: "update",
      targetRefs: ["index:kb"],
      targetSummaryJson: { total: 1, description: "upsert vectors" },
      authority: unknownEffect.authority,
      provider: JOB08_PROVIDER,
    });
    expect(unknownRun.effectRecord.effectState).toBe("unknown_effect");
    const unknownCommand = await terminateRootInvocation(unknownEffect);
    const unknownDecision = await consumeJobCommand({
      tenantId: TENANT_ID,
      commandId: unknownCommand.id,
    });
    expect(unknownDecision.outcome).toBe("waiting_external");
    expect(unknownDecision.job.jobState).toBe("waiting_external");
    expect(unknownDecision.command.commandState).toBe("waiting");
    // Unknown 优先于一切策略（契约 unknownEffects=always_wait_or_manual）：
    // 既不能当成功收口，也不能当失败重跑。
    expect(unknownDecision.command.lastErrorCode).toBe("EffectUnresolved");
    expect(unknownDecision.command.nextAttemptAt).not.toBeNull();
    expect(await countJobCompletedEvents(unknownEffect.fixture.job.id)).toBe(0);

    // ── G. 策略在 Job 创建时 fail-closed 冻结：无法解析的策略不能建出 Job ──
    await expect(
      createJob({
        tenantId: TENANT_ID,
        agentId: null,
        jobType: "batch",
        triggerRef: `trigger:${randomUUID()}`,
        creationKey: `creation:${randomUUID()}`,
        // 缺 unknownEffects：无法确定 Unknown 处置方式的策略不得被接受。
        completionPolicyJson: { kind: "all_success" },
        inputJson: { task: "invalid-policy" },
      }),
    ).rejects.toMatchObject({ name: "CompletionPolicyInvalid" });
  });

  it.each(["inline", "reference"] as const)(
    "JOB-01: 无 Agent / 无 Thread 的真实 Job 经默认 Hosted Runner 与真实 Worker 执行，输入摘要复验、产物持久、Job 完成（%s）",
    async (inputKind) => {
      // ── 1. 真实 Job service 创建：agentId=null，且不创建任何 Thread/Turn ──
      const ownerId = await ensureDefaultTenantOwner();
      const runtimeAuthority = await seedJobRuntimeAuthority();
      const input =
        inputKind === "reference"
          ? await storeJobInputReference({
              tenantId: TENANT_ID,
              payload: { task: "summarize the released knowledge batch" },
            })
          : { inputJson: { task: "summarize the released knowledge batch" } };
      const { job } = await createJob({
        tenantId: TENANT_ID,
        agentId: null,
        jobType: "knowledge_build",
        triggerRef: `trigger:${randomUUID()}`,
        creationKey: `creation:${randomUUID()}`,
        completionPolicyJson: ALL_SUCCESS_COMPLETION_POLICY,
        ...input,
        createdBy: ownerId,
      });
      const admitted = await admitQueuedJob({ tenantId: TENANT_ID, jobId: job.id });
      expect(admitted.outcome).toBe("admitted");
      if (admitted.outcome !== "admitted") return;
      const [invocation] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, admitted.invocationId))
        .limit(1);
      const binding = await getExecutionBindingByInvocation(TENANT_ID, admitted.invocationId);
      if (!invocation || !binding) throw new Error("JOB-01: 接纳后回读 Invocation/Binding 失败");

      // 无 Thread / 无 Turn：不是"缺字段"，而是 Job 主体的真实形状。
      expect(invocation.subjectType).toBe("job");
      expect(invocation.threadId).toBeNull();
      expect(invocation.turnId).toBeNull();
      // 输入摘要：Invocation 冻结的执行目标摘要必须等于 Job 的正式输入摘要。
      expect(invocation.inputDigest).toBe(job.inputHash);

      // ── 2. 真实 Current Authority + Start 会话（dispatching ⇒ 首次执行必须提交 execution.started）──
      const attempt = await createAttempt({ tenantId: TENANT_ID, invocationId: invocation.id });
      const candidateEvidence = {
        kind: "job-01-candidate",
        invocationId: invocation.id,
        attemptId: attempt.id,
      };
      await db.transaction((tx) =>
        markAttemptPreparedForTestInTransaction(tx, {
          attemptId: attempt.id,
          evidence: candidateEvidence,
          digest: protocolDigest(candidateEvidence),
        }),
      );
      // 生产时序：Start 先固定激活证据（activationEvidence/Digest + activatedAt），此时
      // executionPhase 仍是 dispatching；Runtime 的 execution.started 到达时 applyLifecycle
      // 才把它推到 executing。这里用同一套测试支持写入完成该前移（写真实列），随后由默认
      // Hosted Runner 走"首次执行必须提交 execution.started"的同一条路径。
      const activationEvidence = {
        kind: "job-01-execution-activated",
        invocationId: invocation.id,
        attemptId: attempt.id,
      };
      const acquired = await acquireTestRuntimeAuthority({
        tenantId: TENANT_ID,
        invocationId: invocation.id,
        attemptId: attempt.id,
        runtimeRevisionId: binding.runtimeRevisionId,
        runtimeCapabilitiesJson: runtimeAuthority.capabilities,
        phase: "dispatching",
        activationEvidence,
      });
      const dispatchRequest = { kind: "job-01-hosted-start", invocationId: invocation.id };
      await applyRuntimeSessionDispatchForTest(TENANT_ID, acquired.session.id, {
        bindingState: "dispatching",
        semanticRequestJson: dispatchRequest,
        semanticRequestDigest: protocolDigest(dispatchRequest),
      });

      // ── 3. 默认 Hosted Runner 执行一个受管确定性任务；模型端口用受管确定性实现 ──
      let observedInvocationView: Record<string, unknown> | null = null;
      const service = createConfiguredHostedRuntimeApplicationService({
        ...createDirectResponsePorts((view) => {
          observedInvocationView = view.invocation as Record<string, unknown>;
          expect(view.objective).toBe("summarize the released knowledge batch");
          return "knowledge batch summarized";
        }),
        modelRef: "test-managed-model",
      });
      const started = await service.start({
        tenantId: TENANT_ID,
        invocationId: invocation.id,
        idempotencyKey: `job-01:${invocation.id}`,
        authority: acquired.authority,
      });
      expect(started.status).toBe("resumed");
      expect(started.runtime).toBe("hosted");
      expect(started.completed).toBe(true);

      // 执行主体是 Job：Loop 视图只带 jobId，不携带 threadId/turnId
      // （R06 §1：Thread/Turn 字段只在 Thread 分支必需）。
      expect(observedInvocationView).not.toBeNull();
      const viewSubject = observedInvocationView as unknown as {
        jobId: string;
        threadId?: unknown;
        turnId?: unknown;
      };
      expect(viewSubject.jobId).toBe(job.id);
      expect(viewSubject.threadId).toBeUndefined();
      expect(viewSubject.turnId).toBeUndefined();

      // ── 4. 真实 Ingress 事实：execution.started / response.completed / execution.completed ──
      const ingressRows = await db
        .select({
          candidateType: runtimeEventIngressTable.candidateType,
          payloadJson: runtimeEventIngressTable.payloadJson,
        })
        .from(runtimeEventIngressTable)
        .where(eq(runtimeEventIngressTable.invocationId, invocation.id))
        .orderBy(runtimeEventIngressTable.producerSequence);
      const types = ingressRows.map((row) => row.candidateType);
      expect(types).toContain("execution.started");
      expect(types).toContain("response.completed");
      expect(types).toContain("execution.completed");
      const responseFact = ingressRows.find((row) => row.candidateType === "response.completed");
      expect((responseFact?.payloadJson as Record<string, unknown>).text).toBe(
        "knowledge batch summarized",
      );

      // ── 5. 真实终态 + 真实结果摘要 ──
      const [terminal] = await db
        .select()
        .from(invocationTable)
        .where(eq(invocationTable.id, invocation.id))
        .limit(1);
      expect(terminal?.executionState).toBe("completed");
      expect(terminal?.resultRef).toBeTruthy();
      expect(terminal?.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

      // ── 6. 真实 Worker 拾取：默认 job-worker 角色消费终态命令并收口 Job ──
      const worker = createProductionWorkerRole("job-worker");
      const tick = (await worker.pollOnce()) as {
        commandsScanned: number;
        commandsConsumed: number;
      };
      expect(tick.commandsConsumed).toBeGreaterThanOrEqual(1);
      const finished = await getJobById(TENANT_ID, job.id);
      expect(finished?.jobState).toBe("completed");
      expect(finished?.resultRef).toBe(terminal?.resultRef);
      expect(finished?.resultHash).toBe(terminal?.resultDigest);

      // ── 7. 没有为通用 Job 执行补一个假 Thread / Turn / triggerItem ──
      expect(
        await db.select().from(threadTable).where(eq(threadTable.tenantId, TENANT_ID)),
      ).toEqual([]);
      expect(await db.select().from(turnTable)).toEqual([]);
    },
  );
});
