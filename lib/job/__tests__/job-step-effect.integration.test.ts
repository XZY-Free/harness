/**
 * T32 回归：Effect 多态 owner 的 Job step 路径（EFFECT-01..07）。
 *
 * 事实源：docs/topic02/nexharness-topic02-closure/acceptance/effect.md +
 * repairs/10-topic03-interfaces.md §T32。
 *
 * 层次：真实 MySQL + 生产服务。全部断言走真实表（RuntimeEventIngress / EffectRecord /
 * EffectTarget / ToolCall / Invocation / JobCommand），不 mock 仓储。
 *
 * 覆盖的硬约束：
 * - job step 的持久身份就是已提交的 `job.step.accepted` Ingress 记录 id（ownerRef），
 *   Effect 归属该 Job 的同一个 Invocation，且绝不伪造一个 ToolCall。
 * - 同 owner + operationKey：同请求复用原 Effect（不第二次外部写入），不同请求显式冲突。
 * - 派发意图先落库、结果守恒为 unknown_effect；crash 后必须先用 Provider 证据收敛，
 *   未知 Effect 既不能标成功也不能标失败。
 * - 新 Owner 恢复复用已确认结果，不重新执行；旧 Authority 不能推进当前 Job step。
 * - 按 invocationId 读取两类 owner，不做 INNER JOIN ToolCall，不丢 job_step 记录。
 * - ownerRef 一律真实回读校验，跨 tenant / 跨 Invocation / 任意字符串 / 错 ownerKind 全部拒绝。
 */
import { randomUUID } from "node:crypto";
import {
  EffectOwnerInvocationMismatchError,
  EffectOwnerNotFoundError,
  EffectOwnerValidationError,
  JOB_STEP_ACCEPTED_EVENT_TYPE,
  resolveEffectOwnerOnDb,
} from "@/lib/capability/effect-owner";
import {
  EffectDispatchEvidenceImmutableError,
  computeEffectRequestDigest,
  createEffectRecord,
  createEffectTargets,
  getEffectRecordByOwner,
  listEffectRecordsByInvocation,
  listEffectRecordsByInvocationState,
  listEffectTargets,
  reconcileEffect,
  recordEffectDispatchIntent,
} from "@/lib/capability/effect-queries";
import { db } from "@/lib/db/client";
import { resetDatabase } from "@/lib/db/test/mysql-harness";
import { transitionInvocation } from "@/lib/executions/application/transition-invocation";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { closeExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import {
  acquireTestRuntimeAuthority,
  seedPreparedJobRuntimeAttempt,
} from "@/lib/executions/test-support/seed-runtime-authority";
import { ensureDefaultTenant } from "@/lib/identity/tenant-bootstrap";
import { consumeJobCommand } from "@/lib/job/job-command-consumer";
import { getJobById } from "@/lib/job/job-queries";
import {
  JobStepEffectRequestConflictError,
  type JobStepEffectRun,
  JobStepEffectUnresolvedError,
  type RunJobStepEffectInput,
  admitJobStep,
  completeJobStep,
  computeJobStepKey,
  computeJobStepOperationKey,
  failJobStep,
  listJobStepEffects,
  runJobStepEffect,
} from "@/lib/job/job-step-effects";
import { effectRecordTable } from "@/lib/persistence/schema/effect";
import {
  executionBindingTable,
  runtimeEventIngressTable,
} from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import { jobCommandTable } from "@/lib/persistence/schema/job";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import {
  EventPayloadHashConflictError,
  ingressRuntimeEvents,
} from "@/lib/runtime/application/ingress-runtime-events";
import { updateRuntimeSessionDispatch } from "@/lib/runtime/persistence/runtime-session-store";
import { PROTOCOL_VERSION, protocolDigest } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

const TENANT_ID = "00000000-0000-4000-8000-000000000000";

/** 首次派发的 Provider / Connection / 端点证据（不含凭据明文）。 */
const TEST_PROVIDER = {
  providerType: "test_provider",
  connectionId: "conn-job-step",
  endpointFingerprint: protocolDigest({ endpoint: "https://provider.test/job-step" }),
};

// ─── 夹具 ────────────────────────────────────────────────

/**
 * Job 候选 + Current Authority（executing）。
 *
 * ingress 接纳 job.step.* 要求 Session 处于 active 且 Ownership 处于 executing，
 * 因此这里走与生产 start 相同的形状，而不是直接插一条 Ingress 记录。
 */
async function seedExecutingJobAuthority(input: { tenantId?: string } = {}): Promise<{
  fixture: Awaited<ReturnType<typeof seedPreparedJobRuntimeAttempt>>;
  authority: Awaited<ReturnType<typeof acquireTestRuntimeAuthority>>["authority"];
  ownershipId: string;
  sessionId: string;
}> {
  const fixture = await seedPreparedJobRuntimeAttempt({ tenantId: input.tenantId });
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: fixture.tenantId,
    invocationId: fixture.invocation.id,
    attemptId: fixture.attempt.id,
    runtimeRevisionId: fixture.binding.runtimeRevisionId,
    phase: "executing",
  });
  await updateRuntimeSessionDispatch(fixture.tenantId, acquired.session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "job-step-effect-test" },
    semanticRequestDigest: protocolDigest({ kind: "job-step-effect-test" }),
    remoteSessionRef: `job-step-session:${fixture.invocation.id}`,
    remoteExecutionRef: `job-step-execution:${fixture.invocation.id}`,
    startedEventId: randomUUID(),
  });
  return {
    fixture,
    authority: acquired.authority,
    ownershipId: acquired.ownership.id,
    sessionId: acquired.session.id,
  };
}

/** 关闭旧 Owner（原 Worker 死亡），为新 Attempt 建立 Current Authority。 */
async function handOverToNewOwner(input: {
  tenantId: string;
  invocationId: string;
  runtimeRevisionId: string;
  previousOwnershipId: string;
  previousSessionId: string;
}): Promise<{
  attemptId: string;
  authority: Awaited<ReturnType<typeof acquireTestRuntimeAuthority>>["authority"];
}> {
  await closeExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    ownershipId: input.previousOwnershipId,
    state: "lost",
    reasonCode: "worker_lost",
  });
  await updateRuntimeSessionDispatch(input.tenantId, input.previousSessionId, {
    bindingState: "lost",
  });
  const attempt = await createAttempt({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    retryReasonCode: "instance_lost",
  });
  const evidence = {
    kind: "test-candidate",
    invocationId: input.invocationId,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  const acquired = await acquireTestRuntimeAuthority({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: attempt.id,
    runtimeRevisionId: input.runtimeRevisionId,
    phase: "executing",
  });
  await updateRuntimeSessionDispatch(input.tenantId, acquired.session.id, {
    bindingState: "active",
    semanticRequestJson: { kind: "job-step-effect-test-handover" },
    semanticRequestDigest: protocolDigest({ kind: "job-step-effect-test-handover" }),
    remoteSessionRef: `job-step-handover-session:${input.invocationId}`,
    remoteExecutionRef: `job-step-handover-execution:${input.invocationId}`,
    startedEventId: randomUUID(),
  });
  return { attemptId: attempt.id, authority: acquired.authority };
}

interface StepSpec {
  stage: string;
  inputRefs: { ref: string; digest: string }[];
  processorDigest: string;
  profileDigest: string;
  requestDigest: string;
  stepKey: string;
}

/** 业务源 + 处理器配置稳定派生的步骤规格（不含 Attempt / epoch / 时间）。 */
function makeStep(stage: string, sourceSeed: string): StepSpec {
  const inputRefs = [
    { ref: `source://kb/${sourceSeed}`, digest: protocolDigest({ source: sourceSeed }) },
  ];
  const processorDigest = protocolDigest({ processor: stage, revision: 1 });
  return {
    stage,
    inputRefs,
    processorDigest,
    profileDigest: protocolDigest({ profile: stage }),
    requestDigest: protocolDigest({ stage, sourceSeed, processorDigest }),
    stepKey: computeJobStepKey({ stage, inputRefs, processorDigest }),
  };
}

/**
 * 模拟真实调用方：`runJobStepEffect` 只在事务内固定派发意图，真正的网络写入发生在
 * 事务外。这里用 externalWrites 代表那次不可回滚的外部写入次数。
 */
async function dispatchJobStepEffect(
  input: RunJobStepEffectInput,
  externalWrites: string[],
): Promise<JobStepEffectRun> {
  const run = await runJobStepEffect(input);
  if (!run.reused) externalWrites.push(input.operationKey);
  return run;
}

/** tool_call owner 的 Effect（与 Gateway 路径同一个 createEffectRecord 入口）。 */
async function seedToolCallOwnerEffect(input: {
  tenantId: string;
  invocationId: string;
  jobId: string;
}): Promise<{ toolCallId: string; effectRecordId: string; targetHash: string }> {
  const toolCallId = randomUUID();
  await db.insert(toolCallTable).values({
    id: toolCallId,
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    jobId: input.jobId,
    callSequence: 1,
    toolId: randomUUID(),
    toolSchemaRevisionId: randomUUID(),
    schemaHash: protocolDigest({ schema: "job-step-mixed" }),
    callState: "queued",
    operationId: `op-${toolCallId}`,
    argumentsRedactedJson: { collection: "kb" },
    argumentsHash: protocolDigest({ collection: "kb" }),
  });
  const record = await createEffectRecord({
    tenantId: input.tenantId,
    ownerKind: "tool_call",
    ownerRef: toolCallId,
    invocationId: input.invocationId,
    requestDigest: computeEffectRequestDigest({ toolCall: toolCallId }),
    effectType: "update",
    targetSummaryJson: { total: 1, description: "tool side effect" },
    externalIdempotencyKey: `snow-tool:${toolCallId}`,
    // 与 Tool 执行超时 / 副作用未确认的真实路径（markToolCallUnknownEffect）一致：
    // 调用已开始但结果未核实时必须是 unknown_effect，不能是 not_started。
    initialEffectState: "unknown_effect",
  });
  const targets = await createEffectTargets({
    tenantId: input.tenantId,
    effectRecordId: record.id,
    targets: [{ targetRef: "collection:kb" }],
  });
  const target = targets[0];
  if (!target) throw new Error("tool_call EffectTarget 未创建");
  return { toolCallId, effectRecordId: record.id, targetHash: target.targetHash };
}

async function countIngress(invocationId: string, candidateType: string): Promise<number> {
  const rows = await db
    .select({ id: runtimeEventIngressTable.id })
    .from(runtimeEventIngressTable)
    .where(
      and(
        eq(runtimeEventIngressTable.tenantId, TENANT_ID),
        eq(runtimeEventIngressTable.invocationId, invocationId),
        eq(runtimeEventIngressTable.candidateType, candidateType),
      ),
    );
  return rows.length;
}

async function readIngress(id: string) {
  const [row] = await db
    .select()
    .from(runtimeEventIngressTable)
    .where(
      and(eq(runtimeEventIngressTable.tenantId, TENANT_ID), eq(runtimeEventIngressTable.id, id)),
    )
    .limit(1);
  return row ?? null;
}

describe("T32 Job step Effect 多态 owner", () => {
  beforeEach(async () => {
    await resetDatabase(db);
    await ensureDefaultTenant();
  });

  it("EFFECT-01: job.step.accepted → Effect → Provider 成功 → step 完成，且不伪造 ToolCall", async () => {
    const { fixture, authority } = await seedExecutingJobAuthority();
    const step = makeStep("parse", "doc-01");

    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    expect(admission.replayed).toBe(false);
    expect(admission.invocationId).toBe(fixture.invocation.id);

    // ownerRef 必须真实存在：回读 Ingress 记录，核对类型、归属与冻结的 step 事实。
    const accepted = await readIngress(admission.ownerRef);
    expect(accepted?.candidateType).toBe(JOB_STEP_ACCEPTED_EVENT_TYPE);
    expect(accepted?.invocationId).toBe(fixture.invocation.id);
    const acceptedPayload = accepted?.payloadJson as Record<string, unknown>;
    expect(acceptedPayload.jobId).toBe(fixture.job.id);
    expect(acceptedPayload.stepKey).toBe(step.stepKey);
    expect(acceptedPayload.stage).toBe("parse");
    expect(acceptedPayload.requestDigest).toBe(step.requestDigest);

    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "index_collection",
      target: "collection:kb",
    });
    const externalWrites: string[] = [];
    const run = await dispatchJobStepEffect(
      {
        tenantId: TENANT_ID,
        ownerRef: admission.ownerRef,
        invocationId: fixture.invocation.id,
        operationKey,
        requestDigest: step.requestDigest,
        effectType: "update",
        targetRefs: ["collection:kb"],
        targetSummaryJson: { total: 1, description: "index collection:kb" },
        authority,
        provider: TEST_PROVIDER,
        externalIdempotencyKey: `snow-job-step:${operationKey}`,
      },
      externalWrites,
    );
    expect(run.reused).toBe(false);
    expect(externalWrites).toEqual([operationKey]);
    // 派发意图已写但结果未定时必须是保守 Unknown，而不是 not_started / confirmed_*。
    expect(run.effectRecord.ownerKind).toBe("job_step");
    expect(run.effectRecord.ownerRef).toBe(admission.ownerRef);
    expect(run.effectRecord.invocationId).toBe(fixture.invocation.id);
    expect(run.effectRecord.effectState).toBe("unknown_effect");
    expect(run.effectRecord.dispatchIntentAt).not.toBeNull();
    expect(run.effectRecord.dispatchEvidence?.authority.attemptId).toBe(fixture.attempt.id);

    // 测试 Provider 成功：以可信 Provider 查询证据收敛。
    const reconciled = await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: run.effectRecord.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: run.effectTargets.map((target) => ({
        targetHash: target.targetHash,
        targetState: "confirmed_success" as const,
      })),
      externalResultRef: "provider://kb/index/1",
    });
    expect(reconciled.effectRecord.effectState).toBe("confirmed_success");
    // job_step 没有 ToolCall，核对结果不伪造一个。
    expect(reconciled.toolCall).toBeNull();

    const resultDigest = protocolDigest({ step: step.stepKey, documents: 1 });
    const outcome = await completeJobStep({
      tenantId: TENANT_ID,
      authority,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      stepKey: step.stepKey,
      stage: step.stage,
      operationKeys: [operationKey],
      resultRef: "artifact://kb/index/1",
      resultDigest,
    });
    expect(outcome.replayed).toBe(false);
    expect(outcome.effectStates[operationKey]).toBe("confirmed_success");

    // 完成事件仍是同一 Invocation 的正式 Ingress 事实。
    const completed = await readIngress(outcome.ingressId);
    expect(completed?.candidateType).toBe("job.step.completed");
    expect(completed?.invocationId).toBe(fixture.invocation.id);
    const completedPayload = completed?.payloadJson as Record<string, unknown>;
    expect(completedPayload.ownerRef).toBe(admission.ownerRef);
    expect(completedPayload.resultRef).toBe("artifact://kb/index/1");
    expect(completedPayload.resultDigest).toBe(resultDigest);

    // 整个链路没有 ToolCall。
    expect(await db.select().from(toolCallTable)).toEqual([]);
    const effects = await listEffectRecordsByInvocation(TENANT_ID, fixture.invocation.id);
    expect(effects).toHaveLength(1);
    expect(effects[0]?.ownerKind).toBe("job_step");
  });

  it("EFFECT-02: 同 owner+Key 同请求复用原 Effect；不同请求显式冲突，不换 Key 绕过", async () => {
    const { fixture, authority } = await seedExecutingJobAuthority();
    const step = makeStep("chunk", "doc-02");

    const first = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    // 同一步骤重复接纳：命中同一条 Ingress 记录并返回原 ownerRef，不新建逻辑操作。
    const replay = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.ownerRef).toBe(first.ownerRef);
    expect(await countIngress(fixture.invocation.id, JOB_STEP_ACCEPTED_EVENT_TYPE)).toBe(1);

    // 同 stepKey 但输入不同：稳定事件 id 上出现不同 payloadHash，必须冲突而不是产生第二个 step。
    await expect(
      admitJobStep({
        tenantId: TENANT_ID,
        jobId: fixture.job.id,
        authority,
        stepKey: step.stepKey,
        stage: step.stage,
        inputRefs: [
          { ref: "source://kb/tampered", digest: protocolDigest({ source: "tampered" }) },
        ],
        processorDigest: step.processorDigest,
        profileDigest: step.profileDigest,
        requestDigest: step.requestDigest,
      }),
    ).rejects.toBeInstanceOf(EventPayloadHashConflictError);
    expect(await countIngress(fixture.invocation.id, JOB_STEP_ACCEPTED_EVENT_TYPE)).toBe(1);

    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "write_chunks",
      target: "collection:kb",
    });
    const externalWrites: string[] = [];
    const request = {
      tenantId: TENANT_ID,
      ownerRef: first.ownerRef,
      invocationId: fixture.invocation.id,
      operationKey,
      requestDigest: step.requestDigest,
      effectType: "update" as const,
      targetRefs: ["collection:kb"],
      targetSummaryJson: { total: 1, description: "write chunks" },
      authority,
      provider: TEST_PROVIDER,
    };
    const created = await dispatchJobStepEffect(request, externalWrites);
    expect(created.reused).toBe(false);
    expect(externalWrites).toEqual([operationKey]);

    // 相同请求重复（Provider 写成功但回执丢失后的同代重试）：复用同一 Effect 与同一派发意图，
    // 不产生第二次外部写入，也不覆写首次代际证据。
    const retried = await dispatchJobStepEffect(request, externalWrites);
    expect(retried.reused).toBe(true);
    expect(retried.effectRecord.id).toBe(created.effectRecord.id);
    expect(retried.effectRecord.dispatchEvidence).toEqual(created.effectRecord.dispatchEvidence);
    expect(externalWrites).toEqual([operationKey]);

    // 同 owner + 同 operationKey 但不同请求：身份冲突，既不静默复用旧 Effect，
    // 也不会在同一个 Key 上落下第二条记录。
    const differentRequest = computeEffectRequestDigest({
      operationKey,
      target: "collection:kb:v2",
    });
    await expect(
      dispatchJobStepEffect({ ...request, requestDigest: differentRequest }, externalWrites),
    ).rejects.toBeInstanceOf(JobStepEffectRequestConflictError);
    expect(externalWrites).toEqual([operationKey]);

    const stepEffects = await listJobStepEffects(TENANT_ID, first.ownerRef);
    expect(stepEffects).toHaveLength(1);
    expect(stepEffects[0]?.requestDigest).toBe(step.requestDigest);
    expect(stepEffects[0]?.effectState).toBe("unknown_effect");

    // 不换 Key 绕过的正面事实：operationKey 由 (stepKey, action, target) 确定性派生，
    // 重试无法凭「再算一次」拿到新身份。
    expect(
      computeJobStepOperationKey({
        stepKey: step.stepKey,
        action: "write_chunks",
        target: "collection:kb",
      }),
    ).toBe(operationKey);
  });

  it("EFFECT-03: Provider 写成功但回执丢失、原 Worker 死亡后，新 Owner 复用已确认结果且不重复外部写", async () => {
    const { fixture, authority, ownershipId, sessionId } = await seedExecutingJobAuthority();
    const step = makeStep("index", "doc-03");
    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "upsert_vectors",
      target: "index:kb",
    });
    const request = {
      tenantId: TENANT_ID,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      operationKey,
      requestDigest: step.requestDigest,
      effectType: "update" as const,
      targetRefs: ["index:kb"],
      targetSummaryJson: { total: 1, description: "upsert vectors" },
      provider: TEST_PROVIDER,
    };

    // 第一次派发：外部写入真实发生（计数器 +1），但回执在返回前丢失。
    const externalWrites: string[] = [];
    const dispatched = await dispatchJobStepEffect({ ...request, authority }, externalWrites);
    expect(externalWrites).toEqual([operationKey]);
    expect(dispatched.effectRecord.effectState).toBe("unknown_effect");
    const firstDispatchEvidence = dispatched.effectRecord.dispatchEvidence;
    expect(firstDispatchEvidence?.authority.attemptId).toBe(fixture.attempt.id);

    // 原 Worker 死亡：Owner 失效，Session 关闭，新 Attempt 接管。
    const { attemptId: newAttemptId, authority: newAuthority } = await handOverToNewOwner({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      previousOwnershipId: ownershipId,
      previousSessionId: sessionId,
    });
    expect(newAttemptId).not.toBe(fixture.attempt.id);

    // 新 Owner 重投同一步骤不会产生第二个逻辑操作：要么命中同一条已提交事实，
    // 要么被世代 Authority 校验拒绝——两条路都不会造出新的 ownerRef。
    const readmit = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority: newAuthority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (!readmit.ok) {
      expect(readmit.error).toBeInstanceOf(Error);
      expect((readmit.error as Error).name).toBe("IngressAuthorityMismatchError");
    } else {
      expect(readmit.value.ownerRef).toBe(admission.ownerRef);
      expect(readmit.value.replayed).toBe(true);
    }
    expect(await countIngress(fixture.invocation.id, JOB_STEP_ACCEPTED_EVENT_TYPE)).toBe(1);

    // 新 Owner 恢复：同 owner + 同 Key + 同请求 → 复用原 Effect，绝不重新发起已可能成功的写入。
    const recovered = await dispatchJobStepEffect(
      { ...request, authority: newAuthority },
      externalWrites,
    );
    expect(recovered.reused).toBe(true);
    expect(recovered.effectRecord.id).toBe(dispatched.effectRecord.id);
    expect(externalWrites).toEqual([operationKey]);
    expect(recovered.effectRecord.dispatchEvidence).toEqual(firstDispatchEvidence);
    expect(recovered.effectRecord.effectState).toBe("unknown_effect");

    // Unknown 先用 Provider 查询证据收敛：Provider 确认那次写入真的成功。
    const verified = await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: recovered.effectRecord.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: recovered.effectTargets.map((target) => ({
        targetHash: target.targetHash,
        targetState: "confirmed_success" as const,
      })),
      externalResultRef: "provider://index/kb/vectors/1",
      evidenceJson: {
        source: "provider_query",
        operationKey,
        observedObject: "index:kb",
      },
    });
    expect(verified.effectRecord.effectState).toBe("confirmed_success");

    // 新 Owner 用已确认结果收口，不再执行外部写入。
    const outcome = await completeJobStep({
      tenantId: TENANT_ID,
      authority: newAuthority,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      stepKey: step.stepKey,
      stage: step.stage,
      operationKeys: [operationKey],
      resultRef: "artifact://index/kb/vectors/1",
      resultDigest: protocolDigest({ index: "kb", vectors: 1 }),
    });
    expect(outcome.effectStates[operationKey]).toBe("confirmed_success");
    expect(externalWrites).toEqual([operationKey]);

    // 全链路只有一条 Effect、一条 job.step.accepted、一条 job.step.completed。
    expect(await listJobStepEffects(TENANT_ID, admission.ownerRef)).toHaveLength(1);
    expect(await countIngress(fixture.invocation.id, JOB_STEP_ACCEPTED_EVENT_TYPE)).toBe(1);
    expect(await countIngress(fixture.invocation.id, "job.step.completed")).toBe(1);
  });

  it("EFFECT-04: 派发意图已提交但尚未联网即 Crash → 保守 Unknown 且可核对，不假定失败重放", async () => {
    const { fixture, authority } = await seedExecutingJobAuthority();
    const step = makeStep("parse", "doc-04");
    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "dispatch_parse",
      target: "provider:parse",
    });

    // 意图短事务提交后进程立即死亡：这里不再调用外部 Provider。
    const persisted = await runJobStepEffect({
      tenantId: TENANT_ID,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      operationKey,
      requestDigest: step.requestDigest,
      effectType: "send",
      targetRefs: ["provider:parse"],
      targetSummaryJson: { total: 1, description: "dispatch parse job" },
      authority,
      provider: TEST_PROVIDER,
    });

    // 保守 Unknown：既不是 not_started（意图已写），也不是任何 confirmed_*。
    expect(persisted.effectRecord.effectState).toBe("unknown_effect");
    const evidence = persisted.effectRecord.dispatchEvidence;
    expect(persisted.effectRecord.dispatchIntentAt).not.toBeNull();
    expect(evidence?.requestDigest).toBe(step.requestDigest);
    expect(evidence?.authority).toMatchObject({
      invocationId: fixture.invocation.id,
      attemptId: fixture.attempt.id,
      ownershipId: authority.ownershipId,
      sessionBindingId: authority.sessionBindingId,
      leaseEpoch: authority.leaseEpoch,
    });
    expect(evidence?.provider).toEqual(TEST_PROVIDER);

    // 代际事实不可覆写：新 Owner 不能改写首次派发证据来伪装成「没发过」。
    // 走真实入口重写派发意图：内容不同 → 明确拒绝。
    await expect(
      recordEffectDispatchIntent({
        tenantId: TENANT_ID,
        effectRecordId: persisted.effectRecord.id,
        authority: {
          invocationId: fixture.invocation.id,
          attemptId: randomUUID(),
          ownershipId: null,
          sessionBindingId: null,
          leaseEpoch: null,
        },
        provider: { providerType: "other_provider", connectionId: null, endpointFingerprint: null },
        requestDigest: step.requestDigest,
      }),
    ).rejects.toBeInstanceOf(EffectDispatchEvidenceImmutableError);
    // 同内容重复记录是幂等返回，不产生新版本事实。
    const idempotent = await recordEffectDispatchIntent({
      tenantId: TENANT_ID,
      effectRecordId: persisted.effectRecord.id,
      authority: {
        invocationId: fixture.invocation.id,
        attemptId: fixture.attempt.id,
        ownershipId: authority.ownershipId,
        sessionBindingId: authority.sessionBindingId,
        leaseEpoch: authority.leaseEpoch,
      },
      provider: TEST_PROVIDER,
      requestDigest: step.requestDigest,
    });
    expect(idempotent.dispatchEvidence?.authority.attemptId).toBe(fixture.attempt.id);

    // 未知 Effect 既不能标成功也不能标失败：两种收口都必须被拒绝。
    await expect(
      completeJobStep({
        tenantId: TENANT_ID,
        authority,
        ownerRef: admission.ownerRef,
        invocationId: fixture.invocation.id,
        stepKey: step.stepKey,
        stage: step.stage,
        operationKeys: [operationKey],
        resultRef: "artifact://parse/1",
        resultDigest: protocolDigest({ parse: 1 }),
      }),
    ).rejects.toBeInstanceOf(JobStepEffectUnresolvedError);
    await expect(
      failJobStep({
        tenantId: TENANT_ID,
        authority,
        ownerRef: admission.ownerRef,
        invocationId: fixture.invocation.id,
        stepKey: step.stepKey,
        stage: step.stage,
        operationKeys: [operationKey],
        errorRef: "error://parse/timeout",
        errorDigest: protocolDigest({ error: "timeout" }),
        errorCode: "provider_timeout",
      }),
    ).rejects.toBeInstanceOf(JobStepEffectUnresolvedError);
    expect(await countIngress(fixture.invocation.id, "job.step.completed")).toBe(0);
    expect(await countIngress(fixture.invocation.id, "job.step.failed")).toBe(0);

    // 外部证据证明「从未执行」后才允许标失败——由证据驱动，而不是由 crash 自动推定。
    const targets = await listEffectTargets(TENANT_ID, persisted.effectRecord.id);
    await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: persisted.effectRecord.id,
      path: "admin",
      verificationMethod: "manual_evidence",
      targetUpdates: targets.map((target) => ({
        targetHash: target.targetHash,
        targetState: "confirmed_failure" as const,
      })),
      evidenceJson: { source: "provider_audit_log", conclusion: "no request reached provider" },
    });
    const failed = await failJobStep({
      tenantId: TENANT_ID,
      authority,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      stepKey: step.stepKey,
      stage: step.stage,
      operationKeys: [operationKey],
      errorRef: "error://parse/never_dispatched",
      errorDigest: protocolDigest({ error: "never_dispatched" }),
      errorCode: "provider_never_received",
    });
    expect(failed.effectStates[operationKey]).toBe("confirmed_failure");
    expect(await countIngress(fixture.invocation.id, "job.step.failed")).toBe(1);
  });

  it("EFFECT-05: tool_call 与 job_step 两类 Effect 混合可见、以 invocationId 收口，不被 INNER JOIN 丢掉", async () => {
    const { fixture, authority } = await seedExecutingJobAuthority();
    const step = makeStep("index", "doc-05");
    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "upsert_vectors",
      target: "index:kb",
    });
    const jobStepEffect = await runJobStepEffect({
      tenantId: TENANT_ID,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      operationKey,
      requestDigest: step.requestDigest,
      effectType: "update",
      targetRefs: ["index:kb"],
      targetSummaryJson: { total: 1, description: "upsert vectors" },
      authority,
      provider: TEST_PROVIDER,
    });
    const toolEffect = await seedToolCallOwnerEffect({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      jobId: fixture.job.id,
    });

    // 管理查询：两类 owner 都可见（job_step 没有 ToolCall 也不能被过滤掉）。
    const all = await listEffectRecordsByInvocation(TENANT_ID, fixture.invocation.id);
    expect(all).toHaveLength(2);
    expect(all.map((record) => record.ownerKind).sort()).toEqual(["job_step", "tool_call"]);
    expect(all.map((record) => record.id)).toContain(jobStepEffect.effectRecord.id);
    expect(all.map((record) => record.id)).toContain(toolEffect.effectRecordId);

    const unknown = await listEffectRecordsByInvocationState(TENANT_ID, fixture.invocation.id, [
      "unknown_effect",
    ]);
    expect(unknown).toHaveLength(2);

    // Job 终态收口：Invocation 完成 → execution_terminal 命令 → 两类 Unknown 都阻塞 Job。
    await db.transaction((tx) =>
      transitionInvocation(tx, {
        tenantId: TENANT_ID,
        invocationId: fixture.invocation.id,
        nextState: "completed",
        resultRef: "job://result/index",
        resultDigest: protocolDigest({ result: "index" }),
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
    expect(command).toBeTruthy();

    const blocked = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(blocked.outcome).toBe("waiting_external");
    expect(blocked.job.jobState).toBe("waiting_external");
    expect(blocked.command.commandState).toBe("waiting");
    expect(blocked.command.nextAttemptAt).not.toBeNull();

    // 只收敛 tool_call 一类：job_step 的 Unknown 仍必须继续阻塞（否则就是被静默丢记录）。
    const toolVerified = await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: toolEffect.effectRecordId,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: [{ targetHash: toolEffect.targetHash, targetState: "confirmed_success" }],
    });
    expect(toolVerified.effectRecord.effectState).toBe("confirmed_success");
    // Tool 分支的状态同步继续只作用于 tool_call owner。
    expect(toolVerified.toolCall?.callState).toBe("succeeded");

    const stillBlocked = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(stillBlocked.outcome).toBe("waiting_external");
    expect(stillBlocked.job.jobState).toBe("waiting_external");

    // 收敛 job_step 一类：Job 才能收口。
    const jobStepVerified = await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: jobStepEffect.effectRecord.id,
      path: "admin",
      verificationMethod: "provider_query",
      targetUpdates: jobStepEffect.effectTargets.map((target) => ({
        targetHash: target.targetHash,
        targetState: "confirmed_success" as const,
      })),
    });
    expect(jobStepVerified.effectRecord.effectState).toBe("confirmed_success");
    expect(jobStepVerified.toolCall).toBeNull();

    const applied = await consumeJobCommand({ tenantId: TENANT_ID, commandId: command!.id });
    expect(applied.outcome).toBe("terminal_applied");
    expect(applied.job.jobState).toBe("completed");

    const job = await getJobById(TENANT_ID, fixture.job.id);
    expect(job?.jobState).toBe("completed");
    expect(job?.resultRef).toBe("job://result/index");
    const remainingUnknown = await listEffectRecordsByInvocationState(
      TENANT_ID,
      fixture.invocation.id,
      ["unknown_effect"],
    );
    expect(remainingUnknown).toEqual([]);
    expect(await db.select().from(effectRecordTable)).toHaveLength(2);
  });

  it("EFFECT-06: 旧 Runtime 的晚到 Provider 回执可作为核对证据，但不能由旧 Authority 完成当前 step", async () => {
    const { fixture, authority, ownershipId, sessionId } = await seedExecutingJobAuthority();
    const step = makeStep("parse", "doc-06");
    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });
    const operationKey = computeJobStepOperationKey({
      stepKey: step.stepKey,
      action: "dispatch_parse",
      target: "provider:parse",
    });
    const dispatched = await runJobStepEffect({
      tenantId: TENANT_ID,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      operationKey,
      requestDigest: step.requestDigest,
      effectType: "send",
      targetRefs: ["provider:parse"],
      targetSummaryJson: { total: 1, description: "dispatch parse" },
      authority,
      provider: TEST_PROVIDER,
    });
    const oldAttemptId = fixture.attempt.id;

    const { authority: newAuthority } = await handOverToNewOwner({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      runtimeRevisionId: fixture.binding.runtimeRevisionId,
      previousOwnershipId: ownershipId,
      previousSessionId: sessionId,
    });

    // 旧执行者晚到的回执：仍可作为可信 Effect 的核对证据落库（按稳定 Operation/Provider 身份）。
    const late = await reconcileEffect({
      tenantId: TENANT_ID,
      effectRecordId: dispatched.effectRecord.id,
      path: "admin",
      verificationMethod: "callback_evidence",
      targetUpdates: dispatched.effectTargets.map((target) => ({
        targetHash: target.targetHash,
        targetState: "confirmed_success" as const,
      })),
      externalResultRef: "provider://parse/1",
      evidenceJson: {
        source: "late_callback",
        senderAttemptId: oldAttemptId,
        operationKey,
        providerReceipt: "provider://parse/1",
      },
    });
    expect(late.effectRecord.effectState).toBe("confirmed_success");
    // 核对是 Effect 身份驱动的，与当前 Authority 解耦；job_step 依旧不伪造 ToolCall。
    expect(late.toolCall).toBeNull();

    // 但旧 Authority 不能凭旧 Runtime 身份提交当前 Job step。
    await expect(
      completeJobStep({
        tenantId: TENANT_ID,
        authority,
        ownerRef: admission.ownerRef,
        invocationId: fixture.invocation.id,
        stepKey: step.stepKey,
        stage: step.stage,
        operationKeys: [operationKey],
        resultRef: "artifact://parse/1",
        resultDigest: protocolDigest({ parse: 1 }),
      }),
    ).rejects.toThrow();
    expect(await countIngress(fixture.invocation.id, "job.step.completed")).toBe(0);

    // Current Authority 才能推进：读取已确认 Effect 并收口，不重新执行。
    const outcome = await completeJobStep({
      tenantId: TENANT_ID,
      authority: newAuthority,
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
      stepKey: step.stepKey,
      stage: step.stage,
      operationKeys: [operationKey],
      resultRef: "artifact://parse/1",
      resultDigest: protocolDigest({ parse: 1 }),
    });
    expect(outcome.effectStates[operationKey]).toBe("confirmed_success");
    expect(await countIngress(fixture.invocation.id, "job.step.completed")).toBe(1);
    const completed = await readIngress(outcome.ingressId);
    const completedPayload = completed?.payloadJson as Record<string, unknown>;
    expect(completedPayload.ownerRef).toBe(admission.ownerRef);
  });

  it("EFFECT-07: 伪造 ownerRef（跨 tenant / 跨 Invocation / 任意字符串 / 错 ownerKind）被真实回读拒绝", async () => {
    const { fixture, authority } = await seedExecutingJobAuthority();
    const step = makeStep("parse", "doc-07");
    const admission = await admitJobStep({
      tenantId: TENANT_ID,
      jobId: fixture.job.id,
      authority,
      stepKey: step.stepKey,
      stage: step.stage,
      inputRefs: step.inputRefs,
      processorDigest: step.processorDigest,
      profileDigest: step.profileDigest,
      requestDigest: step.requestDigest,
    });

    // 任意 jobStep 字串：不是任何已提交事实。
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: TENANT_ID,
        ownerKind: "job_step",
        ownerRef: "job-step-1",
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);

    // 正确事实但 ownerKind 张冠李戴：ownerKind 不是标签，必须与源对象类型一致。
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: TENANT_ID,
        ownerKind: "tool_call",
        ownerRef: admission.ownerRef,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);

    // 跨 tenant：另一租户的 job.step.accepted 事实在本租户不可见。
    const otherTenantId = randomUUID();
    await db.insert(tenant).values({
      id: otherTenantId,
      key: `other-${otherTenantId}`,
      name: "Other Tenant",
      status: "active",
    });
    const other = await seedExecutingJobAuthority({ tenantId: otherTenantId });
    const otherStep = makeStep("parse", "doc-07-other");
    const otherAdmission = await admitJobStep({
      tenantId: otherTenantId,
      jobId: other.fixture.job.id,
      authority: other.authority,
      stepKey: otherStep.stepKey,
      stage: otherStep.stage,
      inputRefs: otherStep.inputRefs,
      processorDigest: otherStep.processorDigest,
      profileDigest: otherStep.profileDigest,
      requestDigest: otherStep.requestDigest,
    });
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: TENANT_ID,
        ownerKind: "job_step",
        ownerRef: otherAdmission.ownerRef,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);
    // 反向同样不可见。
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: otherTenantId,
        ownerKind: "job_step",
        ownerRef: admission.ownerRef,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);
    // 同 tenant 内合法 ownerRef 才可解析，并回带真实 jobId/stepKey/stage。
    const resolved = await resolveEffectOwnerOnDb({
      tenantId: TENANT_ID,
      ownerKind: "job_step",
      ownerRef: admission.ownerRef,
      invocationId: fixture.invocation.id,
    });
    expect(resolved.ownerKind).toBe("job_step");
    if (resolved.ownerKind === "job_step") {
      expect(resolved.jobStep.jobId).toBe(fixture.job.id);
      expect(resolved.jobStep.stepKey).toBe(step.stepKey);
      expect(resolved.jobStep.stage).toBe("parse");
    }

    // 声明了不属于该 ownerRef 的 Invocation：必须显式拒绝，不能靠字符串格式放行。
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: TENANT_ID,
        ownerKind: "job_step",
        ownerRef: admission.ownerRef,
        invocationId: other.fixture.invocation.id,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerInvocationMismatchError);

    // 伪造 ownerRef 走正式入口：拒绝且不落任何 Effect 记录。
    await expect(
      runJobStepEffect({
        tenantId: TENANT_ID,
        ownerRef: "forged-owner-ref",
        invocationId: fixture.invocation.id,
        operationKey: computeJobStepOperationKey({
          stepKey: step.stepKey,
          action: "fake",
          target: "provider:fake",
        }),
        requestDigest: step.requestDigest,
        effectType: "update",
        targetRefs: ["provider:fake"],
        targetSummaryJson: { total: 1 },
        authority,
        provider: TEST_PROVIDER,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);
    // 跨 Invocation 的合法 ownerRef 也不接受。
    await expect(
      runJobStepEffect({
        tenantId: TENANT_ID,
        ownerRef: otherAdmission.ownerRef,
        invocationId: fixture.invocation.id,
        operationKey: computeJobStepOperationKey({
          stepKey: step.stepKey,
          action: "fake",
          target: "provider:fake",
        }),
        requestDigest: step.requestDigest,
        effectType: "update",
        targetRefs: ["provider:fake"],
        targetSummaryJson: { total: 1 },
        authority,
        provider: TEST_PROVIDER,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerNotFoundError);
    expect(await getEffectRecordByOwner(TENANT_ID, "job_step", "forged-owner-ref")).toBeNull();
    expect(await db.select().from(effectRecordTable)).toEqual([]);

    // 非 job.step.accepted 的已接纳事实不能充当 job step owner：
    // 走正式 Ingress 写入一条真实邻居事件（progress 不产生新决策，也无需 Job step 事实），
    // 再拿它的 id 去解析。
    await ingressRuntimeEvents({
      tenantId: TENANT_ID,
      invocationId: fixture.invocation.id,
      batch: {
        protocolVersion: PROTOCOL_VERSION,
        authority,
        events: [
          {
            eventId: randomUUID(),
            producerSequence: "2",
            type: "progress",
            schemaVersion: 1,
            payload: { progress: "snapshot" },
          },
        ],
      },
    });
    const [notAccepted] = await db
      .select({ id: runtimeEventIngressTable.id })
      .from(runtimeEventIngressTable)
      .where(
        and(
          eq(runtimeEventIngressTable.tenantId, TENANT_ID),
          eq(runtimeEventIngressTable.invocationId, fixture.invocation.id),
          eq(runtimeEventIngressTable.candidateType, "progress"),
        ),
      )
      .limit(1);
    expect(notAccepted).toBeTruthy();
    await expect(
      resolveEffectOwnerOnDb({
        tenantId: TENANT_ID,
        ownerKind: "job_step",
        ownerRef: notAccepted!.id,
      }),
    ).rejects.toBeInstanceOf(EffectOwnerValidationError);

    // service Principal 仍受权限约束：把 Binding 的 principal 改成普通用户后，
    // job.step.accepted 不再被接纳（不因为 ownerRef 合法就放行）。
    await db
      .update(executionBindingTable)
      .set({
        principalType: "user",
        principalSource: "authenticated_user",
        principalId: "test-user",
      })
      .where(eq(executionBindingTable.invocationId, fixture.invocation.id));
    const secondStep = makeStep("chunk", "doc-07-second");
    await expect(
      admitJobStep({
        tenantId: TENANT_ID,
        jobId: fixture.job.id,
        authority,
        stepKey: secondStep.stepKey,
        stage: secondStep.stage,
        inputRefs: secondStep.inputRefs,
        processorDigest: secondStep.processorDigest,
        profileDigest: secondStep.profileDigest,
        requestDigest: secondStep.requestDigest,
      }),
    ).rejects.toThrow();
    expect(await countIngress(fixture.invocation.id, JOB_STEP_ACCEPTED_EVENT_TYPE)).toBe(1);
  });
});
