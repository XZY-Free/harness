import { db } from "@/lib/db/client";
import {
  activateEnvironmentLease,
  getEnvironmentLeaseById,
  scheduleEnvironmentLeaseCleanup,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { authorityIdentity, sameAuthority } from "@/lib/executions/domain/execution-authority";
import { markAttemptPreparedInTransaction } from "@/lib/executions/persistence/attempt-store";
import {
  acquireExecutionOwnershipInTransaction,
  getAuthorityDatabaseTime,
} from "@/lib/executions/persistence/execution-ownership-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  InvocationAttempt,
} from "@/lib/persistence/schema/executions";
import {
  executionOwnershipTable,
  invocationTable,
  runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { computeCapabilityManifestDigest } from "@/lib/routes/domain/route-resolution-policy";
import { buildRuntimeStartRequestForInvocation } from "@/lib/runtime/application/build-runtime-start-request";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  createRuntimeSessionBinding,
  getRuntimeSessionBindingByOwnership,
  updateRuntimeSessionDispatch,
} from "@/lib/runtime/persistence/runtime-session-store";
import { recordAttemptDispatchAttemptStarted } from "@/lib/runtime/retry/dispatch-retry-queries";
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
import {
  type PreparedWorkspaceCandidate,
  activatePreparedWorkspaceWriter,
  prepareWorkspaceCandidate,
  releaseWorkspaceWriter,
} from "@/lib/workspace/workspace-writer";
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
  // 发布事实（RuntimeRevision capability manifest）是 External start 一致性的真值源。
  // 在输入冻结与环境校验之后加载——pure 校验失败语义优先。
  const runtimeRevision = await getRuntimeRevisionById(input.binding.runtimeRevisionId);
  if (!runtimeRevision) throw new Error("RuntimeRevision 不存在");
  const publishedCapabilityManifestDigest = computeCapabilityManifestDigest({
    runtimeRevisionId: runtimeRevision.id,
    runtimeCapabilities: runtimeRevision.runtimeCapabilitiesJson,
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
  let restoration: { checkpointId: string; manifestDigest: string } | null = null;
  if (
    input.recovery?.kind === "resume" &&
    workspaceBinding.continuityMode === "CHECKPOINT_RESTORABLE"
  ) {
    if (
      !input.recovery.checkpointId ||
      !input.workspace?.snapshotStorageRoot ||
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
        storageRoot: input.workspace.snapshotStorageRoot,
        backend: input.workspace.backend,
        expected: {
          invocationId: input.invocation.id,
          workspaceBindingId: workspaceBinding.id,
          environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId,
          recoveryAnchorDigest: input.recovery.anchorDigest,
          recoveryVersion: input.invocation.checkpointRecoveryVersion,
        },
      });
      restoration = {
        checkpointId: restored.checkpointId,
        manifestDigest: restored.manifestDigest,
      };
    } catch (error) {
      await workspaceCandidate.backend.host
        .cleanup(workspaceCandidate.preparation)
        .catch(() => undefined);
      throw error;
    }
  }
  const preparedAttempt = await db.transaction(async (tx) => {
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
  const result = await db.transaction(async (tx) => {
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
        await tx
          .update(runtimeSessionBindingTable)
          .set({
            bindingState: "lost",
            closedAt: nowAtAuthority,
            versionNo: existingSession.versionNo + 1,
            updatedAt: nowAtAuthority,
          })
          .where(eq(runtimeSessionBindingTable.id, existingSession.id));
        const ownershipResult = await acquireExecutionOwnershipInTransaction(tx, {
          tenantId: input.tenantId,
          invocationId: input.invocation.id,
          attemptId: preparedAttempt.id,
          runtimeRevisionId: input.binding.runtimeRevisionId,
          environmentLeaseId: input.environmentLeaseId ?? null,
          acquiredByType: "service",
          acquiredById: "runtime-start",
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
        activationEvidence: {
          workspace: "not-yet-required",
          runtimeRevisionId: input.binding.runtimeRevisionId,
        },
      });
      ownership = ownershipResult.ownership;
    }
    let session = await getRuntimeSessionBindingByOwnership(input.tenantId, ownership.id, tx);
    if (!session) {
      session = await createRuntimeSessionBinding(
        {
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
        },
        tx,
      );
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
      const recoveryAnchorDigest =
        input.recovery?.kind === "resume" ? input.recovery.anchorDigest : null;
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
        let environmentLease: Awaited<ReturnType<typeof activateEnvironmentLease>> | null = null;
        if (input.environmentLeaseId) {
          if (current.environmentLeaseId !== input.environmentLeaseId)
            throw new Error("EnvironmentRevisionMismatch");
          if (!input.binding.environmentDefinitionRevisionId)
            throw new Error("EnvironmentRevisionMismatch");
          // Current Ownership 事务内复核：Lease 确属本 Attempt/Revision/Binding/恢复水位，
          // prepared 未过期且未被释放，才写 ready + activationOwnershipId。
          environmentLease = await activateEnvironmentLease(
            {
              tenantId: input.tenantId,
              leaseId: input.environmentLeaseId,
              ownershipId: current.id,
              attemptId: preparedAttempt.id,
              invocationId: input.invocation.id,
              environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId,
              recoveryAnchorDigest,
            },
            tx,
          );
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
    await closeRuntimeSessionAfterActivationFailure(input.tenantId, session.id).catch(
      () => undefined,
    );
    if (activatedWorkspace)
      await releaseWorkspaceWriter({
        tenantId: input.tenantId,
        lockId: activatedWorkspace.lockId,
        ownershipId: ownership.id,
        reasonCode: "activation_failed",
      }).catch(() => undefined);
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
    now,
  });
  await recordAttemptDispatchAttemptStarted({ sessionBindingId: session.id, now });
  await updateRuntimeSessionDispatch(input.tenantId, session.id, {
    bindingState: "dispatching",
    semanticRequestJson: buildStartSemanticDigestInput(request.request),
    semanticRequestDigest: request.request.semanticRequestDigest,
    lastErrorCode: null,
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
  // External start capability 一致性：Runtime 回执的 capabilitiesDigest 必须等于
  // 发布事实（RuntimeRevision manifest）摘要，否则 fail-closed（dispatch 可能已开始）。
  // In-process Hosted Runtime 不适用：其 runtimeCapabilitiesJson 契约是能力名列表，
  // capability 事实与 revision 同源（同进程写入），无跨网络回执可校验。
  const isInProcessHosted =
    typeof (input.runtimeClient as { getLastLaunchPromise?: unknown }).getLastLaunchPromise ===
    "function";
  if (!isInProcessHosted && response.capabilitiesDigest !== publishedCapabilityManifestDigest) {
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
  await updateRuntimeSessionDispatch(input.tenantId, session.id, {
    bindingState: "dispatching",
    remoteSessionRef: response.remoteSessionRef,
    remoteExecutionRef: response.remoteExecutionRef,
    transportAcknowledgement: response,
    acknowledgedAt: new Date(response.acceptedAt),
  });
  return { authority, response, sessionBindingId: session.id };
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
  sessionBindingId: string,
): Promise<void> {
  await db
    .update(runtimeSessionBindingTable)
    .set({ bindingState: "lost", closedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(runtimeSessionBindingTable.tenantId, tenantId),
        eq(runtimeSessionBindingTable.id, sessionBindingId),
      ),
    );
}
