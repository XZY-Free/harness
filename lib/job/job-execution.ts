/** Thread-independent Job execution creation. */
import { randomUUID } from "node:crypto";
import {
  resolveInitialCompression,
  toInitialContextCompression,
} from "@/lib/context/initial-checkpoint-source";
import { db } from "@/lib/db/client";
import {
  type CreateExecutionBindingCommand,
  createCreateExecutionBinding,
} from "@/lib/executions/application/create-execution-binding";
import { computeExecutionBindingConfigHash } from "@/lib/executions/domain/execution-binding";
import { createExecutionBindingStoreInTransaction } from "@/lib/executions/persistence/mysql-execution-binding-store";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import {
  type ExecutionBinding,
  type Invocation,
  executionBindingTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { type Job, jobTable } from "@/lib/persistence/schema/job";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class JobExecutionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobExecutionConflictError";
  }
}

/**
 * 能力目录中必须在 Invocation 行存在之后才能确定的那部分。
 *
 * `snapshot.invocationId` 是冻结能力目录的组成部分（进入 catalog digest），而 Job 的
 * Invocation 是在 Job 根事务内新生成的 —— 因此调用方不能提前给一个占位 id，必须由本模块
 * 在**生成 Invocation 之后、写 Binding 之前**回调取得。
 */
export interface JobCapabilityCatalogFields {
  capabilityCatalogJson: unknown;
  capabilityCatalogDigest: string;
  capabilityCatalogVersion: string;
  capabilityCatalogSourceRefs: string[];
  capabilityCatalogCreatedAt: Date;
}

export type JobCapabilityCatalogBuilder = (
  invocationId: string,
) => JobCapabilityCatalogFields | Promise<JobCapabilityCatalogFields>;

/** Job Binding 的冻结输入字段（不含 tenant/invocation 与能力目录，后两者由本模块补齐）。 */
export type JobBindingCommandFields = Omit<
  CreateExecutionBindingCommand,
  "tenantId" | "invocationId" | keyof JobCapabilityCatalogFields
>;

/**
 * R01 §2：Job 与 Thread 共用同一个 Binding 创建 Authority。
 *
 * 调用方（Job admission lane）只提供**已选定/冻结的解析结果**（路由、Runtime、策略、
 * Workspace、Environment、principal），不提供一条待 INSERT 的台账行，也不提供
 * `configHash`：资格校验、逐条权威行锁、TOCTOU 复验与 Insert 由
 * `createExecutionBindingInTransaction` 在 Job 根事务内完成。
 */
export interface CreateJobInvocationInput {
  tenantId: string;
  jobId: string;
  binding: JobBindingCommandFields;
  capabilityCatalog: JobCapabilityCatalogBuilder;
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

  await assertJobBindingReferences(tx, input);

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
    // 同一 Job 的重复调度只能**返回**已冻结关联，不能覆盖。
    //
    // 判等用完整 `configHash`（与 Thread 路径同一个规范化摘要）而不是字段子集：
    // 只要任一冻结语义（Route/Revision/Publication/Policy/Projection/模型/Workspace/
    // Environment/能力目录/principal/初始压缩材料）不同，就必须冲突而不是静默替换。
    const expectedConfigHash = await computeExpectedConfigHash(tx, input, existingInvocation.id);
    if (existingBinding.configHash !== expectedConfigHash) {
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

  // 与 Thread 路径**同一个** Authority：资格校验 + 逐条行级锁 + TOCTOU 复验 + Insert，
  // 且复用调用方已持有的 Job 根事务（不再另开事务、不再绕过证据流程直接 INSERT）。
  const catalog = await input.capabilityCatalog(invocationId);
  const createBinding = createCreateExecutionBinding({
    store: createExecutionBindingStoreInTransaction(tx),
  });
  const binding = await createBinding({
    ...input.binding,
    ...catalog,
    tenantId: input.tenantId,
    invocationId,
  });
  const [invocation] = await tx
    .select()
    .from(invocationTable)
    .where(eq(invocationTable.id, invocationId))
    .limit(1);
  if (!invocation) throw new JobExecutionConflictError("Job Invocation/Binding 创建后回查失败");
  return { job, invocation, binding, created: true };
}

/**
 * 重投判等：用与创建时完全相同的输入构造 `configHash`。
 *
 * 初始压缩材料必须重新真实读取（存在性/tenant/用途/摘要/来源/有效期/访问权限），
 * 不能只看一个 id —— 否则「同一 Job 换了另一个 Checkpoint 的同名引用」会被误判为同一执行语义。
 */
async function computeExpectedConfigHash(
  tx: Tx,
  input: CreateJobInvocationInput,
  invocationId: string,
): Promise<string> {
  const { initialContextCheckpointId, ...config } = input.binding;
  const compression = initialContextCheckpointId
    ? toInitialContextCompression(
        await resolveInitialCompression({
          tenantId: input.tenantId,
          checkpointId: initialContextCheckpointId,
          requester: { type: config.principalType, id: config.principalId },
        }),
      )
    : null;
  const catalog = await input.capabilityCatalog(invocationId);
  return computeExecutionBindingConfigHash({
    ...config,
    ...catalog,
    initialContextCompression: compression,
  });
}

/**
 * 同租户引用复验：Job Binding 直接落 `workspaceBindingId` 与
 * `environmentDefinitionRevisionId`，因此这两个引用必须是同租户真实行。
 *
 * 初始压缩材料的核验已由 `createCreateExecutionBinding` 统一负责，此处不重复。
 */
async function assertJobBindingReferences(tx: Tx, input: CreateJobInvocationInput): Promise<void> {
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
