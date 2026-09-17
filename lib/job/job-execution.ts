/** Thread-independent Job execution creation. */
import { randomUUID } from "node:crypto";
import { resolveInitialCompression } from "@/lib/context/initial-checkpoint-source";
import { db } from "@/lib/db/client";
import {
  type CreateExecutionBindingCommand,
  createCreateExecutionBinding,
} from "@/lib/executions/application/create-execution-binding";
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
import {
  type CapabilityCatalogSnapshot,
  computeCapabilityCatalogDigest,
} from "@/lib/runtime/harness-loop/capability-catalog";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 已冻结 Binding 行（回读形态）。 */
type FrozenBindingRow = typeof executionBindingTable.$inferSelect;

/**
 * 目录内容判等时用来替换「冻结时刻」的常量。
 *
 * 能力目录快照的 `createdAt` 记录的是**本次构建**的时刻，属于冻结动作的证据，
 * 不属于执行语义；判等时两侧都替换为同一常量，得到与构建时刻无关的内容摘要。
 */
const CATALOG_MOMENT_PLACEHOLDER = "1970-01-01T00:00:00.000Z";

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
    // R06 §2：判等必须在「执行语义选择」上进行。`computeExecutionBindingConfigHash`
    // 把**本次冻结动作**的证据时间戳（`principalFrozenAt` /
    // `capabilityCatalogCreatedAt`）也纳入 digest —— 它们对同一次冻结是有效身份，
    // 但每次解析都会产生新值。若拿重算的 `configHash` 与已冻结的比，
    // 「返回已冻结关联」这条路径在任何重投下都会变成语义冲突（等价于该分支不可达）。
    // 因此这里逐项比对冻结**选择**，冻结**时刻**不参与判等。
    await assertSameFrozenSemantics(input, existingBinding);
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
 * 重投判等：本次解析出的执行语义选择是否与已冻结的 Binding 完全一致。
 *
 * 事实源：R06 §2「重复调度返回已冻结关联，绝不新建第二条」。判等只覆盖**选择**：
 *
 * - 参与判等：Runtime/Route/Publication/Policy/Governance/模型/WorkspaceEnvironment/
 *   Projection/principal/能力目录/初始压缩材料引用，以及控制面四条解析证据。
 * - 不参与判等：`principalFrozenAt` 与 `capabilityCatalogCreatedAt` —— 它们是
 *   "本次冻结动作"的证据时间戳，每次解析必然不同。
 *
 * 不变量：
 * - 任一冻结选择不同即冲突，不得静默替换（不是"放宽为字段子集"，被排除的只有时刻）。
 * - 初始压缩材料与能力目录都必须**真实重建**（存在性/tenant/用途/摘要/来源/权限），
 *   不能只看 id，否则「同一 Job 换了另一个 Checkpoint 的同名引用」会被误判为等价。
 */
async function assertSameFrozenSemantics(
  input: CreateJobInvocationInput,
  frozen: FrozenBindingRow,
): Promise<void> {
  const { initialContextCheckpointId, ...config } = input.binding;
  // 初始压缩材料重新真实读取：存在性/tenant/用途/摘要/来源/有效期/访问权限。
  if (initialContextCheckpointId) {
    await resolveInitialCompression({
      tenantId: input.tenantId,
      checkpointId: initialContextCheckpointId,
      requester: { type: config.principalType, id: config.principalId },
    });
  }
  const catalog = await input.capabilityCatalog(frozen.invocationId);

  const deviations: string[] = [];
  const same = (label: string, left: unknown, right: unknown) => {
    if (left !== right) deviations.push(label);
  };
  same("runtimeRevisionId", config.runtimeRevisionId, frozen.runtimeRevisionId);
  same("deploymentRouteId", config.deploymentRouteId, frozen.deploymentRouteId);
  same("modelProvider", config.modelProvider, frozen.modelProvider);
  same("modelId", config.modelId, frozen.modelId);
  same("modelRevisionRef", config.modelRevisionRef ?? null, frozen.modelRevisionRef ?? null);
  same("workspaceBindingId", config.workspaceBindingId, frozen.workspaceBindingId);
  same("policyRevisionId", config.policyRevisionId, frozen.policyRevisionId);
  same("policyRulesDigest", config.policyRulesDigest, frozen.policyRulesDigest);
  same(
    "governanceConfigRevisionId",
    config.governanceConfigRevisionId,
    frozen.governanceConfigRevisionId,
  );
  same("governanceConfigDigest", config.governanceConfigDigest, frozen.governanceConfigDigest);
  same(
    "environmentDefinitionRevisionId",
    config.environmentDefinitionRevisionId ?? null,
    frozen.environmentDefinitionRevisionId ?? null,
  );
  same("environmentMode", config.environmentMode, frozen.environmentMode);
  same("projectionVersionNo", config.projectionVersionNo, Number(frozen.projectionVersionNo));
  same("principalType", config.principalType, frozen.principalType);
  same("principalId", config.principalId, frozen.principalId);
  same("principalSource", config.principalSource, frozen.principalSource);
  same(
    "initialContextCheckpointId",
    initialContextCheckpointId ?? null,
    frozen.initialContextCheckpointId ?? null,
  );
  same(
    "controlPlane.routeRevisionId",
    config.controlPlaneEvidence.routeRevisionId,
    frozen.routeRevisionId,
  );
  same(
    "controlPlane.routeActivationId",
    config.controlPlaneEvidence.routeActivationId,
    frozen.routeActivationId,
  );
  same(
    "controlPlane.routeContentDigest",
    config.controlPlaneEvidence.routeContentDigest,
    frozen.routeContentDigest,
  );
  same(
    "controlPlane.resolutionInputDigest",
    config.controlPlaneEvidence.resolutionInputDigest,
    frozen.resolutionInputDigest,
  );
  same(
    "controlPlane.runtimeEvidenceKind",
    config.controlPlaneEvidence.runtimeEvidenceKind,
    frozen.runtimeEvidenceKind,
  );
  // 能力目录按**内容**判等，而不是按 `capabilityCatalogDigest` —— 该 digest 覆盖了
  // `snapshot.createdAt`（本次构建的时刻），因此两次解析必然不同。目录里真正属于
  // "执行语义"的是 version / 授权工具 / Agent / 知识源 / 来源集合 / 不可用事实，
  // 这些由 `computeCapabilityCatalogDigest` 的规范摘要稳定覆盖：
  // 把冻结时刻替换为常量后再求摘要，就得到「与构建时刻无关的目录内容摘要」。
  // （目录快照是 MySQL JSON 列，回读会重排键序；规范摘要本身就按 key 排序，天然免疫。）
  same(
    "capabilityCatalog",
    computeCapabilityCatalogDigest({
      ...(catalog.capabilityCatalogJson as CapabilityCatalogSnapshot),
      createdAt: CATALOG_MOMENT_PLACEHOLDER,
    }),
    computeCapabilityCatalogDigest({
      ...(frozen.capabilityCatalogJson as CapabilityCatalogSnapshot),
      createdAt: CATALOG_MOMENT_PLACEHOLDER,
    }),
  );
  same(
    "capabilityCatalogVersion",
    catalog.capabilityCatalogVersion,
    frozen.capabilityCatalogVersion,
  );
  same(
    "capabilityCatalogSourceRefs",
    [...catalog.capabilityCatalogSourceRefs].sort().join("\u0000"),
    [...frozen.capabilityCatalogSourceRefs].sort().join("\u0000"),
  );

  if (deviations.length > 0) {
    throw new JobExecutionConflictError(
      `同一 Job 的 ExecutionBinding 已冻结，不能覆盖为不同执行语义（差异项：${deviations.join(", ")}）`,
    );
  }
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
