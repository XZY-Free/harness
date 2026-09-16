/** Thread-independent Job execution creation. */
import { randomUUID } from "node:crypto";
import { type DbOrTx, db } from "@/lib/db/client";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import {
  type ExecutionBinding,
  type Invocation,
  type NewExecutionBinding,
  executionBindingTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { type Job, jobTable } from "@/lib/persistence/schema/job";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import { canonicalizeJson } from "@/lib/runtime/runtime-protocol";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class JobExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobExecutionConflictError";
  }
}

export interface CreateJobInvocationInput {
  tenantId: string;
  jobId: string;
  /** Complete frozen ExecutionBinding evidence prepared by the domain resolver. */
  binding: Omit<NewExecutionBinding, "tenantId" | "invocationId">;
}

export interface JobInvocationResult {
  job: Job;
  invocation: Invocation;
  binding: ExecutionBinding;
  created: boolean;
}

/**
 * Creates the only top-level Invocation for a Job and its complete Binding in
 * one Job-root transaction. Repeated scheduler delivery returns the same
 * durable pair; it never creates a second Invocation or a hidden Thread.
 */
export async function createJobInvocation(
  input: CreateJobInvocationInput,
): Promise<JobInvocationResult> {
  return db.transaction((tx) => createJobInvocationInTransaction(tx, input));
}

export async function createJobInvocationInTransaction(
  tx: Tx,
  input: CreateJobInvocationInput,
): Promise<JobInvocationResult> {
  const [job] = await tx
    .select()
    .from(jobTable)
    .where(and(eq(jobTable.tenantId, input.tenantId), eq(jobTable.id, input.jobId)))
    .for("update")
    .limit(1);
  if (!job) throw new JobExecutionConflictError(`Job 不存在或租户不匹配：${input.jobId}`);

  await validateBindingReferences(tx, input);

  const [existingInvocation] = await tx
    .select()
    .from(invocationTable)
    .where(
      and(eq(invocationTable.tenantId, input.tenantId), eq(invocationTable.jobId, input.jobId)),
    )
    .for("update")
    .limit(1);
  if (existingInvocation) {
    const [existingBinding] = await tx
      .select()
      .from(executionBindingTable)
      .where(
        and(
          eq(executionBindingTable.tenantId, input.tenantId),
          eq(executionBindingTable.invocationId, existingInvocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!existingBinding) {
      throw new JobExecutionConflictError("Job Invocation 已存在但缺少完整 ExecutionBinding");
    }
    if (
      bindingFingerprint(existingBinding) !==
      bindingFingerprint({
        ...input.binding,
        tenantId: input.tenantId,
        invocationId: existingInvocation.id,
      })
    ) {
      throw new JobExecutionConflictError(
        "同一 Job 的 ExecutionBinding 已冻结，不能覆盖为不同执行语义",
      );
    }
    return { job, invocation: existingInvocation, binding: existingBinding, created: false };
  }

  const invocationId = randomUUID();
  const now = new Date();
  await tx.insert(invocationTable).values({
    id: invocationId,
    tenantId: input.tenantId,
    subjectType: "job",
    threadId: null,
    turnId: null,
    jobId: input.jobId,
    triggerItemId: null,
    replacesInvocationId: null,
    outputItemId: null,
    invocationSequence: 1,
    invocationKind: "job",
    executionState: "queued",
    inputDigest: job.inputHash,
    resultRef: null,
    resultDigest: null,
    lastOwnershipEpoch: 0,
    lastProducerSequence: 0,
    recoveryVersion: 0,
    checkpointGate: "open",
    checkpointIntentId: null,
    checkpointOwnerId: null,
    checkpointDeadline: null,
    checkpointProducerSequence: null,
    checkpointRecoveryVersion: null,
    checkpointAnchor: null,
    checkpointPreparedEvidence: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorSummary: null,
    versionNo: 1,
    createdAt: now,
    updatedAt: now,
  });

  await tx.insert(executionBindingTable).values({
    ...input.binding,
    tenantId: input.tenantId,
    invocationId,
    boundAt: now,
  });

  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  const [binding] = await tx
    .select()
    .from(executionBindingTable)
    .where(eq(executionBindingTable.invocationId, invocationId))
    .limit(1);
  if (!invocation || !binding)
    throw new JobExecutionConflictError("Job Invocation/Binding 创建后回查失败");
  return { job, invocation, binding, created: true };
}

async function validateBindingReferences(tx: Tx, input: CreateJobInvocationInput): Promise<void> {
  const binding = input.binding;
  const [workspace] = await tx
    .select({ id: workspaceBinding.id, tenantId: workspaceBinding.tenantId })
    .from(workspaceBinding)
    .where(
      and(
        eq(workspaceBinding.tenantId, input.tenantId),
        eq(workspaceBinding.id, binding.workspaceBindingId),
      ),
    )
    .limit(1);
  if (!workspace)
    throw new JobExecutionConflictError("Job ExecutionBinding 引用的 WorkspaceBinding 不存在");
  if (binding.environmentMode === "MANAGED") {
    if (!binding.environmentDefinitionRevisionId) {
      throw new JobExecutionConflictError("MANAGED Job 必须冻结 EnvironmentDefinitionRevision");
    }
    const [revision] = await tx
      .select({ id: environmentDefinitionRevisionTable.id })
      .from(environmentDefinitionRevisionTable)
      .where(
        and(
          eq(environmentDefinitionRevisionTable.tenantId, input.tenantId),
          eq(environmentDefinitionRevisionTable.id, binding.environmentDefinitionRevisionId),
        ),
      )
      .limit(1);
    if (!revision)
      throw new JobExecutionConflictError("Job ExecutionBinding 引用的 EnvironmentRevision 不存在");
  } else if (binding.environmentDefinitionRevisionId !== null) {
    throw new JobExecutionConflictError("NO_PLATFORM_ENVIRONMENT 不得携带 EnvironmentRevision");
  }
}

function bindingFingerprint(binding: Partial<ExecutionBinding>): string {
  return canonicalizeJson({
    runtimeRevisionId: binding.runtimeRevisionId,
    deploymentRouteId: binding.deploymentRouteId,
    routeRevisionId: binding.routeRevisionId,
    routeActivationId: binding.routeActivationId,
    policyRevisionId: binding.policyRevisionId,
    governanceConfigRevisionId: binding.governanceConfigRevisionId,
    runtimePublicationRecordId: binding.runtimePublicationRecordId,
    conformanceRunId: binding.conformanceRunId,
    modelProvider: binding.modelProvider,
    modelId: binding.modelId,
    workspaceBindingId: binding.workspaceBindingId,
    environmentMode: binding.environmentMode,
    environmentDefinitionRevisionId: binding.environmentDefinitionRevisionId,
    configHash: binding.configHash,
    principalType: binding.principalType,
    principalId: binding.principalId,
    principalSource: binding.principalSource,
    capabilityCatalogDigest: binding.capabilityCatalogDigest,
  });
}

export type { DbOrTx };
