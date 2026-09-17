import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  createAttempt,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import { acquireExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { createInvocation } from "@/lib/executions/persistence/invocation-store";
import {
  TEST_EXECUTION_BINDING_EVIDENCE,
  createExecutionBinding,
} from "@/lib/executions/test-support/create-unverified-execution-binding";
import { DEFAULT_TENANT_ID } from "@/lib/identity/tenant-bootstrap";
import { createJobInvocation } from "@/lib/job/job-execution";
import { createJob } from "@/lib/job/job-queries";
import { threadItemTable, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
import { executionOwnershipTable, invocationTable } from "@/lib/persistence/schema/executions";
import type { WorkspaceBinding } from "@/lib/persistence/schema/workspace";
import { createRuntimeSessionBinding } from "@/lib/runtime/persistence/runtime-session-store";
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import { createNoPlatformWorkspaceBinding } from "@/lib/workspace/workspace-binding-store";
import { and, eq } from "drizzle-orm";

export const TEST_RUNTIME_REVISION_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Job 无 Thread 的等价候选：Job → 唯一 Invocation(subjectType=job) → Binding → Attempt(prepared)。
 *
 * 与 seedPreparedRuntimeAttempt 同样只准备"候选资源已就绪"的事实，不创建 Thread/Turn，
 * 也不替 Runtime 预置 Ownership。用于验证真实 Job 事件走正式 Ingress 的产品路径。
 */
export async function seedPreparedJobRuntimeAttempt(
  input: {
    tenantId?: string;
    runtimeRevisionId?: string;
    workspaceBinding?: WorkspaceBinding;
    agentId?: string | null;
  } = {},
) {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const { job } = await createJob({
    tenantId,
    agentId: input.agentId ?? null,
    jobType: "knowledge_build",
    triggerRef: `trigger:${randomUUID()}`,
    creationKey: `creation:${randomUUID()}`,
    completionPolicyJson: { policy: "all_success" },
    inputJson: { task: "job-runtime-ingress-fixture" },
  });
  const workspace =
    input.workspaceBinding ?? (await createNoPlatformWorkspaceBinding(tenantId, "test-service"));
  const runtimeRevisionId = input.runtimeRevisionId ?? TEST_RUNTIME_REVISION_ID;
  const created = await createJobInvocation({
    tenantId,
    jobId: job.id,
    binding: {
      runtimeRevisionId,
      deploymentRouteId: "test-route",
      routeRevisionId: randomUUID(),
      routeActivationId: randomUUID(),
      routeContentDigest: protocolDigest("route-content"),
      policyRevisionId: randomUUID(),
      policyRulesDigest: protocolDigest("policy-rules"),
      governanceConfigRevisionId: randomUUID(),
      governanceConfigDigest: protocolDigest("governance-config"),
      runtimePublicationRecordId: randomUUID(),
      conformanceRunId: randomUUID(),
      modelProvider: "test",
      modelId: "test-model",
      modelRevisionRef: null,
      runtimeArtifactId: null,
      runtimeArtifactDigest: null,
      runtimeEvidenceKind: "external_endpoint",
      runtimeTargetDigest: protocolDigest("target"),
      runtimeConfigDigest: protocolDigest("runtime-config"),
      capabilityManifestDigest: protocolDigest("manifest"),
      runtimeAttestationIds: [],
      resolutionInputDigest: protocolDigest("resolution"),
      projectionVersionNo: 1,
      capabilityCatalogDigest: protocolDigest("catalog"),
      capabilityCatalogJson: { fixture: "job-runtime-ingress" },
      capabilityCatalogVersion: "1",
      capabilityCatalogSourceRefs: [],
      capabilityCatalogCreatedAt: new Date(),
      workspaceBindingId: workspace.id,
      environmentDefinitionRevisionId: null,
      environmentMode: "NO_PLATFORM_ENVIRONMENT",
      principalType: "service",
      principalId: "test-service",
      principalSource: "trusted_service",
      principalFrozenAt: new Date(),
      configHash: protocolDigest({ fixture: "job-runtime-ingress", jobId: job.id }),
    },
  });
  const attempt = await createAttempt({ tenantId, invocationId: created.invocation.id });
  const evidence = {
    kind: "test-candidate",
    invocationId: created.invocation.id,
    attemptId: attempt.id,
  };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return {
    tenantId,
    job,
    invocation: created.invocation,
    binding: created.binding,
    workspace,
    attempt,
  };
}

export async function seedPreparedRuntimeAttempt(
  input: {
    tenantId?: string;
    runtimeRevisionId?: string;
    workspaceBinding?: WorkspaceBinding;
    environmentDefinitionRevisionId?: string;
    policyRevisionId?: string;
    governanceConfigRevisionId?: string;
  } = {},
) {
  const tenantId = input.tenantId ?? DEFAULT_TENANT_ID;
  const threadId = randomUUID();
  const turnId = randomUUID();
  const triggerItemId = randomUUID();
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
    controlPlaneEvidence: TEST_EXECUTION_BINDING_EVIDENCE,
    projectionVersionNo: 1,
    executionSubject: { tenantId, subjectType: "user", subjectId: "test-user" },
  });
  const attempt = await createAttempt({ tenantId, invocationId: invocation.id });
  const evidence = { kind: "test-candidate", invocationId: invocation.id, attemptId: attempt.id };
  await db.transaction((tx) =>
    markAttemptPreparedInTransaction(tx, {
      attemptId: attempt.id,
      evidence,
      digest: protocolDigest(evidence),
    }),
  );
  return { tenantId, threadId, turnId, invocation, binding, workspace, attempt };
}

export async function acquireTestRuntimeAuthority(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  runtimeRevisionId: string;
  environmentLeaseId?: string;
  phase?: "dispatching" | "executing";
}) {
  const acquired = await acquireExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    runtimeRevisionId: input.runtimeRevisionId,
    environmentLeaseId: input.environmentLeaseId,
    acquiredByType: "service",
    acquiredById: "test-runtime",
  });
  const session = await createRuntimeSessionBinding({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    attemptId: input.attemptId,
    ownershipId: acquired.ownership.id,
    runtimeRevisionId: input.runtimeRevisionId,
    leaseEpoch: acquired.ownership.leaseEpoch,
    intentType: "start",
    startIntentKey: `start:${acquired.ownership.id}`,
  });
  const phase = input.phase ?? "dispatching";
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
