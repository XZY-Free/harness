import { randomUUID } from "node:crypto";
import { DEFAULT_USER_EMAIL, DEFAULT_USER_ID, DEFAULT_USER_NAME } from "@/lib/constants";
import { db } from "@/lib/db/client";
import type { ExecutionBindingControlPlaneEvidence } from "@/lib/executions/domain/execution-binding";
import {
  type AttemptPreparationClaim,
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { createInvocation } from "@/lib/executions/persistence/invocation-store";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { markAttemptPreparedForTestInTransaction } from "@/lib/executions/test-support/preparation-fixtures";
import { attemptPreparationClaimForTest } from "@/lib/executions/test-support/preparation-fixtures";
import { DEFAULT_TENANT_ID } from "@/lib/identity/tenant-bootstrap";
import { upsertUserIdentity } from "@/lib/identity/user-identity-queries";
import { ALL_SUCCESS_COMPLETION_POLICY } from "@/lib/job/completion-policy";
import { admitQueuedJob } from "@/lib/job/job-admission";
import { createJob } from "@/lib/job/job-queries";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import {
  type InvocationAttempt,
  executionOwnershipTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { type JobType, jobTable } from "@/lib/persistence/schema/job";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import {
  MAX_TRAFFIC_WEIGHT,
  createRouteSet,
} from "@/lib/routes/application/deployment-route-service";
import { activateSingleRouteForTest } from "@/lib/routes/test-support/activate-single-route-for-test";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { ensureTestRuntimeRevision } from "@/lib/runtime/test-support/seed-test-runtime-revision";
import {
  createRuntimeSessionBindingForTest,
  sourceIntentForFixture,
} from "@/lib/runtime/test-support/session-write-fixtures";
import { buildActor } from "@/lib/test-support/create-verified-attestation";
import { ensureTenantWithBaselines } from "@/lib/test-support/ensure-tenant-with-baselines";
import { seedPublishedRuntimeRevision } from "@/lib/test-support/seed-published-runtime-revision";
import { seedRuntimeRouteAuthority } from "@/lib/test-support/seed-runtime-route-authority";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { and, eq } from "drizzle-orm";

export const TEST_RUNTIME_REVISION_ID = "11111111-1111-4111-8111-111111111111";
export const DEFAULT_ROUTE_SCOPE_KEY = "default";

/**
 * Job 无 Thread 的等价候选：Job → 唯一 Invocation(subjectType=job) → Binding → Attempt(prepared)。
 *
 * R01 §2：Job 的 Invocation/Binding **必须**经正式 Job admission lane
 * （`admitQueuedJob` → 同一 Binding Authority）建立，不再由测试伪造一条
 * `NewExecutionBinding`。因此本夹具先建出真实 Route/Runtime 权威，再走接纳。
 *
 * 与 seedPreparedRuntimeAttempt 同样只准备"候选资源已就绪"的事实，不创建 Thread/Turn，
 * 也不替 Runtime 预置 Ownership。
 */
export async function seedPreparedJobRuntimeAttempt(
  input: {
    tenantId?: string;
    runtimeRevisionId?: string;
    workspaceBinding?: WorkspaceBinding;
    agentId?: string | null;
    jobType?: JobType;
    /** 冻结的完成策略；缺省为 all_success。策略在创建时冻结，之后不可 UPDATE。 */
    completionPolicyJson?: Record<string, unknown>;
    /**
     * 复用同一测试内已建立的 Runtime 权威（Route + Revision）。
     *
     * `DeploymentRouteSet` 的唯一键是 `(tenantId, targetKind, targetIdentity, routeScopeKey)`，
     * 因此"一个测试里建多个 Job"必须复用既有权威：重复建 RouteSet 会 ER_DUP_ENTRY，
     * 而正确的做法不是放宽唯一约束或给每个 Job 造一个假作用域。
     */
    reuseRuntimeAuthority?: { runtimeRevisionId: string };
  } = {},
) {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const ownerId = await ensureDefaultTenantOwner(tenantId);
  const suffix = randomUUID().slice(0, 8);
  const runtimeRevisionId =
    input.runtimeRevisionId ??
    input.reuseRuntimeAuthority?.runtimeRevisionId ??
    (
      await seedPublishedRuntimeRevision(
        tenantId,
        ownerId,
        `job-runtime-${suffix}`,
        ["event_stream"],
        suffix,
      )
    ).revision.id;
  if (!input.reuseRuntimeAuthority) {
    await seedRuntimeRouteAuthority({ tenantId, runtimeRevisionId, actorId: "job-worker-fixture" });
  }
  const { job } = await createJob({
    tenantId,
    agentId: input.agentId ?? null,
    jobType: input.jobType ?? "knowledge_build",
    triggerRef: `trigger:${randomUUID()}`,
    creationKey: `creation:${randomUUID()}`,
    completionPolicyJson: input.completionPolicyJson ?? ALL_SUCCESS_COMPLETION_POLICY,
    inputJson: { task: "job-runtime-ingress-fixture" },
    createdBy: ownerId,
  });
  const admitted = await admitQueuedJob({ tenantId, jobId: job.id });
  if (admitted.outcome !== "admitted") {
    throw new Error(`Job admission 未接纳：${admitted.outcome}/${admitted.reason}`);
  }
  const [invocation] = await db
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, tenantId), eq(invocationTable.id, admitted.invocationId)),
    )
    .limit(1);
  const binding = invocation
    ? await getExecutionBindingByInvocation(tenantId, invocation.id)
    : null;
  if (!invocation || !binding) throw new Error("Job admission 后回读 Invocation/Binding 失败");
  const workspace =
    input.workspaceBinding ?? (await getWorkspaceBindingById(tenantId, binding.workspaceBindingId));
  if (!workspace) throw new Error("Job admission 的 WorkspaceBinding 回读失败");
  const [jobRow] = await db
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, tenantId), eq(jobTable.id, job.id)))
    .limit(1);
  if (!jobRow) throw new Error("Job 回读失败");
  const attempt = await createAttempt({ tenantId, invocationId: invocation.id });
  const evidence = {
    kind: "test-candidate",
    invocationId: invocation.id,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return {
    tenantId,
    job: jobRow,
    invocation,
    binding,
    workspace,
    attempt,
  };
}

/**
 * 幂等建出该租户 + 默认 owner。
 *
 * Job admission 需要真实读取 Governance/Policy（`resolveBindingGovernance`）与可信
 * principal 事实，因此**任意** tenantId 都必须先补齐租户 baseline，而不是只为默认租户补。
 */
async function ensureDefaultTenantOwner(tenantId: string): Promise<string> {
  await ensureTenantWithBaselines(tenantId, "job-runtime-fixture");
  const identity = await upsertUserIdentity({
    tenantId,
    externalSubject: DEFAULT_USER_ID,
    email: DEFAULT_USER_EMAIL,
    displayName: DEFAULT_USER_NAME,
  });
  return identity.id;
}

export async function seedPreparedRuntimeAttempt(
  input: {
    tenantId?: string;
    runtimeRevisionId?: string;
    workspaceBinding?: WorkspaceBinding;
    environmentDefinitionRevisionId?: string;
    policyRevisionId?: string;
    governanceConfigRevisionId?: string;
    controlPlaneEvidence?: ExecutionBindingControlPlaneEvidence;
    /**
     * 复用一条**已经由产品路径建立**的 Thread/Turn（`createThread` +
     * `acceptUserMessageTurn`），而不是由本夹具直接 INSERT 三张表。
     *
     * 产品路径会同时写入 `thread.created` / `turn.accepted` / `item.created` 三个
     * ThreadEvent，读模型投影据此才能建立 Turn 时间线行；需要验证"刷新产品页后从 DB
     * 重建的时间线与正式输出一致"的场景必须走这条路径，不能伪造事件行。
     */
    thread?: { threadId: string; turnId: string; triggerItemId: string };
  } = {},
) {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const threadId = input.thread?.threadId ?? randomUUID();
  const turnId = input.thread?.turnId ?? randomUUID();
  const triggerItemId = input.thread?.triggerItemId ?? randomUUID();
  if (!input.thread) {
    await db.insert(threadTable).values({
      id: threadId,
      tenantId,
      ownerUserId: "test-user",
      lifecycleState: "active",
      lastActivityAt: new Date(),
      lastTurnSequence: 1,
      lastItemSequence: 1,
      lastEventSequence: 0,
      pendingQueueVersionNo: 1,
      versionNo: 1,
    });
    await db.insert(threadItemTable).values({
      id: triggerItemId,
      threadId,
      turnId,
      itemSequence: 1,
      itemType: "user_message",
      itemState: "completed",
      authorType: "user",
      authorId: "test-user",
      contentJson: { text: "test runtime invocation" },
      contentHash: "sha256:test-runtime-invocation",
      contextPolicy: "include",
    });
    await db.insert(turnTable).values({
      id: turnId,
      threadId,
      turnSequence: 1,
      triggerType: "user_message",
      triggerItemId,
      turnState: "accepted",
      activeInvocationId: null,
      latestInvocationId: null,
      regenerationNo: 0,
      versionNo: 1,
    });
  }
  const { invocation } = await createInvocation({
    tenantId,
    threadId,
    turnId,
    triggerItemId,
    invocationKind: "initial",
  });
  const workspace =
    input.workspaceBinding ?? (await createNoPlatformWorkspaceBinding(tenantId, "test-service"));
  const runtimeRevisionId = input.runtimeRevisionId ?? TEST_RUNTIME_REVISION_ID;
  await ensureTestRuntimeRevision(tenantId, runtimeRevisionId);
  const binding = await createExecutionBinding({
    tenantId,
    invocationId: invocation.id,
    runtimeRevisionId,
    deploymentRouteId: "test-route",
    modelProvider: "test",
    modelId: "test-model",
    workspaceBindingId: workspace.id,
    environmentDefinitionRevisionId: input.environmentDefinitionRevisionId ?? null,
    environmentMode: input.environmentDefinitionRevisionId ? "MANAGED" : "NO_PLATFORM_ENVIRONMENT",
    policyRevisionId: input.policyRevisionId,
    governanceConfigRevisionId: input.governanceConfigRevisionId,
    controlPlaneEvidence: input.controlPlaneEvidence ?? TEST_EXECUTION_BINDING_EVIDENCE,
    projectionVersionNo: 1,
    executionSubject: { tenantId, subjectType: "user", subjectId: "test-user" },
  });
  const attempt = await createAttempt({ tenantId, invocationId: invocation.id });
  const evidence = { kind: "test-candidate", invocationId: invocation.id, attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return { tenantId, threadId, turnId, invocation, binding, workspace, attempt };
}

/**
 * 建出「基础设施替换后的新 Attempt」（并写好准备槽）。
 *
 * 进程被杀 / 租约过期属于**基础设施替换**：`contracts/shared-contracts.md` 规定
 * "按既定 Attempt 规则创建新 Attempt"，`FENCE-18` 把它写成"换实例必须新建 Attempt"。
 * 接管事务会**收口**旧 Attempt，因此新代际绝不能沿用同一行 —— 否则 `prepareChecks`
 * 在收口**之前**看到 `running` 而放行，而新 Ownership 建立时该行已是 `lost`：
 * 守卫被自己所在的事务推翻，下游 `execution.started` 再写 `running` 必然违反
 * `InvocationAttempt_terminal_shape`（`attemptState` 与 `finishedAt` 形态约束）。
 *
 * 生产各 Start/Redispatch 调用方同形：`dispatcher`、`redispatchRuntimeInvocation`、
 * `dispatch-queued-invocation-attempt` 都是先 `createAttempt` 再 Start。
 */
export async function createPreparedTakeoverAttempt(input: {
  tenantId: string;
  invocationId: string;
  retryReasonCode?: string | null;
}): Promise<InvocationAttempt & { preparationClaim: AttemptPreparationClaim }> {
  const attempt = await createAttempt({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    retryReasonCode: input.retryReasonCode ?? "infrastructure_replacement",
  });
  const evidence = {
    kind: "test-candidate",
    invocationId: input.invocationId,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedForTestInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return Object.assign(attempt, {
    preparationClaim: await attemptPreparationClaimForTest(attempt.id),
  });
}

export async function acquireTestRuntimeAuthority(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeRevisionId: string;
  environmentLeaseId?: string;
  phase?: "dispatching" | "executing";
  /**
   * R02 §3：该 Session 冻结的发布能力证据（RuntimeRevision.runtimeCapabilitiesJson）。
   * 需要让夹具接纳 `execution.started` 时必须提供——Ingress 会按它重算 expected digest
   * 并与事件 payload 比对，null 会被 fail-closed 拒绝。
   */
  runtimeCapabilitiesJson?: unknown;
  /**
   * R02 生产时序：Start 在**派发前**就固定激活证据（activationEvidence/Digest +
   * activatedAt），此时 executionPhase 仍是 `dispatching`；只有 Runtime 的
   * `execution.started` 被接纳时，applyLifecycle 才把 phase 推到 `executing`
   * （并受 `ExecutionOwnership_executing_activation_shape` 约束）。
   *
   * 需要在 dispatching 阶段就带激活证据的用例显式提供；不提供则维持既有行为。
   */
  activationEvidence?: unknown;
  activationDigest?: string | null;
  /**
   * A05：本次取得执行权所依据的恢复水位摘要（`start` 为 null，`resume` 为当次 Anchor）。
   *
   * 必须原样转发给 `acquireExecutionOwnership` —— `prepareChecks` 会拿它与 Lease 上冻结的
   * Prepared 证据逐字比对。夹具若把它吞掉（默认 null），正式 Resume 按新 Anchor 重写过的
   * 证据就会被判成"恢复 Anchor 已变化"，这是夹具缺参，不是实现拒绝。
   */
  recoveryAnchorDigest?: string | null;
}) {
  const acquired = await acquireExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    runtimeRevisionId: input.runtimeRevisionId,
    environmentLeaseId: input.environmentLeaseId,
    recoveryAnchorDigest: input.recoveryAnchorDigest ?? null,
    acquiredByType: "service",
    acquiredById: "test-runtime",
  });
  const session = await createRuntimeSessionBindingForTest({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    ownershipId: acquired.ownership.id,
    runtimeRevisionId: input.runtimeRevisionId,
    leaseEpoch: acquired.ownership.leaseEpoch,
    intentType: "start",
    startIntentKey: `start:${acquired.ownership.id}`,
    ...sourceIntentForFixture({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      intentType: "start",
    }),
    runtimeCapabilitiesJson: input.runtimeCapabilitiesJson ?? null,
  });
  const phase = input.phase ?? "dispatching";
  if (phase === "dispatching" && input.activationEvidence) {
    await db
      .update(executionOwnershipTable)
      .set({
        activationEvidence: input.activationEvidence,
        activationDigest: input.activationDigest ?? protocolDigest(input.activationEvidence),
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, acquired.ownership.id),
        ),
      );
  }
  if (phase === "executing") {
    // canonical ExecutionOwnership_executing_activation_shape：executing 阶段必须
    // 携带 activatedAt + activationEvidence/Digest（镜像生产 startRuntimeInvocation 激活写入）。
    const activationEvidence = {
      kind: "execution-activated",
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      ownershipId: acquired.ownership.id,
      leaseEpoch: String(acquired.ownership.leaseEpoch),
      runtimeRevisionId: input.runtimeRevisionId,
      workspace: { mode: "NO_PLATFORM_WORKSPACE" },
    };
    await db
      .update(executionOwnershipTable)
      .set({
        executionPhase: phase,
        activationEvidence,
        activationDigest: protocolDigest(activationEvidence),
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, acquired.ownership.id),
        ),
      );
  } else {
    await db
      .update(executionOwnershipTable)
      .set({ executionPhase: phase, updatedAt: new Date() })
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, acquired.ownership.id),
        ),
      );
  }
  if (phase === "executing") {
    await db
      .update(invocationTable)
      .set({ executionState: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocationId),
        ),
      );
  }
  return {
    ownership: { ...acquired.ownership, executionPhase: phase },
    session,
    authority: {
      invocationId: input.invocationId,
      runtimeRevisionId: input.runtimeRevisionId,
      attemptId: input.attemptId,
      ownershipId: acquired.ownership.id,
      leaseEpoch: String(acquired.ownership.leaseEpoch),
      sessionBindingId: session.id,
    },
  };
}
