import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import {
  activateEnvironmentLeaseInTransaction,
  getEnvironmentLeaseById,
  scheduleEnvironmentLeaseCleanup,
  scheduleEnvironmentLeaseCleanupInTransaction,
} from "@/lib/environment/environment-lease-store";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import {
  ExecutionAuthorityError,
  authorityIdentity,
  sameAuthority,
} from "@/lib/executions/domain/execution-authority";
import {
  type ExecutionSourceRequest,
  assertExecutionSourceSnapshot,
  executionSourceDigest,
  executionSourceRequestOf,
  sameExecutionSourceRequest,
} from "@/lib/executions/domain/preparation-source";
import {
  type AttemptPreparationClaim,
  assertAttemptPreparationClaimHeldInTransaction,
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
import { environmentLeaseTable } from "@/lib/persistence/schema/environment";
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
  type runtimeSessionBindingTable,
} from "@/lib/persistence/schema/executions";
import { buildRuntimeStartRequestForInvocation } from "@/lib/runtime/application/build-runtime-start-request";
import { acceptExecutionPreparation } from "@/lib/runtime/application/execution-preparation";
import { expectedCapabilityManifestDigest } from "@/lib/runtime/application/runtime-capability-evidence";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  claimRuntimeSessionDispatchInTransaction,
  createRuntimeSessionBindingInTransaction,
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingBySourceIntent,
  markRuntimeSessionLostByOwnershipInTransaction,
  markRuntimeSessionLostInTransaction,
  updateRuntimeSessionDispatchInTransaction,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  type SessionDispatchClaim,
  type SessionDispatchIdentity,
  lockClaimedSessionInTransaction,
  recordSessionDispatchAttemptStartedInTransaction,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import { RUNTIME_DISPATCH_RETRY_POLICY } from "@/lib/runtime/retry/runtime-dispatch-retry-policy";
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
  type ActivatedWorkspaceWriter,
  type PreparedWorkspaceCandidate,
  WorkspaceWriterReleasePendingError,
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
  sessionDispatchClaim?: SessionDispatchClaim | SessionDispatchIdentity | null;
  /**
   * 受管 EnvironmentProvisioner：用于真实释放该 Lease 已创建的资源。
   * 未提供时环境失败只登记控制面清理工作（不允许伪装成"资源已释放"）。
   */
  environmentProvisioner?: EnvironmentProvisioner | null;
  workspace?: WorkspaceExecutionResources;
  intentType?: "start" | "resume";
  recovery?: Recovery;
  /**
   * A05：**来源操作键** —— 稳定、重投不变，回答"哪一个外部请求要求这次执行/恢复"。
   *
   * - 用户恢复：已持久 `InvocationCommand.id`（`command:<id>`）；
   * - 子调用续接：已持久 continuation 的原始身份（`agent-call:<id>:<version>`）；
   * - 首次 Start / 内联重投：Invocation 自身身份（`invocation:<id>`）。
   *
   * 必填而不是可选：没有来源意图，"同一次请求的第二次投递"就无法与"另一次合法恢复"区分，
   * 唯一能省事的做法就只剩"按最新 Attempt 猜"——那正是 A05 要消灭的东西。
   */
  sourceOperationKey: string;
  /** 外部 IO 前取得的 Attempt 准备领取；生产调用链必须把同一凭据带到最终提交。 */
  preparationClaim?: AttemptPreparationClaim | null;
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

/** Transport 已取得精确 Session claim 后的失败；外层只能用这里携带的出发身份收口。 */
export class RuntimeStartTransportError extends Error {
  readonly name = "RuntimeStartTransportError";

  constructor(
    readonly originalError: unknown,
    readonly dispatchIdentity: SessionDispatchIdentity,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError), {
      cause: originalError,
    });
  }
}

export function executionSourceRequestForStart(
  input: Pick<
    RuntimeStartInput,
    | "tenantId"
    | "invocation"
    | "binding"
    | "attempt"
    | "sourceOperationKey"
    | "intentType"
    | "recovery"
  >,
): ExecutionSourceRequest {
  const intentType = input.intentType ?? "start";
  const sourceKind =
    intentType === "resume"
      ? input.sourceOperationKey.startsWith("agent-call:")
        ? "continuation"
        : "user_resume"
      : input.attempt.retryReasonCode === "supervisor_handoff"
        ? "handoff"
        : input.attempt.retryReasonCode
          ? "redispatch"
          : "initial";
  return {
    tenantId: input.tenantId,
    invocationId: input.invocation.id,
    attemptId: input.attempt.id,
    sourceOperationKey: input.sourceOperationKey,
    intentType,
    sourceKind,
    sourceRef: input.sourceOperationKey,
    runtimeRevisionId: input.binding.runtimeRevisionId,
    workspaceBindingId: input.binding.workspaceBindingId,
    environmentDefinitionRevisionId: input.binding.environmentDefinitionRevisionId ?? null,
    bindingConfigDigest: input.binding.configHash,
    inputDigest: input.invocation.inputDigest,
    recovery:
      input.recovery?.kind === "resume"
        ? {
            kind: "resume",
            anchor: input.recovery.anchor,
            anchorDigest: input.recovery.anchorDigest,
            checkpointId: input.recovery.checkpointId ?? null,
          }
        : { kind: "initial" },
  };
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

/**
 * A07 决策四的**调用方义务**：把"上一代物理 Writer 尚未确认停止"在本次启动/恢复里跑完。
 *
 * `reserveWorkspaceWriter` 面对"旧 `active` holder 已失权"时**只**登记释放义务并返回
 * `release_pending`（即 `WorkspaceWriterReleasePendingError`）——它绝不覆盖那一行、也绝不
 * 抢下一代，因为定位一旦丢失就再也停不掉原来的写者。这条义务必须有人真正兑现：真实撤销
 * 旧代际、取得 `stopped && processGroupEmpty` 回执、把行推到 `released`；只有那之后，
 * 下一次预留才会分配新代际。
 *
 * 生产 Start/Resume 就是那个"有人"。后台清理 Worker 也会收敛，但把一次合法恢复的成败押在
 * "等 Worker 巡检"上是不可接受的不确定延迟（A06-04：默认完整暂停恢复链必须真正执行）。
 *
 * 只兑现**一轮**并重试**一次**：真实停止没成立时（`retry_scheduled`，例如旧 Host 暂时
 * 联系不上）如实把原错误抛回去 —— "本轮不做、稍后重试"，绝不留半个新代际。
 */
async function activateWorkspaceWriterConvergingStaleRelease(input: {
  tenantId: string;
  invocationId: string;
  attemptId: string;
  ownership: ExecutionOwnership;
  authority: AuthorityIdentity;
  candidate: PreparedWorkspaceCandidate;
}): Promise<ActivatedWorkspaceWriter> {
  const attemptActivation = () =>
    activatePreparedWorkspaceWriter({
      tenantId: input.tenantId,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      ownership: input.ownership,
      authority: input.authority,
      candidate: input.candidate,
    });
  try {
    return await attemptActivation();
  } catch (error) {
    if (!(error instanceof WorkspaceWriterReleasePendingError)) throw error;
    const release = await runWorkspaceWriterRelease({
      tenantId: input.tenantId,
      lockId: error.lockId,
      leaseOwner: `start-converge:${input.attemptId}`,
      // 撤销必须到达**该 Binding 的受管 Host**：与候选同源解析，不另起一套定位逻辑。
      deps: { resolveHost: async () => input.candidate.backend.host },
    });
    if (release.outcome === "retry_scheduled") throw error;
    return await attemptActivation();
  }
}

/** Candidate preparation, ownership fencing, physical writer activation, durable intent registration, then transport. */
export async function startRuntimeInvocation(
  input: RuntimeStartInput,
): Promise<RuntimeStartResult> {
  const now = input.now ?? new Date();
  // 纯输入冻结检查可在领取前失败；不得在此前解析 Endpoint/Environment/Workspace。
  if (
    input.expectedInputDigest !== undefined &&
    input.invocation.inputDigest !== input.expectedInputDigest
  ) {
    throw new Error("InputDigestMismatch");
  }
  const declaredAttempt = await getAttemptById(input.attempt.id);
  if (!declaredAttempt || declaredAttempt.invocationId !== input.invocation.id) {
    throw new ExecutionAuthorityError("AttemptMismatch", "Attempt 不属于该 Invocation");
  }
  assertAttemptAcceptsNewGeneration(declaredAttempt);
  const sourceRequest = executionSourceRequestForStart(input);
  if (
    input.preparationClaim &&
    !sameExecutionSourceRequest(
      executionSourceRequestOf(input.preparationClaim.source),
      sourceRequest,
    )
  ) {
    throw new Error("StartIntentConflict");
  }
  const preparationDecision = await acceptExecutionPreparation({
    request: sourceRequest,
    ...(input.preparationClaim ? { claimId: input.preparationClaim.claimId } : {}),
    now,
  });
  if (preparationDecision.disposition === "busy") throw new Error("AttemptPreparationBusy");
  const preparationClaim =
    preparationDecision.disposition === "claimed" ? preparationDecision.claim : null;
  const acceptedSource = preparationDecision.source;
  const sourceRequestDigest = executionSourceDigest(acceptedSource);
  const workspaceBinding =
    input.workspace?.binding ??
    (await getWorkspaceBindingById(input.tenantId, input.binding.workspaceBindingId));
  if (!workspaceBinding) throw new Error("WorkspaceNotReady");
  if (workspaceBinding.id !== input.binding.workspaceBindingId)
    throw new Error("WorkspaceNotReady");
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
  // 发布事实（RuntimeRevision capability manifest）是 External start 一致性的真值源。
  // 在输入冻结与环境校验之后加载——pure 校验失败语义优先。
  const runtimeRevision = await getRuntimeRevisionById(input.binding.runtimeRevisionId);
  if (!runtimeRevision) throw new Error("RuntimeRevision 不存在");
  const publishedCapabilityManifestDigest = expectedCapabilityManifestDigest({
    runtimeRevisionId: runtimeRevision.id,
    runtimeCapabilitiesJson: runtimeRevision.runtimeCapabilitiesJson,
  });
  const intentType = input.intentType ?? "start";
  const recoveryAnchorDigest =
    input.recovery?.kind === "resume" ? input.recovery.anchorDigest : null;
  const checkpointId =
    input.recovery?.kind === "resume" ? (input.recovery.checkpointId ?? null) : null;
  if (
    preparationDecision.disposition === "receipt" ||
    preparationDecision.disposition === "dispatch"
  ) {
    const session = await getRuntimeSessionBindingById(
      input.tenantId,
      preparationDecision.sessionBindingId,
    );
    const [ownership] = await db
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, preparationDecision.ownershipId),
        ),
      )
      .limit(1);
    if (!session || !ownership) throw new Error("RuntimeSessionMismatch");
    const authority = authorityIdentity({
      invocationId: input.invocation.id,
      runtimeRevisionId: input.binding.runtimeRevisionId,
      attemptId: session.attemptId,
      ownershipId: ownership.id,
      leaseEpoch: ownership.leaseEpoch,
      sessionBindingId: session.id,
    });
    const historicalResponse = session.transportAcknowledgement as RuntimeStartResponse | null;
    if (preparationDecision.disposition === "receipt") {
      const receipt =
        historicalResponse ??
        (session.bindingState === "active" &&
        session.remoteSessionRef &&
        session.remoteExecutionRef &&
        session.semanticRequestDigest
          ? {
              protocolVersion: 3 as const,
              authority,
              semanticRequestDigest: session.semanticRequestDigest,
              accepted: true as const,
              remoteSessionRef: session.remoteSessionRef,
              remoteExecutionRef: session.remoteExecutionRef,
              capabilitiesDigest: publishedCapabilityManifestDigest,
              acceptedAt: session.updatedAt.getTime(),
            }
          : null);
      if (!receipt) {
        throw new ExecutionAuthorityError("NotCurrentExecutor", "SourceClosedWithoutReceipt");
      }
      return {
        authority,
        response: receipt,
        sessionBindingId: session.id,
      };
    }
    return dispatchRuntimeStartTransport({
      input,
      attempt: declaredAttempt,
      ownership,
      session,
      publishedCapabilityManifestDigest,
      now,
    });
  }
  if (!preparationClaim) throw new Error("AttemptPreparationBusy");
  const preparedReplay =
    preparationDecision.stage === "register_execution" || preparationDecision.stage === "activate"
      ? declaredAttempt
      : null;
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
          operationId: `workspace-${protocolDigest({
            sourceOperationKey: input.sourceOperationKey,
            checkpointId,
            sourceRequestDigest,
          }).slice(7, 39)}`,
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
    preparationDecision.stage === "prepare" &&
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
  const preparedAttempt =
    preparedReplay ??
    (await db.transaction(async (tx) => {
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
        preparationClaim,
        now,
      });
    }));
  // A05：本次取得执行权所依据的恢复水位。必须在 **Acquire 之前**确定：`prepareChecks`
  // 会用它与 Lease 上的 Prepared 证据比对，写死 `null` 会让正式 Resume 被判成
  // "恢复 Anchor 已变化"（同一份事实两套判据）。
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
    await assertAttemptPreparationClaimHeldInTransaction(tx, preparationClaim);
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
    // A05 唯一决策表第 1/2/3/6 行：**先按来源意图**回读，再谈"要不要另造一个 S"。
    //
    // 来源意图先于 O 生成就存在，因此这是唯一能把"同一请求的第二次投递"与"另一次合法恢复"
    // 区分开的事实。旧实现在这里只看 `ownershipId`：一旦重投落在一个**新**代际上，
    // 就再也认不出旧意图，只能另造 S/O 并重新准备环境。
    let session = await getRuntimeSessionBindingBySourceIntent(
      input.tenantId,
      {
        invocationId: input.invocation.id,
        attemptId: preparedAttempt.id,
        intentType,
        sourceOperationKey: input.sourceOperationKey,
      },
      tx,
    );
    if (session) {
      if (session.sourceRequestDigest !== sourceRequestDigest) {
        // 第 2 行：同来源换语义 → 拒绝且无变更。绝不"采用最新锚点/Revision 凑通过"。
        throw new Error("StartIntentConflict");
      }
      if (["closed", "lost"].includes(session.bindingState)) {
        // 第 6 行：原 O/S 已终态或失权 → **原请求不复活**。合法新代际必须由正式恢复器
        // 携带**新的 Attempt** 形成（A03-05：接管必须新建 Attempt），因此走到这里意味着
        // 调用方正在用一个已死的代际身份重放，只能拒绝。
        throw new ExecutionAuthorityError(
          "NotCurrentExecutor",
          `来源意图的 Session 已收口（${session.bindingState}），不可复活；请由正式恢复器建立新代际`,
        );
      }
    } else {
      session = await getRuntimeSessionBindingByOwnership(input.tenantId, ownership.id, tx);
      if (session && session.sourceOperationKey !== input.sourceOperationKey) {
        // 同一个 O 上挂着**另一个**来源意图：这是"健康执行不属于本恢复意图"的一种，
        // 不得把它改写成新意图（那等于让旧请求接管当前执行）。
        throw new ExecutionAuthorityError(
          "NotCurrentExecutor",
          "当前执行权属于另一个来源意图，不能改写为本次请求",
        );
      }
      if (!session) {
        session = await createRuntimeSessionBindingInTransaction(tx, {
          tenantId: input.tenantId,
          invocationId: input.invocation.id,
          attemptId: preparedAttempt.id,
          ownershipId: ownership.id,
          runtimeRevisionId: input.binding.runtimeRevisionId,
          leaseEpoch: ownership.leaseEpoch,
          intentType,
          startIntentKey: `start:${ownership.id}`,
          preparationClaim,
          // External start capabilities 成为 RuntimeSessionBinding / effective capability 事实。
          runtimeCapabilitiesJson: runtimeRevision.runtimeCapabilitiesJson,
        });
      }
    }
    if (
      session.attemptId !== preparedAttempt.id ||
      session.runtimeRevisionId !== input.binding.runtimeRevisionId ||
      session.leaseEpoch !== ownership.leaseEpoch ||
      session.intentType !== intentType ||
      session.sourceOperationKey !== input.sourceOperationKey ||
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
        activatedWorkspace = await activateWorkspaceWriterConvergingStaleRelease({
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
        const claimedAttempt = await assertAttemptPreparationClaimHeldInTransaction(
          tx,
          preparationClaim,
        );
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
        await tx
          .update(invocationAttemptTable)
          .set({
            preparationClaimId: null,
            preparationLeaseExpiresAt: null,
            versionNo: claimedAttempt.versionNo + 1,
            updatedAt: new Date(),
          })
          .where(eq(invocationAttemptTable.id, preparedAttempt.id));
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
    const mayCompensate = await claimActivationFailureCompensation(
      input,
      ownership,
      session.id,
    ).catch(() => false);
    // 同源并发的另一投递可能已经把同一 O/S/Lease 成功推进到 dispatching。
    // 失败者只有在同一事务内把仍处于 activating 的代际收口后，才有权撤销物理资源；
    // 若状态已推进，它只返回自己的错误，不触碰成功方共享的目录、Writer 或 Lease。
    if (!mayCompensate) throw error;
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
  return dispatchRuntimeStartTransport({
    input,
    attempt: preparedAttempt,
    ownership,
    session,
    publishedCapabilityManifestDigest,
    now,
  });
}

/** 同源重投与首次派发共用的唯一 Transport 尾部；调用前不得再做资源准备。 */
async function dispatchRuntimeStartTransport(inputParams: {
  input: RuntimeStartInput;
  attempt: InvocationAttempt;
  ownership: ExecutionOwnership;
  session: typeof runtimeSessionBindingTable.$inferSelect;
  publishedCapabilityManifestDigest: string;
  now: Date;
}): Promise<RuntimeStartResult> {
  const { input, attempt, ownership, session, publishedCapabilityManifestDigest, now } =
    inputParams;
  // Transport 唯一准入事务：不接受 prepared/activating，也不依赖早先的锁外观察。
  await db.transaction(async (tx) => {
    const lockedInvocation = await lockInvocationRootIfExists(
      tx,
      input.tenantId,
      input.invocation.id,
    );
    if (!lockedInvocation) throw new Error("NotCurrentExecutor");
    const [lockedAttempt] = await tx
      .select()
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, attempt.id),
          eq(invocationAttemptTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    const [lockedOwnership] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, ownership.id),
          eq(executionOwnershipTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    const lockedSession = await getRuntimeSessionBindingById(input.tenantId, session.id, tx);
    const databaseNow = await getAuthorityDatabaseTime(tx);
    if (
      !lockedAttempt ||
      !lockedOwnership ||
      !lockedSession ||
      lockedSession.ownershipId !== lockedOwnership.id ||
      lockedSession.attemptId !== lockedAttempt.id ||
      lockedOwnership.ownershipState !== "active" ||
      lockedOwnership.leaseExpiresAt <= databaseNow ||
      !["dispatching", "executing"].includes(lockedOwnership.executionPhase) ||
      !["prepared", "dispatching", "active"].includes(lockedSession.bindingState)
    ) {
      throw new Error("NotCurrentExecutor");
    }
    const persistedSource = assertExecutionSourceSnapshot(lockedSession.sourceRequestJson);
    if (
      lockedSession.sourceRequestDigest !== executionSourceDigest(persistedSource) ||
      !sameExecutionSourceRequest(
        executionSourceRequestOf(persistedSource),
        executionSourceRequestForStart(input),
      )
    ) {
      throw new Error("StartIntentConflict");
    }
    if (input.environmentLeaseId) {
      const [lease] = await tx
        .select()
        .from(environmentLeaseTable)
        .where(
          and(
            eq(environmentLeaseTable.tenantId, input.tenantId),
            eq(environmentLeaseTable.id, input.environmentLeaseId),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !lease ||
        lease.attemptId !== lockedAttempt.id ||
        lease.readinessState !== "ready" ||
        lease.leaseState !== "active" ||
        lease.activationOwnershipId !== lockedOwnership.id ||
        lease.environmentDefinitionRevisionId !== input.binding.environmentDefinitionRevisionId
      ) {
        throw new Error("EnvironmentRevisionMismatch");
      }
    }
  });
  const authority = authorityIdentity({
    invocationId: input.invocation.id,
    runtimeRevisionId: input.binding.runtimeRevisionId,
    attemptId: attempt.id,
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
  const requestedDispatchClaim = input.sessionDispatchClaim ?? null;
  if (requestedDispatchClaim && requestedDispatchClaim.sessionBindingId !== session.id) {
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
  const dispatchIdentity = await db.transaction(async (tx): Promise<SessionDispatchIdentity> => {
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
    const [lockedAttempt] = await tx
      .select({ id: invocationAttemptTable.id })
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, attempt.id),
          eq(invocationAttemptTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedAttempt) throw new Error("InvocationAttempt 不存在");
    const [lockedOwnership] = await tx
      .select({ id: executionOwnershipTable.id })
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, ownership.id),
          eq(executionOwnershipTable.attemptId, attempt.id),
          eq(executionOwnershipTable.leaseEpoch, ownership.leaseEpoch),
        ),
      )
      .for("update")
      .limit(1);
    if (!lockedOwnership) throw new Error("NotCurrentExecutor");
    let identity: SessionDispatchIdentity = {
      tenantId: input.tenantId,
      sessionBindingId: session.id,
      attemptId: attempt.id,
      ownershipId: ownership.id,
      leaseEpoch: ownership.leaseEpoch,
      claimToken: requestedDispatchClaim?.claimToken ?? null,
    };
    let claimedSession = await lockClaimedSessionInTransaction(tx, identity);
    if (requestedDispatchClaim) {
      if (
        claimedSession.dispatchLeaseExpiresAt === null ||
        claimedSession.dispatchLeaseExpiresAt <= now
      ) {
        throw new Error("SessionDispatchClaimSuperseded");
      }
    } else {
      if (claimedSession.dispatchLeaseExpiresAt && claimedSession.dispatchLeaseExpiresAt > now) {
        throw new Error("SessionDispatchBusy");
      }
      identity = { ...identity, claimToken: randomUUID() };
      claimedSession = await claimRuntimeSessionDispatchInTransaction(tx, {
        tenantId: input.tenantId,
        id: session.id,
        expectedVersionNo: claimedSession.versionNo,
        leaseOwner: identity.claimToken as string,
        leaseExpiresAt: new Date(now.getTime() + RUNTIME_DISPATCH_RETRY_POLICY.leaseDurationMs),
      });
    }
    const recorded = await recordSessionDispatchAttemptStartedInTransaction(tx, identity, now);
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
    return identity;
  });
  const transportRequest = {
    runtimeEndpoint: input.runtimeEndpoint,
    auth: input.auth,
    // canonical 不变量：start idempotency key 与 session.startIntentKey 同源
    //（runtime-session-store.createRuntimeSessionBinding 强制 start:${ownershipId}）。
    idempotencyKey: `start:${ownership.id}`,
    request: request.request,
  };
  try {
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
      const [lockedAttempt] = await tx
        .select({ id: invocationAttemptTable.id })
        .from(invocationAttemptTable)
        .where(
          and(
            eq(invocationAttemptTable.tenantId, input.tenantId),
            eq(invocationAttemptTable.id, dispatchIdentity.attemptId),
            eq(invocationAttemptTable.invocationId, input.invocation.id),
          ),
        )
        .for("update")
        .limit(1);
      const [lockedOwnership] = await tx
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, input.tenantId),
            eq(executionOwnershipTable.id, dispatchIdentity.ownershipId),
            eq(executionOwnershipTable.attemptId, dispatchIdentity.attemptId),
            eq(executionOwnershipTable.leaseEpoch, dispatchIdentity.leaseEpoch),
          ),
        )
        .for("update")
        .limit(1);
      const databaseNow = await getAuthorityDatabaseTime(tx);
      if (
        !lockedAttempt ||
        !lockedOwnership ||
        lockedOwnership.ownershipState !== "active" ||
        lockedOwnership.leaseExpiresAt <= databaseNow
      ) {
        throw new Error("NotCurrentExecutor");
      }
      const claimed = await lockClaimedSessionInTransaction(tx, dispatchIdentity);
      return updateRuntimeSessionDispatchInTransaction(tx, {
        tenantId: input.tenantId,
        id: session.id,
        expectedVersionNo: claimed.versionNo,
        // 单调合并：`execution.started` 可能已先于本 ACK 到达（callback-before-ACK），
        // 此时 Session 已 active 且版本前移——ACK 只补远端引用与 Transport 结果，不判迟到冲突。
        patch: {
          remoteSessionRef: response.remoteSessionRef,
          remoteExecutionRef: response.remoteExecutionRef,
          transportAcknowledgement: response,
          acknowledgedAt: new Date(response.acceptedAt),
          dispatchLeaseOwner: null,
          dispatchLeaseExpiresAt: null,
          nextDispatchAt: null,
        },
      });
    });
    return { authority, response, sessionBindingId: sessionAfterAck.id };
  } catch (error) {
    throw new RuntimeStartTransportError(error, dispatchIdentity);
  }
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

async function claimActivationFailureCompensation(
  input: RuntimeStartInput,
  ownership: ExecutionOwnership,
  sessionBindingId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
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
    if (!invocation) return false;
    const [attempt] = await tx
      .select({ id: invocationAttemptTable.id })
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.id, ownership.attemptId),
          eq(invocationAttemptTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!attempt) return false;
    const [current] = await tx
      .select()
      .from(executionOwnershipTable)
      .where(
        and(
          eq(executionOwnershipTable.tenantId, input.tenantId),
          eq(executionOwnershipTable.id, ownership.id),
          eq(executionOwnershipTable.invocationId, input.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !current ||
      current.ownershipState !== "active" ||
      current.executionPhase !== "activating" ||
      current.attemptId !== ownership.attemptId ||
      current.leaseEpoch !== ownership.leaseEpoch ||
      current.environmentLeaseId !== (input.environmentLeaseId ?? null)
    )
      return false;
    await markRuntimeSessionLostInTransaction(tx, {
      tenantId: input.tenantId,
      id: sessionBindingId,
    });
    const now = await getAuthorityDatabaseTime(tx);
    await tx
      .update(executionOwnershipTable)
      .set({
        ownershipState: "lost",
        releasedAt: now,
        reasonCode: "WorkspaceNotReady",
        executionPhase: "activating",
        versionNo: current.versionNo + 1,
        updatedAt: now,
      })
      .where(eq(executionOwnershipTable.id, current.id));
    if (input.environmentLeaseId) {
      await scheduleEnvironmentLeaseCleanupInTransaction(tx, {
        tenantId: input.tenantId,
        leaseId: input.environmentLeaseId,
        errorCode: "activation_failed",
        immediate: true,
        now,
      });
    }
    return true;
  });
}
