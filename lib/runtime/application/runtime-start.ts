import { db } from "@/lib/db/client";
import {
  activateEnvironmentLeaseInTransaction,
  getEnvironmentLeaseById,
  scheduleEnvironmentLeaseCleanup,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import {
  ExecutionAuthorityError,
  authorityIdentity,
  sameAuthority,
} from "@/lib/executions/domain/execution-authority";
import {
  getAttemptById,
  markAttemptPreparedInTransaction,
} from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnershipInTransaction,
  assertAttemptAcceptsNewGeneration,
  getAuthorityDatabaseTime,
  lockInvocationRootIfExists,
} from "@/lib/executions/persistence/execution-ownership-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  InvocationAttempt,
} from "@/lib/persistence/schema/executions";
import {
  INVOCATION_TERMINAL_STATES,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { buildRuntimeStartRequestForInvocation } from "@/lib/runtime/application/build-runtime-start-request";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  createRuntimeSessionBindingInTransaction,
  getRuntimeSessionBindingByOwnership,
  markRuntimeSessionLostByOwnershipInTransaction,
  markRuntimeSessionLostInTransaction,
  updateRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type SessionDispatchClaim,
  recordSessionDispatchAttemptStartedInTransaction,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import type { RuntimeHttpClient, RuntimeStartTransportRequest } from "@/lib/runtime/runtime-client";
import {
  type AuthorityIdentity,
  type CallbackEndpoints,
  type Credentials,
  type Recovery,
  type RuntimeStartResponse,
  buildStartSemanticDigestInput,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import { restoreFilesystemCheckpoint } from "@/lib/workspace/checkpoint-restore";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { getWorkspaceBindingById } from "@/lib/workspace/workspace-queries";
import { requestWorkspaceWriterRelease } from "@/lib/workspace/workspace-write-lock-queries";
import {
  type PreparedWorkspaceCandidate,
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
} from "@/lib/workspace/workspace-writer";
import { runWorkspaceWriterRelease } from "@/lib/workspace/workspace-writer-release";
import { and, eq, sql } from "drizzle-orm";

export interface RuntimeStartInput {
  tenantId: string;
  invocation: Invocation;
  binding: ExecutionBinding;
  attempt: InvocationAttempt;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpoint: string;
  auth: RuntimeStartTransportRequest["auth"];
  callbackEndpoints: CallbackEndpoints;
  environmentLeaseId?: string | null;
  /**
   * Session dispatch claim（R04 §5）：由持久维护 lane 领取时提供。
   * 所有 dispatch 完成确认（计数、暂态失败排定）都按该 claim 身份复核；
   * 请求内联路径为 `null`（无 lease，只按 Session 自身冻结 tuple 复核）。
   */
  sessionDispatchClaim?: SessionDispatchClaim | null;
  /**
   * 受管 EnvironmentProvisioner：用于真实释放该 Lease 已创建的资源。
   * 未提供时环境失败只登记控制面清理工作（不允许伪装成"资源已释放"）。
   */
  environmentProvisioner?: EnvironmentProvisioner | null;
  workspace?: WorkspaceExecutionResources;
  intentType?: "start" | "resume";
  recovery?: Recovery;
  now?: Date;
  /**
   * Job-backed Invocation 的输入冻结校验：调用方（领域解析器）解析出的输入摘要。
   * 与 Invocation.inputDigest（创建时冻结的 job.inputHash）不一致则禁止 Runtime 启动。
   */
  expectedInputDigest?: string | null;
}

export interface RuntimeStartResult {
  authority: AuthorityIdentity;
  response: RuntimeStartResponse;
  sessionBindingId: string;
}

export function buildExecutionCredentials(
  tenantId: string,
  authority: AuthorityIdentity,
): Credentials {
  const expiresAt = Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime;
  const base = {
    contractVersion: 3 as const,
    type: "execution" as const,
    tenantId,
    ...authority,
    expiresAt,
  };
  return {
    runtimeToken: issueWorkloadToken({ ...base, audience: "runtime" }),
    gatewayToken: issueWorkloadToken({ ...base, audience: "gateway" }),
    expiresAt,
  };
}

/** Candidate preparation, ownership fencing, physical writer activation, durable intent registration, then transport. */
export async function startRuntimeInvocation(
  input: RuntimeStartInput,
): Promise<RuntimeStartResult> {
  const now = input.now ?? new Date();
  const workspaceBinding =
    input.workspace?.binding ??
    (await getWorkspaceBindingById(input.tenantId, input.binding.workspaceBindingId));
  if (!workspaceBinding) throw new Error("WorkspaceNotReady");
  if (workspaceBinding.id !== input.binding.workspaceBindingId)
    throw new Error("WorkspaceNotReady");
  // Job 输入持久冻结：解析内容摘要与冻结摘要不一致 → 禁止 Runtime 启动。
  // （纯参数校验必须先于发布事实加载，失败语义以输入冻结优先。）
  if (
    input.expectedInputDigest !== undefined &&
    (input.invocation.inputDigest ?? null) !== input.expectedInputDigest
  ) {
    throw new Error("InputDigestMismatch");
  }
  if (input.binding.environmentMode === "MANAGED" && !input.environmentLeaseId)
    throw new Error("EnvironmentRevisionMismatch");
  if (input.binding.environmentMode === "NO_PLATFORM_ENVIRONMENT" && input.environmentLeaseId)
    throw new Error("EnvironmentRevisionMismatch");
  if (input.environmentLeaseId) {
    const environmentLease = await getEnvironmentLeaseById(
      input.tenantId,
      input.environmentLeaseId,
    );
    if (
      !environmentLease ||
      environmentLease.invocationId !== input.invocation.id ||
      environmentLease.attemptId !== input.attempt.id ||
      environmentLease.environmentDefinitionRevisionId !==
        input.binding.environmentDefinitionRevisionId
    ) {
      throw new Error("EnvironmentRevisionMismatch");
    }
  }
  // A03-05：**终态 Attempt 不可承载新代际**。判据必须按真实回读、并**先于任何写入**求值：
  // 旧实现只在 `prepareChecks`（准备槽已写、Workspace 候选已登记）之后才拦，于是死了的代际
  // 会先被写脏再被拒绝，还会留下没有清理义务的 Workspace 候选。生产各 Start 调用方一律先
  // `createAttempt`（`dispatcher` / `redispatchRuntimeInvocation` /
  // `dispatch-queued-invocation-attempt`），这里把该不变量显式化，不新增任何合法路径。
  const declaredAttempt = await getAttemptById(input.attempt.id);
  if (!declaredAttempt || declaredAttempt.invocationId !== input.invocation.id) {
    throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不属于该 Invocation");
  }
  assertAttemptAcceptsNewGeneration(declaredAttempt);
  // 发布事实（RuntimeRevision capability manifest）是 External start 一致性的真值源。
  // 在输入冻结与环境校验之后加载——pure 校验失败语义优先。
  const runtimeRevision = await getRuntimeRevisionById(input.binding.runtimeRevisionId);
  if (!runtimeRevision) throw new Error("RuntimeRevision 不存在");
  const publishedCapabilityManifestDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: runtimeRevision.id,
    runtimeCapabilitiesJson: runtimeRevision.runtimeCapabilitiesJson,
  });
  const needsWorkspaceWriter = workspaceBinding.continuityMode !== "NO_PLATFORM_WORKSPACE";
  // 无受管 WorkspaceBackend 时按 Binding 冻结事实启动（桌面绑定冻结语义）；
  // Workspace Writer/准备证据由 capability action 执行期按需取得。
  const workspaceCandidate: PreparedWorkspaceCandidate | null =
    needsWorkspaceWriter && input.workspace
      ? await prepareWorkspaceCandidate({
          attemptId: input.attempt.id,
          binding: workspaceBinding,
          backend: input.workspace.backend,
          root: input.workspace.root,
          operationId: `workspace:${input.attempt.id}`,
          runtimeRevisionId: input.binding.runtimeRevisionId,
        })
      : null;
  let restoration: {
    checkpointId: string;
    manifestDigest: string;
    /** 该 Checkpoint 的输入水位：恢复后从这里之后继续消费新输入。 */
    replayFromProducerSequence: number;
    /**
     * 实际恢复落地的目录 —— §4 要求"授权运行的 root 必须与这个目录/generation 一致"，
     * 因此 ready 回执里必须同时钉住目录与 generation，而不是只记一个 checkpointId。
     */
    restoredRoot: string;
  } | null = null;
  if (
    input.recovery?.kind === "resume" &&
    workspaceBinding.continuityMode === "CHECKPOINT_RESTORABLE"
  ) {
    if (
      !input.recovery.checkpointId ||
      !input.workspace ||
      !input.binding.environmentDefinitionRevisionId ||
      !workspaceCandidate ||
      input.invocation.checkpointRecoveryVersion === null
    ) {
      if (workspaceCandidate)
        await workspaceCandidate.backend.host
          .cleanup(workspaceCandidate.preparation)
          .catch(() => undefined);
      throw new Error("CheckpointStale");
    }
    try {
      const restored = await restoreFilesystemCheckpoint({
        tenantId: input.tenantId,
        checkpointId: input.recovery.checkpointId,
        destination: workspaceCandidate.preparation.candidateRoot,
        storage: input.workspace.snapshotStorage,
        backend: input.workspace.backend,
        expected: {
          invocationId: input.invocation.id,
          workspaceBindingId: workspaceBinding.id,
          environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId,
          // §4：判据是**当前** Invocation 水位，不是 Checkpoint 自己记载的水位。
          // 用后者会形成"与自身比较"的恒真校验，Checkpoint 之后已应用的新事实
          // 就再也拦不住，陈旧快照会被当成可恢复。
          recoveryVersion: input.invocation.recoveryVersion,
        },
      });
      restoration = {
        checkpointId: restored.checkpointId,
        manifestDigest: restored.manifestDigest,
        replayFromProducerSequence: restored.replayFromProducerSequence,
        restoredRoot: restored.destination,
      };
    } catch (error) {
      await workspaceCandidate.backend.host
        .cleanup(workspaceCandidate.preparation)
        .catch(() => undefined);
      throw error;
    }
  }
  const preparedAttempt = await db.transaction(async (tx) => {
    // A01：每个真实事务都先锁 Invocation 根（固定锁图 Invocation → Attempt → Ownership → …）。
    // 本事务会写 InvocationAttempt，不能只对 Attempt 行取锁后离开。
    if (!(await lockInvocationRootIfExists(tx, input.tenantId, input.invocation.id))) {
      throw new ExecutionAuthorityError("NotCurrentExecutor", "Invocation 不存在或不可见");
    }
    const evidence = {
      kind: "candidate-prepared",
      invocationId: input.invocation.id,
      attemptId: input.attempt.id,
      runtimeRevisionId: input.binding.runtimeRevisionId,
      workspace: workspaceCandidate
        ? {
            resourceId: workspaceCandidate.preparation.resourceId,
            operationId: workspaceCandidate.operationId,
            bindingId: workspaceBinding.id,
            restoration,
          }
        : { mode: "NO_PLATFORM_WORKSPACE" },
    };
    return markAttemptPreparedInTransaction(tx, {
      attemptId: input.attempt.id,
      evidence,
      digest: protocolDigest(evidence),
      now,
    });
  });
  // A05：本次取得执行权所依据的恢复水位。必须在 **Acquire 之前**确定：`prepareChecks`
  // 会用它与 Lease 上的 Prepared 证据比对，写死 `null` 会让正式 Resume 被判成
  // "恢复 Anchor 已变化"（同一份事实两套判据）。
  const recoveryAnchorDigest =
    input.recovery?.kind === "resume" ? input.recovery.anchorDigest : null;
  const result = await db.transaction(async (tx) => {
    // A01 §1：本事务此前先 `SELECT ExecutionOwnership … FOR UPDATE` 再经
    // `acquireExecutionOwnershipInTransaction` 去锁 Invocation，与「先锁 I 再锁 O」的
    // 心跳/守卫构成真实等待环。这里先无条件取得 Invocation 根锁，之后再按固定顺序
    // 重新加载 Attempt → Owner → Session，并由这些**当前行**决定重放/换代/拒绝。
    const lockedInvocation = await lockInvocationRootIfExists(
      tx,
      input.tenantId,
      input.invocation.id,
    );
    if (!lockedInvocation)
      throw new ExecutionAuthorityError("NotCurrentExecutor", "Invocation 不存在或不可见");
    if (INVOCATION_TERMINAL_STATES.includes(lockedInvocation.executionState)) {
      throw new ExecutionAuthorityError(
        "NotCurrentExecutor",
        `Invocation 已终态（${lockedInvocation.executionState}），不可取得执行权`,
      );
    }
    // 根锁下重新加载 Attempt：复核它确实属于本 Invocation，且处于可承载执行权的阶段。
    const [lockedAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, input.attempt.id),
          eq(invocationAttemptTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedAttempt || lockedAttempt.id !== preparedAttempt.id) {
      throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不属于该 Invocation");
    }
    const nowAtAuthority = await getAuthorityDatabaseTime(tx);
    const [existingOwnership] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.invocationId, input.invocation.id),
          eq(executionOwnershipTable.ownershipState, "active"),
        ),
      )
      .for("update")
      .limit(1);
    let ownership: ExecutionOwnership;
    if (existingOwnership && existingOwnership.leaseExpiresAt > nowAtAuthority) {
      const existingSession = await getRuntimeSessionBindingByOwnership(
        input.tenantId,
        existingOwnership.id,
        tx,
      );
      if (
        input.intentType === "resume" &&
        existingSession &&
        existingSession.intentType !== "resume"
      ) {
        // 正式 Resume：保持 suspended Attempt，但总是换新所有权代际与新 SessionBinding；
        // 旧代际 released（Session lost），不经过 takeover 的 Attempt-lost 路径。
        await tx
          .update(executionOwnershipTable)
          .set({
            ownershipState: "released",
            releasedAt: nowAtAuthority,
            reasonCode: "resume_redispatch",
            versionNo: existingOwnership.versionNo + 1,
            updatedAt: nowAtAuthority,
          })
          .where(eq(executionOwnershipTable.id, existingOwnership.id));
        await markRuntimeSessionLostByOwnershipInTransaction(
          tx,
          input.tenantId,
          existingOwnership.id,
        );
        const ownershipResult = await acquireExecutionOwnershipInTransaction(tx, {
          tenantId: input.tenantId,
          invocationId: input.invocation.id,
          attemptId: preparedAttempt.id,
          runtimeRevisionId: input.binding.runtimeRevisionId,
          environmentLeaseId: input.environmentLeaseId ?? null,
          acquiredByType: "service",
          acquiredById: "runtime-start",
          recoveryAnchorDigest,
          activationEvidence: {
            workspace: "not-yet-required",
            runtimeRevisionId: input.binding.runtimeRevisionId,
          },
        });
        ownership = ownershipResult.ownership;
      } else {
        if (
          existingOwnership.attemptId !== preparedAttempt.id ||
          (existingOwnership.activationEvidence &&
            input.binding.runtimeRevisionId !==
              (existingOwnership.activationEvidence as { runtimeRevisionId?: string })
                .runtimeRevisionId)
        ) {
          throw new Error("HealthyOwnerExists");
        }
        ownership = existingOwnership;
      }
    } else {
      const ownershipResult = await acquireExecutionOwnershipInTransaction(tx, {
        tenantId: input.tenantId,
        invocationId: input.invocation.id,
        attemptId: preparedAttempt.id,
        runtimeRevisionId: input.binding.runtimeRevisionId,
        environmentLeaseId: input.environmentLeaseId ?? null,
        acquiredByType: "service",
        acquiredById: "runtime-start",
        recoveryAnchorDigest,
        activationEvidence: {
          workspace: "not-yet-required",
          runtimeRevisionId: input.binding.runtimeRevisionId,
        },
      });
      ownership = ownershipResult.ownership;
    }
    let session = await getRuntimeSessionBindingByOwnership(input.tenantId, ownership.id, tx);
    if (!session) {
      session = await createRuntimeSessionBindingInTransaction(tx, {
        tenantId: input.tenantId,
        invocationId: input.invocation.id,
        attemptId: preparedAttempt.id,
        ownershipId: ownership.id,
        runtimeRevisionId: input.binding.runtimeRevisionId,
        leaseEpoch: ownership.leaseEpoch,
        intentType: input.intentType ?? "start",
        startIntentKey: `start:${ownership.id}`,
        // External start capabilities 成为 RuntimeSessionBinding / effective capability 事实。
        runtimeCapabilitiesJson: runtimeRevision.runtimeCapabilitiesJson,
      });
    }
    if (
      session.attemptId !== preparedAttempt.id ||
      session.runtimeRevisionId !== input.binding.runtimeRevisionId ||
      session.leaseEpoch !== ownership.leaseEpoch ||
      session.intentType !== (input.intentType ?? "start") ||
      ["closed", "lost"].includes(session.bindingState)
    ) {
      throw new Error("RuntimeSessionMismatch");
    }
    return { ownership, session };
  });
  let ownership = result.ownership;
  const session = result.session;
  let activatedWorkspace: Awaited<ReturnType<typeof activatePreparedWorkspaceWriter>> | null = null;
  try {
    if (ownership.executionPhase === "activating") {
      // 顺序不变量（repairs/06-environment.md §4）：先真实激活 Workspace Writer，
      // 再在同一个 Current Ownership 事务内交接 Environment Lease（prepared→ready）。
      // 不允许在 Writer 激活前写 readiness=ready。
      if (workspaceCandidate) {
        const candidateAuthority = authorityIdentity({
          invocationId: input.invocation.id,
          runtimeRevisionId: input.binding.runtimeRevisionId,
          attemptId: preparedAttempt.id,
          ownershipId: ownership.id,
          leaseEpoch: ownership.leaseEpoch,
          sessionBindingId: session.id,
        });
        activatedWorkspace = await activatePreparedWorkspaceWriter({
          tenantId: input.tenantId,
          invocationId: input.invocation.id,
          attemptId: preparedAttempt.id,
          ownership,
          authority: candidateAuthority,
          candidate: restoration
            ? { ...workspaceCandidate, root: workspaceCandidate.preparation.candidateRoot }
            : workspaceCandidate,
        });
      }
      ownership = await db.transaction(async (tx) => {
        const [invocation] = await tx
          .select({ id: invocationTable.id })
          .from(invocationTable)
          .where(
            and(
              eq(invocationTable.tenantId, input.tenantId),
              eq(invocationTable.id, input.invocation.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!invocation) throw new Error("Invocation 不存在");
        const [current] = await tx
          .select()
          .from(executionOwnershipTable)
          .where(
            and(
              eq(executionOwnershipTable.tenantId, input.tenantId),
              eq(executionOwnershipTable.id, result.ownership.id),
              eq(executionOwnershipTable.invocationId, input.invocation.id),
              eq(executionOwnershipTable.ownershipState, "active"),
            ),
          )
          .for("update")
          .limit(1);
        if (!current || current.leaseEpoch !== result.ownership.leaseEpoch)
          throw new Error("NotCurrentExecutor");
        let environmentLease: Awaited<
          ReturnType<typeof activateEnvironmentLeaseInTransaction>
        > | null = null;
        if (input.environmentLeaseId) {
          if (current.environmentLeaseId !== input.environmentLeaseId)
            throw new Error("EnvironmentRevisionMismatch");
          if (!input.binding.environmentDefinitionRevisionId)
            throw new Error("EnvironmentRevisionMismatch");
          // Current Ownership 事务内复核：Lease 确属本 Attempt/Revision/Binding/恢复水位，
          // prepared 未过期且未被释放，才写 ready + activationOwnershipId。
          environmentLease = await activateEnvironmentLeaseInTransaction(tx, {
            tenantId: input.tenantId,
            leaseId: input.environmentLeaseId,
            ownershipId: current.id,
            attemptId: preparedAttempt.id,
            invocationId: input.invocation.id,
            environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId,
            recoveryAnchorDigest,
          });
        }
        const activationEvidence = {
          kind: "execution-activated",
          invocationId: input.invocation.id,
          attemptId: preparedAttempt.id,
          ownershipId: current.id,
          leaseEpoch: String(current.leaseEpoch),
          runtimeRevisionId: input.binding.runtimeRevisionId,
          environmentLeaseId: input.environmentLeaseId ?? null,
          environment: environmentLease
            ? {
                readinessState: environmentLease.readinessState,
                leaseState: environmentLease.leaseState,
                activationOwnershipId: environmentLease.activationOwnershipId,
                preparedDigest: environmentLease.preparedDigest,
                workerRef: environmentLease.workerRef,
                hostIdentity: environmentLease.hostIdentity,
                storageIdentity: environmentLease.storageIdentity,
              }
            : null,
          workspace: activatedWorkspace
            ? {
                mode: workspaceBinding.continuityMode,
                lockId: activatedWorkspace.lockId,
                writerGeneration: activatedWorkspace.writerGeneration,
                grantRef: activatedWorkspace.grant.grantRef,
                backendEvidence: activatedWorkspace.grant.backendEvidence,
              }
            : { mode: workspaceBinding.continuityMode, workspaceBindingId: workspaceBinding.id },
        };
        await tx
          .update(executionOwnershipTable)
          .set({
            executionPhase: "dispatching",
            workspaceWriterGeneration: activatedWorkspace?.writerGeneration ?? null,
            activationEvidence,
            activationDigest: protocolDigest(activationEvidence),
            activatedAt: new Date(),
            versionNo: current.versionNo + 1,
            updatedAt: new Date(),
          })
          .where(eq(executionOwnershipTable.id, current.id));
        const [updated] = await tx
          .select()
          .from(executionOwnershipTable)
          .where(eq(executionOwnershipTable.id, current.id))
          .limit(1);
        if (!updated) throw new Error("ExecutionOwnership 激活后回查失败");
        return updated;
      });
    } else if (workspaceCandidate) {
      await workspaceCandidate.backend.host
        .cleanup(workspaceCandidate.preparation)
        .catch(() => undefined);
    }
  } catch (error) {
    await closeRuntimeSessionAfterActivationFailure(
      input.tenantId,
      input.invocation.id,
      session.id,
    ).catch(() => undefined);
    if (activatedWorkspace) {
      // R04 §3：失败补偿也只写**持久**释放请求，不在这里直接写控制面 released。
      // 物理 stop/drain 由正式 Worker 的释放 lane 按 W→I 顺序完成；这里顺带跑一轮
      // 让它尽快收敛，失败则留给 lane 退避重试（可见性来自持久状态）。
      await requestWorkspaceWriterRelease({
        tenantId: input.tenantId,
        lockId: activatedWorkspace.lockId,
        ownershipId: ownership.id,
        reasonCode: "activation_failed",
      }).catch(() => undefined);
      await runWorkspaceWriterRelease({
        tenantId: input.tenantId,
        lockId: activatedWorkspace.lockId,
        leaseOwner: `activation-failure:${ownership.id}`,
        deps: workspaceCandidate
          ? { resolveHost: async () => workspaceCandidate.backend.host }
          : undefined,
      }).catch(() => undefined);
    }
    await closeOwnershipAfterActivationFailure(input, ownership.id).catch(() => undefined);
    if (input.environmentLeaseId) {
      // 真实资源清理优先：控制面 released 必须对应真实释放回执。
      // 第一次失败 → 保持 releasing + 退避重试（清理 Worker 继续），不吞掉 Backend 错误。
      await cleanupEnvironmentAfterActivationFailure(
        {
          tenantId: input.tenantId,
          environmentLeaseId: input.environmentLeaseId,
          environmentProvisioner: input.environmentProvisioner ?? null,
        },
        "activation_failed",
      );
    }
    if (workspaceCandidate && !activatedWorkspace)
      await workspaceCandidate.backend.host
        .cleanup(workspaceCandidate.preparation)
        .catch(() => undefined);
    throw error;
  }
  const authority = authorityIdentity({
    invocationId: input.invocation.id,
    runtimeRevisionId: input.binding.runtimeRevisionId,
    attemptId: preparedAttempt.id,
    ownershipId: ownership.id,
    leaseEpoch: ownership.leaseEpoch,
    sessionBindingId: session.id,
  });
  const request = await buildRuntimeStartRequestForInvocation({
    tenantId: input.tenantId,
    invocation: input.invocation,
    binding: input.binding,
    authority,
    credentials: buildExecutionCredentials(input.tenantId, authority),
    runtimeEndpoint: input.runtimeEndpoint,
    callbackEndpoints: input.callbackEndpoints,
    intentType: input.intentType ?? "start",
    recovery: input.recovery,
    activationEvidenceRef:
      ownership.activationDigest ?? protocolDigest(ownership.activationEvidence),
    attempt: { producerSequenceStart: input.invocation.lastProducerSequence + 1 },
    // R02 §1：重试读回已冻结语义请求（首派发时为 null，由水位推导后一次写死）。
    frozenSemanticRequest: session.semanticRequestJson,
    now,
  });
  const dispatchClaim = input.sessionDispatchClaim ?? null;
  if (dispatchClaim && dispatchClaim.sessionBindingId !== session.id) {
    throw new Error("SessionDispatchClaimSuperseded");
  }
  // R02 §1：重试/重放会轮换短期凭据、ContextHandle 签名时间与 Trace —— 轮换后**必须**用
  // 冻结值重新校验语义 digest。相等即证明旋转只动了非语义域（凭据/签名时间/连接）；
  // 不等则说明业务内容被一起改了，必须 fail closed，绝不带病发出 Start。
  if (
    session.semanticRequestDigest &&
    request.request.semanticRequestDigest !== session.semanticRequestDigest
  ) {
    throw new Error("StartIntentConflict");
  }
  // R02 §1/§8：锁定 Invocation 根，把「派发尝试计数 + 语义请求一次冻结」写在同一事务里。
  // 语义请求冻结后，所有重试都读这份已持久事实（不再重新挑选 producerSequenceStart /
  // Context Subject / Model / Environment / Workspace / Resume Anchor）。
  await db.transaction(async (tx) => {
    const [lockedInvocation] = await tx
      .select({ id: invocationTable.id })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedInvocation) throw new Error("Invocation 不存在");
    const recorded = await recordSessionDispatchAttemptStartedInTransaction(
      tx,
      {
        tenantId: input.tenantId,
        sessionBindingId: session.id,
        attemptId: preparedAttempt.id,
        ownershipId: ownership.id,
        leaseEpoch: ownership.leaseEpoch,
        claimToken: dispatchClaim?.claimToken ?? null,
      },
      now,
    );
    await updateRuntimeSessionDispatchInTransaction(tx, {
      tenantId: input.tenantId,
      id: session.id,
      expectedVersionNo: recorded.session.versionNo,
      patch: {
        semanticRequestJson: buildStartSemanticDigestInput(request.request),
        semanticRequestDigest: request.request.semanticRequestDigest,
        lastErrorCode: null,
      },
    });
  });
  const transportRequest = {
    runtimeEndpoint: input.runtimeEndpoint,
    auth: input.auth,
    // canonical 不变量：start idempotency key 与 session.startIntentKey 同源
    //（runtime-session-store.createRuntimeSessionBinding 强制 start:${ownershipId}）。
    idempotencyKey: `start:${ownership.id}`,
    request: request.request,
  };
  const response =
    input.intentType === "resume"
      ? await input.runtimeClient.resumeInvocation(transportRequest)
      : await input.runtimeClient.startInvocation(transportRequest);
  if (
    response.semanticRequestDigest !== request.request.semanticRequestDigest ||
    !sameAuthority(response.authority, authority)
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  // R02 §3：Runtime 回执的 capabilitiesDigest 必须等于**发布证据**（RuntimeRevision
  // 冻结 manifest）摘要，否则 fail-closed（dispatch 可能已开始）。不区分 in-process：
  // Hosted 也必须由同一发布事实给出摘要，不存在免校验分支。
  if (response.capabilitiesDigest !== publishedCapabilityManifestDigest) {
    throw new RuntimeHttpClientError(
      "protocol",
      "RUNTIME_CAPABILITY_MISMATCH",
      undefined,
      undefined,
      {
        stableCode: "RUNTIME_CAPABILITY_MISMATCH",
        retryable: false,
        dispatchPossiblyStarted: true,
      },
    );
  }
  // R02 §8：ACK 写入同样走仓储方法并在 Invocation 根锁内完成（CAS 防迟到 ACK）。
  const sessionAfterAck = await db.transaction(async (tx) => {
    const [lockedInvocation] = await tx
      .select({ id: invocationTable.id })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedInvocation) throw new Error("Invocation 不存在");
    return updateRuntimeSessionDispatchInTransaction(tx, {
      tenantId: input.tenantId,
      id: session.id,
      // 单调合并：`execution.started` 可能已先于本 ACK 到达（callback-before-ACK），
      // 此时 Session 已 active 且版本前移——ACK 只补远端引用与 Transport 结果，不判迟到冲突。
      patch: {
        remoteSessionRef: response.remoteSessionRef,
        remoteExecutionRef: response.remoteExecutionRef,
        transportAcknowledgement: response,
        acknowledgedAt: new Date(response.acceptedAt),
      },
    });
  });
  return { authority, response, sessionBindingId: sessionAfterAck.id };
}

/**
 * 激活失败后的 Environment 资源收口（repairs/06-environment.md §5）。
 *
 * 真实释放优先：有 Provisioner 时直接调用它做"真实释放 + 失败留待重试"；
 * 没有 Provisioner 时至少登记持久清理工作（`releasing` + 退避），
 * **绝不**把控制面写成 released 而真实资源仍在。
 */
async function cleanupEnvironmentAfterActivationFailure(
  input: {
    tenantId: string;
    environmentLeaseId: string;
    environmentProvisioner: EnvironmentProvisioner | null;
  },
  reasonCode: string,
): Promise<void> {
  const provisioner = input.environmentProvisioner;
  if (!provisioner) {
    await scheduleEnvironmentLeaseCleanup({
      tenantId: input.tenantId,
      leaseId: input.environmentLeaseId,
      errorCode: reasonCode,
    }).catch(() => undefined);
    return;
  }
  await provisioner
    .cleanup({ tenantId: input.tenantId, leaseId: input.environmentLeaseId, reasonCode })
    .catch(() => undefined);
}

async function closeOwnershipAfterActivationFailure(
  input: RuntimeStartInput,
  ownershipId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [invocation] = await tx
      .select({ id: invocationTable.id })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) return;
    const [current] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, ownershipId),
          eq(executionOwnershipTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!current || current.ownershipState !== "active") return;
    await tx
      .update(executionOwnershipTable)
      .set({
        ownershipState: "lost",
        releasedAt: new Date(),
        reasonCode: "WorkspaceNotReady",
        executionPhase: "activating",
        versionNo: current.versionNo + 1,
        updatedAt: new Date(),
      })
      .where(eq(executionOwnershipTable.id, current.id));
  });
}

async function closeRuntimeSessionAfterActivationFailure(
  tenantId: string,
  invocationId: string,
  sessionBindingId: string,
): Promise<void> {
  // R02 §8：Session 状态写入只经仓储方法（真实事务 + 行锁 + 单向转换表）。
  // A01：Session 写入同样必须先持 Invocation 根锁（I → S），不能只锁 Session 自身。
  await db.transaction(async (tx) => {
    if (!(await lockInvocationRootIfExists(tx, tenantId, invocationId))) return;
    await markRuntimeSessionLostInTransaction(tx, { tenantId, id: sessionBindingId });
  });
}
