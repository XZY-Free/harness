/** Durable InvocationCommand delivery to the current Runtime authority. */
import { db } from "@/lib/db/client";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import {
  assertExecutionSourceSnapshot,
  executionSourceDigest,
} from "@/lib/executions/domain/preparation-source";
import {
  type AttemptPreparationClaim,
  getAttemptById,
  getLatestAttempt,
} from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { ThreadEvent } from "@/lib/persistence/schema/conversation";
import {
  type ExecutionBinding,
  type ExecutionOwnership,
  INVOCATION_TERMINAL_STATES,
  type Invocation,
  type InvocationCommand,
  executionOwnershipTable,
  invocationAttemptTable,
  invocationCommandTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import {
  acceptRuntimeResumePreparation,
  resumeRuntimeInvocation,
} from "@/lib/runtime/application/runtime-resume";
import { RuntimeStartTransportError } from "@/lib/runtime/application/runtime-start";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
  getRuntimeSessionBindingBySourceOperation,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  recordAttemptDispatchTransientFailure,
  scheduleCommandTransientRetry,
  settleSupersededInvocationCommand,
} from "@/lib/runtime/retry/dispatch-retry-queries";
import type {
  RuntimeCancelTransportRequest,
  RuntimeHttpClient,
  RuntimeSafePointReleaseTransportRequest,
  RuntimeSafePointTransportRequest,
} from "@/lib/runtime/runtime-client";
import type {
  CallbackEndpoints,
  CancelResponse,
  RuntimeStartResponse,
  SafePointRequest,
  SteerRequest,
} from "@/lib/runtime/runtime-protocol";
import { RuntimeStartResponseSchema, protocolDigest } from "@/lib/runtime/runtime-protocol";
import {
  abandonFilesystemCheckpoint,
  produceFilesystemCheckpoint,
} from "@/lib/workspace/checkpoint-producer";
import {
  confirmCheckpointRuntimeRelease,
  recordCheckpointReleaseFailure,
} from "@/lib/workspace/checkpoint-release";
import { getFilesystemCheckpoint } from "@/lib/workspace/checkpoint-store";
import { type RecoveryAnchor, computeRecoveryAnchorDigest } from "@/lib/workspace/recovery-anchor";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { and, desc, eq, sql } from "drizzle-orm";

export interface CommandRuntimeEndpointResolution {
  runtimeEndpoint: string;
  auth: RuntimeTransportAuth;
  callbackEndpoints: CallbackEndpoints;
  workspace?: WorkspaceExecutionResources;
  environmentProvisioner?: EnvironmentProvisioner;
}

export interface CommandDispatchResult {
  commandId: string;
  commandState: "acknowledged" | "failed" | "dispatched";
  skipped?: boolean;
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
  /** R03 §6：命令目标在派发时已失效；命令被收口为 failed，未被重定向到新 Owner。 */
  targetSuperseded?: true;
  pendingRetry?: { nextDispatchAt: Date; dispatchAttemptCount: number };
  retryExhausted?: boolean;
  response?: CancelResponse | RuntimeStartResponse | unknown;
  events: ThreadEvent[];
  errorCode?: string;
  errorMessage?: string;
}

export class CommandNotFoundError extends Error {}
export class CommandAlreadyDispatchedError extends Error {}
export class CommandInvocationNotFoundError extends Error {}
export class ResumeInvocationNotWaitingError extends Error {}

/**
 * R03 §6：命令的目标代际已失效（旧 Owner 已关闭 / 不属于该 Invocation / 目标 Session 不匹配）。
 *
 * 语义是**返回 target superseded，不把同一命令重定向新 Owner**：控制面若要取消"当时的
 * Current Authority"，必须生成针对新目标的**新命令**，而不是让旧 Transport 请求追随 current。
 */
/**
 * R04 §5：命令尾部的领取权已被接管（A09）。
 *
 * 与 `SessionDispatchClaimSuperseded` 同一语义，只是作用对象是 InvocationCommand：
 * 过期 Worker 的迟到结论必须被**拒绝**，而不是"能写就写"。
 */
export class CommandDispatchClaimSupersededError extends Error {
  readonly stableCode = "CommandDispatchClaimSuperseded";
  constructor(message: string) {
    super(message);
    this.name = "CommandDispatchClaimSuperseded";
  }
}

export class CommandTargetSupersededError extends Error {
  readonly code = "CommandTargetSuperseded";
  constructor(reason: string) {
    super(reason);
    this.name = "CommandTargetSuperseded";
  }
}

type CommandContext = {
  command: InvocationCommand;
  invocation: Invocation;
  binding: ExecutionBinding;
  owner: ExecutionOwnership | null;
};

/** post-authority Resume 凭证：UAR resolve 事务已先推进 Authority（waiting_user → running）。 */
function isPostAuthorityResume(context: CommandContext): boolean {
  const payload =
    context.command.payloadJson && typeof context.command.payloadJson === "object"
      ? (context.command.payloadJson as Record<string, unknown>)
      : null;
  return (
    context.invocation.executionState === "running" &&
    payload?.resume_source === "user_action_resolution" &&
    typeof payload.request_id === "string" &&
    payload.request_id.length > 0 &&
    payload.resume_payload !== null &&
    typeof payload.resume_payload === "object"
  );
}

/**
 * A09：投递前置状态**只有一种** —— `dispatched`。
 *
 * 领取（`claimInvocationCommandDispatch`）是投递的前置条件，而领取事务本身把行推进到
 * `dispatched`。所以 dispatcher 只能按"已领取"进入：没有领取过的 `queued` 行在这里
 * 直接拒绝。旧实现允许 `queued` 进入，于是内联路径可以在 `claimToken=null` 下推进
 * 状态并写尾部结论 —— 那正是被删除的"空领取旁路"。
 */
async function loadCommand(tenantId: string, commandId: string): Promise<CommandContext> {
  const [command] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!command) throw new CommandNotFoundError(commandId);
  if (command.commandState !== "dispatched")
    throw new CommandAlreadyDispatchedError(`${commandId}:${command.commandState}`);
  const invocation = await getInvocationById(tenantId, command.invocationId);
  if (!invocation) throw new CommandInvocationNotFoundError(command.invocationId);
  const binding = await getExecutionBindingByInvocation(tenantId, invocation.id);
  if (!binding) throw new CommandInvocationNotFoundError(invocation.id);
  // R03 §6：命令的目标在**正式接受时**（`createInvocationCommandInTransaction`）就固定为
  // targetOwnershipId/targetSessionId。派发时只读这份冻结事实，**绝不**回落到"当前 active
  // ownership"——那正是"旧命令重定向新 Owner"。目标失效由调用方按 superseded 返回。
  const [resolvedOwner] = command.targetOwnershipId
    ? await db
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.id, command.targetOwnershipId),
            eq(executionOwnershipTable.invocationId, invocation.id),
          ),
        )
        .limit(1)
    : [];
  return { command, invocation, binding, owner: resolvedOwner ?? null };
}

type ResumeCommandPreparation = {
  attempt: Awaited<ReturnType<typeof getAttemptById>> & {};
  anchor: string;
  anchorDigest: string;
  checkpointId?: string;
  preparationClaim: AttemptPreparationClaim | null;
};

async function resolveResumeCommandPreparation(
  context: CommandContext,
  preparationClaimId?: string,
): Promise<ResumeCommandPreparation> {
  const sourceOperationKey = `command:${context.command.id}`;
  const historicalSession = await getRuntimeSessionBindingBySourceOperation(
    context.invocation.tenantId,
    {
      invocationId: context.invocation.id,
      intentType: "resume",
      sourceOperationKey,
    },
  );
  const attempt = historicalSession
    ? await getAttemptById(historicalSession.attemptId)
    : await getLatestAttempt(context.invocation.id);
  if (!historicalSession) {
    if (context.invocation.executionState !== "waiting_user" && !isPostAuthorityResume(context)) {
      throw new ResumeInvocationNotWaitingError(context.invocation.id);
    }
    if (!attempt || attempt.attemptState !== "suspended") {
      throw new CommandInvocationNotFoundError(`suspended-attempt:${context.invocation.id}`);
    }
  } else if (!attempt) {
    throw new CommandInvocationNotFoundError(`source-attempt:${historicalSession.attemptId}`);
  }
  if (!attempt) throw new CommandInvocationNotFoundError(context.invocation.id);
  const historicalSource = historicalSession
    ? assertExecutionSourceSnapshot(historicalSession.sourceRequestJson)
    : null;
  if (
    historicalSession &&
    (!historicalSource ||
      historicalSession.sourceRequestDigest !== executionSourceDigest(historicalSource) ||
      historicalSource.sourceOperationKey !== sourceOperationKey ||
      historicalSource.sourceRef !== sourceOperationKey ||
      historicalSource.recovery.kind !== "resume")
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  const anchor =
    historicalSource?.recovery.kind === "resume"
      ? historicalSource.recovery.anchor
      : attempt.filesystemCheckpointId
        ? `checkpoint:${attempt.filesystemCheckpointId}`
        : `invocation:${context.invocation.id}:recovery:${context.invocation.recoveryVersion}`;
  const anchorDigest =
    historicalSource?.recovery.kind === "resume"
      ? historicalSource.recovery.anchorDigest
      : (attempt.resumeAnchorDigest ?? protocolDigest(anchor));
  const checkpointId =
    historicalSource?.recovery.kind === "resume"
      ? historicalSource.recovery.checkpointId
      : attempt.filesystemCheckpointId;
  const accepted = await acceptRuntimeResumePreparation({
    tenantId: context.invocation.tenantId,
    invocation: context.invocation,
    binding: context.binding,
    attempt,
    ...(checkpointId ? { checkpointId } : {}),
    anchor,
    anchorDigest,
    sourceOperationKey,
    ...(preparationClaimId ? { preparationClaimId } : {}),
  });
  if (accepted.decision.disposition === "busy") throw new Error("AttemptPreparationBusy");
  return {
    attempt,
    anchor,
    anchorDigest,
    ...(checkpointId ? { checkpointId } : {}),
    preparationClaim: accepted.decision.disposition === "claimed" ? accepted.decision.claim : null,
  };
}

/** 命令网关在解析 Transport/Workspace/Environment 前的唯一 Resume 接纳入口。 */
export async function acceptResumeCommandPreparation(input: {
  tenantId: string;
  commandId: string;
}): Promise<AttemptPreparationClaim | null> {
  const context = await loadCommand(input.tenantId, input.commandId);
  if (context.command.commandType !== "resume") throw new CommandNotFoundError(input.commandId);
  return (await resolveResumeCommandPreparation(context)).preparationClaim;
}

/**
 * A09：命令尾部提交的**当前领取权**校验。
 *
 * 旧实现只在 `claimToken` **非空**时比较持有者，而请求内联投递恰恰传 `null`：
 * 内联请求 `markDispatched` 后阻塞在网络上 → 后台 lane 发现该行 `dispatched`、租约空缺、
 * 已到期 → 领取为 worker-B → 内联请求返回，以 `claimToken=null` 进入 ACK/失败尾部，
 * 校验被整条跳过，于是覆盖命令结论并清空 worker-B 的领取字段。
 *
 * 现在这条语义**没有免检分支**：所有真实投递（内联与后台）都先在同一个原子领取服务里
 * 取得 nonce（= 该行 `dispatchLeaseOwner`），尾部必须逐字带上它，并且该领取仍未过期。
 * 「从未领取」不再是可执行状态，因此也不再需要"null 就跳过"的分支。
 */
function assertCommandClaimHeld(
  current: InvocationCommand,
  claimToken: string,
  commandId: string,
  now: Date,
): void {
  if (current.dispatchLeaseOwner !== claimToken) {
    throw new CommandDispatchClaimSupersededError(
      `Command ${commandId} 的领取权已被接管（holder=${current.dispatchLeaseOwner ?? "none"}）`,
    );
  }
  if (!current.dispatchLeaseExpiresAt || current.dispatchLeaseExpiresAt <= now) {
    // 过期但尚未被他人领取也不能提交结论：否则"等租约自然过期"就成了绕过校验的路径。
    throw new CommandDispatchClaimSupersededError(`Command ${commandId} 的领取权已过期`);
  }
}

/**
 * A09：网络发送前的**发送尝试计数**。
 *
 * `queued → dispatched` 是**领取事务**的职责（`claimInvocationCommandDispatch`），
 * 不再由本函数在无凭据的情况下顺手完成 —— 否则"没有领取身份也能把状态推进"又是一条旁路。
 * 计数语义是一次真实发送尝试，因此必须与尾部共用同一 claim 谓词（同一 claim 只能计一次的是
 * 重放，见 `claimInvocationCommandDispatch` 的既有领取语义）。
 */
async function recordCommandDispatchAttemptStarted(
  tenantId: string,
  commandId: string,
  claimToken: string,
): Promise<InvocationCommand> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.id, commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command) throw new CommandNotFoundError(commandId);
    // 只有已经领取（`dispatched`）的行才能被计为一次真实发送尝试。
    if (command.commandState !== "dispatched")
      throw new CommandAlreadyDispatchedError(`${commandId}:${command.commandState}`);
    assertCommandClaimHeld(command, claimToken, commandId, now);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchCount: sql`${invocationCommandTable.dispatchCount} + 1`,
        updatedAt: now,
        versionNo: command.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, commandId));
    const [updated] = await tx
      .select()
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, commandId))
      .limit(1);
    if (!updated) throw new CommandNotFoundError(commandId);
    return updated;
  });
}

/**
 * Resume ACK 收口：CAS dispatched → acknowledged 并记录 Transport 回执。
 *
 * R02 §7：**不**在这里推进 Invocation/Turn。`running` 只由合法 `execution.started`
 * 事件映射（含 waiting_user→running 的正式恢复转换）；控制命令 ACK 仅表示
 * Transport 交付事实，不能独立推进状态。
 */
async function acknowledgeResumeCommand(params: {
  tenantId: string;
  commandId: string;
  response: unknown;
  /** A09：本次投递的领取 nonce（必填）。 */
  claimToken: string;
}): Promise<void> {
  const token = params.claimToken;
  const now = new Date();
  await db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, params.tenantId),
          eq(invocationCommandTable.id, params.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command) throw new CommandNotFoundError(params.commandId);
    if (command.commandState !== "dispatched") return;
    assertCommandClaimHeld(command, token, params.commandId, now);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "acknowledged",
        receiptJson: params.response,
        completedAt: now,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(invocationCommandTable.id, params.commandId));
  });
}

/** 原 Resume 已收到真实 Transport 接纳时，只按冻结来源和原回执收口命令。 */
export async function acknowledgeHistoricalResumeCommand(input: {
  tenantId: string;
  commandId: string;
  claimToken: string;
}): Promise<CommandDispatchResult | null> {
  const context = await loadCommand(input.tenantId, input.commandId);
  if (context.command.commandType !== "resume") return null;
  const sourceOperationKey = `command:${input.commandId}`;
  const session = await getRuntimeSessionBindingBySourceOperation(input.tenantId, {
    invocationId: context.invocation.id,
    intentType: "resume",
    sourceOperationKey,
  });
  if (!session?.transportAcknowledgement) return null;
  const source = assertExecutionSourceSnapshot(session.sourceRequestJson);
  const receipt = RuntimeStartResponseSchema.parse(session.transportAcknowledgement);
  if (
    session.sourceRequestDigest !== executionSourceDigest(source) ||
    source.tenantId !== input.tenantId ||
    source.invocationId !== context.invocation.id ||
    source.attemptId !== session.attemptId ||
    source.sourceOperationKey !== sourceOperationKey ||
    source.sourceRef !== sourceOperationKey ||
    source.intentType !== "resume" ||
    source.bindingConfigDigest !== context.binding.configHash ||
    receipt.accepted !== true ||
    receipt.semanticRequestDigest !== session.semanticRequestDigest ||
    receipt.authority.invocationId !== context.invocation.id ||
    receipt.authority.runtimeRevisionId !== context.binding.runtimeRevisionId ||
    receipt.authority.attemptId !== session.attemptId ||
    receipt.authority.ownershipId !== session.ownershipId ||
    receipt.authority.leaseEpoch !== String(session.leaseEpoch) ||
    receipt.authority.sessionBindingId !== session.id
  ) {
    throw new Error("RuntimeSessionMismatch");
  }
  await recordCommandDispatchAttemptStarted(input.tenantId, input.commandId, input.claimToken);
  await acknowledgeResumeCommand({ ...input, response: receipt });
  return {
    commandId: input.commandId,
    commandState: "acknowledged",
    response: receipt,
    events: [],
  };
}

/**
 * 原来源已随 Invocation 终结，但没有可验证的 Transport ACK。保留明确的无回执
 * 结论；execution.started/terminal 只能证明执行发生，不能据此伪造 accepted=true。
 */
export async function closeTerminalResumeCommandWithoutReceipt(input: {
  tenantId: string;
  commandId: string;
  claimToken: string;
}): Promise<CommandDispatchResult | null> {
  const context = await loadCommand(input.tenantId, input.commandId);
  if (context.command.commandType !== "resume") return null;
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select({ executionState: invocationTable.executionState })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, context.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation || !INVOCATION_TERMINAL_STATES.includes(invocation.executionState)) return null;
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, input.tenantId),
          eq(invocationCommandTable.id, input.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command || command.commandState !== "dispatched") return null;
    const now = new Date();
    assertCommandClaimHeld(command, input.claimToken, input.commandId, now);
    const sourceOperationKey = `command:${input.commandId}`;
    const session = await getRuntimeSessionBindingBySourceOperation(
      input.tenantId,
      { invocationId: context.invocation.id, intentType: "resume", sourceOperationKey },
      tx,
    );
    if (session) {
      const source = assertExecutionSourceSnapshot(session.sourceRequestJson);
      if (
        session.sourceRequestDigest !== executionSourceDigest(source) ||
        source.sourceOperationKey !== sourceOperationKey ||
        source.sourceRef !== sourceOperationKey ||
        source.invocationId !== context.invocation.id ||
        source.attemptId !== session.attemptId
      ) {
        throw new Error("RuntimeSessionMismatch");
      }
      if (session.transportAcknowledgement) return null;
    }
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "failed",
        lastErrorCode: "SourceClosedWithoutReceipt",
        receiptJson: { code: "SourceClosedWithoutReceipt" },
        completedAt: now,
        nextDispatchAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
        versionNo: command.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, input.commandId));
    return {
      commandId: input.commandId,
      commandState: "failed" as const,
      errorCode: "SourceClosedWithoutReceipt",
      events: [],
    };
  });
}

/** 已接受的用户暂停命令从未登记来源，当前暂停已换轮时在原领取下明确失效。 */
export async function closeStalePauseResumeCommand(input: {
  tenantId: string;
  commandId: string;
  claimToken: string;
}): Promise<CommandDispatchResult | null> {
  const context = await loadCommand(input.tenantId, input.commandId);
  if (context.command.commandType !== "resume") return null;
  return db.transaction(async (tx) => {
    const [invocation] = await tx
      .select({ recoveryVersion: invocationTable.recoveryVersion })
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, input.tenantId),
          eq(invocationTable.id, context.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) return null;
    const [attempt] = await tx
      .select({
        id: invocationAttemptTable.id,
        resumeAnchor: invocationAttemptTable.resumeAnchor,
        resumeAnchorDigest: invocationAttemptTable.resumeAnchorDigest,
      })
      .from(invocationAttemptTable)
      .where(
        and(
          eq(invocationAttemptTable.tenantId, input.tenantId),
          eq(invocationAttemptTable.invocationId, context.invocation.id),
        ),
      )
      .orderBy(desc(invocationAttemptTable.attemptNo))
      .for("update")
      .limit(1);
    if (!attempt) return null;
    const sourceOperationKey = `command:${input.commandId}`;
    const sourceSession = await getRuntimeSessionBindingBySourceOperation(
      input.tenantId,
      { invocationId: context.invocation.id, intentType: "resume", sourceOperationKey },
      tx,
    );
    if (sourceSession) return null;
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, input.tenantId),
          eq(invocationCommandTable.id, input.commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command || command.commandState !== "dispatched") return null;
    const payload = command.payloadJson;
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).resume_source !== "user_pause"
    )
      return null;
    if (command.payloadDigest !== protocolDigest(payload)) throw new Error("StartIntentConflict");
    const acceptedPauseDigest = (payload as Record<string, unknown>).pause_source_digest;
    const currentPauseDigest = protocolDigest({
      attemptId: attempt.id,
      recoveryVersion: invocation.recoveryVersion,
      resumeAnchor: attempt.resumeAnchor,
      resumeAnchorDigest: attempt.resumeAnchorDigest,
    });
    if (acceptedPauseDigest === currentPauseDigest) return null;
    const now = new Date();
    assertCommandClaimHeld(command, input.claimToken, input.commandId, now);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "failed",
        lastErrorCode: "ResumePauseSourceSuperseded",
        receiptJson: { code: "ResumePauseSourceSuperseded" },
        completedAt: now,
        nextDispatchAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
        versionNo: command.versionNo + 1,
      })
      .where(eq(invocationCommandTable.id, input.commandId));
    return {
      commandId: input.commandId,
      commandState: "failed" as const,
      errorCode: "ResumePauseSourceSuperseded",
      events: [],
    };
  });
}

async function acknowledge(
  tenantId: string,
  commandId: string,
  response: unknown,
  claimToken: string,
): Promise<void> {
  const token = claimToken;
  const now = new Date();
  await db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.id, commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command) throw new CommandNotFoundError(commandId);
    if (command.commandState !== "dispatched") return;
    assertCommandClaimHeld(command, token, commandId, now);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "acknowledged",
        receiptJson: response,
        completedAt: now,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(invocationCommandTable.id, commandId));
  });
}

async function reject(
  tenantId: string,
  commandId: string,
  error: unknown,
  claimToken: string,
): Promise<void> {
  const token = claimToken;
  const now = new Date();
  const code =
    error instanceof RuntimeHttpClientError ? error.stableCode : "RUNTIME_COMMAND_FAILED";
  await db.transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(invocationCommandTable)
      .where(
        and(
          eq(invocationCommandTable.tenantId, tenantId),
          eq(invocationCommandTable.id, commandId),
        ),
      )
      .for("update")
      .limit(1);
    if (!command) throw new CommandNotFoundError(commandId);
    if (command.commandState !== "dispatched") return;
    assertCommandClaimHeld(command, token, commandId, now);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "failed",
        lastErrorCode: code,
        receiptJson: { code },
        completedAt: now,
        nextDispatchAt: null,
        dispatchLeaseOwner: null,
        dispatchLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(invocationCommandTable.id, commandId));
  });
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  expectedType: "cancel" | "resume" | "steer" | "checkpoint";
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  /** 网关在资源解析前取得的准备领取；dispatcher 必须原样复核。 */
  resumePreparationClaim?: AttemptPreparationClaim | null;
  /**
   * A09：本次真实投递的领取 nonce（必填）。
   *
   * 请求内联与后台 lane 的唯一差别是"谁来触发领取"，取得 claim 之后完全同一套规则；
   * 因此这里没有 `undefined`/"未领取"的可执行状态，也不再有"按 `queued` 进入"的
   * 旁路（见 `loadCommand`）。
   */
  claimToken: string;
}): Promise<CommandDispatchResult> {
  const context = await loadCommand(params.tenantId, params.commandId);
  if (context.command.commandType !== params.expectedType)
    throw new CommandNotFoundError(params.commandId);
  const command = await recordCommandDispatchAttemptStarted(
    params.tenantId,
    params.commandId,
    params.claimToken,
  );
  let resumeAcknowledged = false;
  try {
    let response: unknown;
    if (params.expectedType === "resume") {
      const sourceOperationKey = `command:${params.commandId}`;
      const prepared = await resolveResumeCommandPreparation(
        context,
        params.resumePreparationClaim?.claimId,
      );
      const endpoint = await params.runtimeEndpointResolver(context.binding);
      response = await resumeRuntimeInvocation({
        tenantId: params.tenantId,
        invocation: context.invocation,
        binding: context.binding,
        attempt: prepared.attempt,
        runtimeClient: params.runtimeClient,
        runtimeEndpoint: endpoint.runtimeEndpoint,
        auth: endpoint.auth,
        callbackEndpoints: endpoint.callbackEndpoints,
        workspace: endpoint.workspace,
        environmentProvisioner: endpoint.environmentProvisioner,
        anchor: prepared.anchor,
        anchorDigest: prepared.anchorDigest,
        ...(prepared.checkpointId ? { checkpointId: prepared.checkpointId } : {}),
        ...(prepared.preparationClaim ? { preparationClaim: prepared.preparationClaim } : {}),
        // A05：用户恢复的来源意图 = **已持久命令身份**。用 `params.commandId` 而不是
        // 时间/序号：同一次 Resume 的重投必须拿到同一个键，重投才会命中原 Session。
        sourceOperationKey,
      });
    } else {
      const endpoint = await params.runtimeEndpointResolver(context.binding);
      if (params.expectedType === "checkpoint") {
        response = await dispatchFilesystemCheckpoint({
          tenantId: params.tenantId,
          command,
          context,
          endpoint,
          runtimeClient: params.runtimeClient,
        });
      } else {
        // R03 §6：目标代际在命令接受时冻结；此处只读这份事实，**不**回落到当前 Owner。
        // 目标缺失/已关闭 → target superseded，不重定向、不发网络请求。
        const owner = context.owner;
        if (!owner || owner.ownershipState !== "active") {
          throw new CommandTargetSupersededError(
            `目标代际不可用（${owner ? owner.ownershipState : "missing"}）：${context.invocation.id}`,
          );
        }
        // Session 与已冻结的 Authority 一一绑定（每 Ownership generation 唯一 Session）：
        // targetSessionId 缺省时按 ownership 解析；两者不一致即目标已失效。
        const session = command.targetSessionId
          ? await getRuntimeSessionBindingById(params.tenantId, command.targetSessionId)
          : await getRuntimeSessionBindingByOwnership(params.tenantId, owner.id);
        if (
          !session ||
          session.ownershipId !== owner.id ||
          session.leaseEpoch !== owner.leaseEpoch
        ) {
          throw new CommandTargetSupersededError(
            `目标代际的 Session 不匹配：ownership=${owner.id}`,
          );
        }
        const authority = {
          invocationId: context.invocation.id,
          runtimeRevisionId: context.binding.runtimeRevisionId,
          attemptId: owner.attemptId,
          ownershipId: owner.id,
          leaseEpoch: String(owner.leaseEpoch),
          sessionBindingId: session.id,
        } as const;
        if (params.expectedType === "cancel") {
          const request: RuntimeCancelTransportRequest = {
            runtimeEndpoint: endpoint.runtimeEndpoint,
            auth: endpoint.auth,
            invocationId: context.invocation.id,
            idempotencyKey: `command:${command.id}`,
            request: {
              protocolVersion: 3,
              commandId: command.id,
              targetAuthority: authority,
              reasonCode:
                typeof (command.payloadJson as Record<string, unknown>).reasonCode === "string"
                  ? String((command.payloadJson as Record<string, unknown>).reasonCode)
                  : "cancel_requested",
            },
          };
          response = await params.runtimeClient.cancelInvocation(request);
        } else {
          const payload =
            command.payloadJson && typeof command.payloadJson === "object"
              ? (command.payloadJson as Record<string, unknown>)
              : {};
          // R03 §6：Steer 的正式引用就是接受时持久化的正式输入（guidance ThreadItem）。
          // 旧实现的 `<inputRef|invocation-command:{id}>` 与产品入口写入的 `guidance_item_id`
          // 不同名，导致 Hosted Steer 退化为静默空操作。
          const inputRef =
            typeof payload.guidance_item_id === "string"
              ? payload.guidance_item_id
              : typeof payload.inputRef === "string"
                ? payload.inputRef
                : `invocation-command:${command.id}`;
          // 稳定 payload digest = 命令正式接受时冻结的 payloadDigest（不在重试时重算）。
          const inputDigest =
            typeof payload.inputDigest === "string" ? payload.inputDigest : command.payloadDigest;
          const request: SteerRequest = {
            protocolVersion: 3,
            commandId: command.id,
            targetAuthority: authority,
            inputRef,
            inputDigest,
          };
          response = await params.runtimeClient.steerInvocation({
            runtimeEndpoint: endpoint.runtimeEndpoint,
            auth: endpoint.auth,
            invocationId: context.invocation.id,
            idempotencyKey: `command:${command.id}`,
            request,
          });
        }
      }
    }
    if (params.expectedType === "resume") {
      // Resume ACK 收口：CAS dispatched→acknowledged；状态推进留给 execution.started。
      await acknowledgeResumeCommand({
        tenantId: params.tenantId,
        commandId: params.commandId,
        response,
        claimToken: params.claimToken,
      });
      resumeAcknowledged = true;
    }
    if (!resumeAcknowledged)
      await acknowledge(params.tenantId, params.commandId, response, params.claimToken);
    return { commandId: params.commandId, commandState: "acknowledged", response, events: [] };
  } catch (error) {
    // A09：领取权已失效**必须**继续以 `CommandDispatchClaimSupersededError` 拒绝，
    // 不能被下面的通用 catch 吸收成一次"投递失败"——那等于用一份陈旧结论递归提交一次
    // 新持有者不认可的失败（`reject` / `scheduleCommandTransientRetry` 都会先做同一份
    // claim 校验并再次抛出）。这里的边界语义是"本次投递无资格写结论"，由调用方
    // （命令网关 / 维护 lane）决定如何对待，dispatcher 自己不产生任何持久事实。
    if (error instanceof CommandDispatchClaimSupersededError) throw error;
    const failure = error instanceof RuntimeStartTransportError ? error.originalError : error;
    if (failure instanceof RuntimeHttpClientError && failure.retryable) {
      const errorCode =
        failure.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
      if (error instanceof RuntimeStartTransportError) {
        await recordAttemptDispatchTransientFailure(error.dispatchIdentity, {
          errorCode,
          now: new Date(),
          counted: true,
          updateAttempt: false,
        });
      }
      const outcome = await scheduleCommandTransientRetry(
        {
          tenantId: params.tenantId,
          commandId: params.commandId,
          claimToken: params.claimToken,
        },
        { errorCode, now: new Date() },
      );
      return outcome.outcome === "scheduled"
        ? {
            commandId: params.commandId,
            commandState: "dispatched",
            skipped: true,
            skipReason: errorCode,
            pendingRetry: {
              nextDispatchAt: outcome.nextDispatchAt,
              dispatchAttemptCount: outcome.dispatchCount,
            },
            events: [],
            errorCode: failure.stableCode,
            errorMessage: failure.message,
          }
        : {
            commandId: params.commandId,
            commandState: "failed",
            retryExhausted: true,
            events: [],
            errorCode: failure.stableCode,
            errorMessage: failure.message,
          };
    }
    if (params.expectedType === "checkpoint") {
      const payload = readCheckpointPayload(command.payloadJson);
      if (payload) {
        await abandonFilesystemCheckpoint({
          tenantId: params.tenantId,
          invocationId: context.invocation.id,
          ownershipId: context.owner?.id ?? command.targetOwnershipId ?? "",
          checkpointIntentId: payload.checkpointIntentId,
          reasonCode: error instanceof Error ? error.message : "CheckpointStale",
        }).catch(() => undefined);
      }
    }
    // R03 §6：目标失效是**可判定的稳定结果**，与普通投递失败区分开：它不重试、不重定向，
    // 按 claim 身份直接收口为终态；控制面据此决定是否要生成针对新 Current Authority 的新命令。
    const superseded = error instanceof CommandTargetSupersededError;
    if (superseded) {
      await settleSupersededInvocationCommand({
        tenantId: params.tenantId,
        commandId: params.commandId,
        claimToken: params.claimToken,
      });
    } else {
      await reject(params.tenantId, params.commandId, failure, params.claimToken);
    }
    return {
      commandId: params.commandId,
      commandState: "failed",
      ...(superseded ? { targetSuperseded: true as const } : {}),
      events: [],
      errorCode: failure instanceof Error ? failure.name : "RUNTIME_COMMAND_FAILED",
      errorMessage: failure instanceof Error ? failure.message : String(failure),
    };
  }
}

export function dispatchCancelCommand(
  params: Omit<Parameters<typeof dispatchCommand>[0], "expectedType">,
): Promise<CommandDispatchResult> {
  return dispatchCommand({ ...params, expectedType: "cancel" });
}
export function dispatchSteerCommand(
  params: Omit<Parameters<typeof dispatchCommand>[0], "expectedType">,
): Promise<CommandDispatchResult> {
  return dispatchCommand({ ...params, expectedType: "steer" });
}
export function dispatchResumeCommand(
  params: Omit<Parameters<typeof dispatchCommand>[0], "expectedType">,
): Promise<CommandDispatchResult> {
  return dispatchCommand({ ...params, expectedType: "resume" });
}
export function dispatchCheckpointCommand(
  params: Omit<Parameters<typeof dispatchCommand>[0], "expectedType">,
): Promise<CommandDispatchResult> {
  return dispatchCommand({ ...params, expectedType: "checkpoint" });
}
export function retryDispatchedInvocationCommand(
  params: Omit<Parameters<typeof dispatchCommand>[0], "expectedType"> & {
    expectedType?: "cancel" | "resume" | "steer" | "checkpoint";
  },
): Promise<CommandDispatchResult> {
  return (async () => {
    const context = await loadCommand(params.tenantId, params.commandId);
    return dispatchCommand({
      ...params,
      expectedType:
        params.expectedType ??
        (context.command.commandType as "cancel" | "resume" | "steer" | "checkpoint"),
    });
  })();
}

type CheckpointCommandPayload = {
  checkpointIntentId: string;
  deadlineMs: number;
  recoveryAnchor: RecoveryAnchor;
  recoveryAnchorDigest: string;
};

function readCheckpointPayload(payload: unknown): CheckpointCommandPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (
    typeof value.checkpointIntentId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.checkpointIntentId,
    ) ||
    typeof value.deadlineMs !== "number" ||
    !Number.isFinite(value.deadlineMs) ||
    !value.recoveryAnchor ||
    typeof value.recoveryAnchor !== "object" ||
    Array.isArray(value.recoveryAnchor) ||
    typeof value.recoveryAnchorDigest !== "string" ||
    computeRecoveryAnchorDigest(value.recoveryAnchor as RecoveryAnchor) !==
      value.recoveryAnchorDigest
  )
    return null;
  return {
    checkpointIntentId: value.checkpointIntentId,
    deadlineMs: value.deadlineMs,
    recoveryAnchor: value.recoveryAnchor as RecoveryAnchor,
    recoveryAnchorDigest: value.recoveryAnchorDigest,
  };
}

async function dispatchFilesystemCheckpoint(input: {
  tenantId: string;
  command: InvocationCommand;
  context: CommandContext;
  endpoint: CommandRuntimeEndpointResolution;
  runtimeClient: RuntimeHttpClient;
}): Promise<unknown> {
  // R03 §6：Checkpoint 目标同样固定于命令接受时；目标缺失/已关闭即 superseded。
  const owner = input.context.owner;
  if (!owner || owner.ownershipState !== "active") {
    throw new CommandTargetSupersededError(
      `Checkpoint 目标代际不可用（${owner ? owner.ownershipState : "missing"}）：${input.context.invocation.id}`,
    );
  }
  const payload = readCheckpointPayload(input.command.payloadJson);
  if (!payload || protocolDigest(input.command.payloadJson) !== input.command.payloadDigest) {
    throw new Error("CheckpointStale");
  }
  const session = input.command.targetSessionId
    ? await getRuntimeSessionBindingById(input.tenantId, input.command.targetSessionId)
    : null;
  if (
    !session ||
    session.ownershipId !== owner.id ||
    session.leaseEpoch !== owner.leaseEpoch ||
    session.bindingState !== "active"
  ) {
    throw new CommandTargetSupersededError(`Checkpoint 目标 Session 不匹配：ownership=${owner.id}`);
  }
  const workspace = input.endpoint.workspace;
  // A06：存储能力是**引用**（`file` / `broker_default`），恒存在；不再把"没配物理根"
  // 当成"没有存储能力"而在装配层就恒 WorkspaceNotReady。
  if (!workspace || workspace.binding.id !== input.context.binding.workspaceBindingId) {
    throw new Error("WorkspaceNotReady");
  }
  const authority = {
    invocationId: input.context.invocation.id,
    runtimeRevisionId: input.context.binding.runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: String(owner.leaseEpoch),
    sessionBindingId: session.id,
  } as const;
  const freshInvocation = await getInvocationById(input.tenantId, input.context.invocation.id);
  const preparedEvidence = freshInvocation?.checkpointPreparedEvidence as {
    checkpointId?: unknown;
    release?: unknown;
  } | null;
  if (
    freshInvocation?.checkpointIntentId === payload.checkpointIntentId &&
    typeof preparedEvidence?.checkpointId === "string"
  ) {
    const existing = await getFilesystemCheckpoint(input.tenantId, preparedEvidence.checkpointId);
    if (!existing || existing.checkpointIntentId !== payload.checkpointIntentId) {
      throw new Error("CheckpointStale");
    }
    const checkpointReceipt = {
      checkpointId: existing.id,
      manifestRef: existing.manifestRef,
      manifestDigest: existing.manifestDigest,
      contentRootDigest: existing.contentRootDigest,
    };
    // 已提交对象的命令重投只补做原 release，不再请求新安全点、重建 Snapshot 或调用 abandon。
    try {
      await input.runtimeClient.releaseSafePoint({
        runtimeEndpoint: input.endpoint.runtimeEndpoint,
        auth: input.endpoint.auth,
        invocationId: input.context.invocation.id,
        checkpointIntentId: payload.checkpointIntentId,
        idempotencyKey: `checkpoint-release:${payload.checkpointIntentId}`,
        request: {
          protocolVersion: 3,
          targetAuthority: authority,
          checkpointIntentId: payload.checkpointIntentId,
        },
      });
      const release = await confirmCheckpointRuntimeRelease({
        tenantId: input.tenantId,
        invocationId: input.context.invocation.id,
        checkpointIntentId: payload.checkpointIntentId,
      });
      return { checkpoint: checkpointReceipt, release, replayed: true };
    } catch (error) {
      await recordCheckpointReleaseFailure({
        tenantId: input.tenantId,
        invocationId: input.context.invocation.id,
        checkpointIntentId: payload.checkpointIntentId,
        reasonCode: error instanceof Error ? error.message : "RuntimeReleaseFailed",
      });
      return { checkpoint: checkpointReceipt, releasePending: true, replayed: true };
    }
  }
  const request: SafePointRequest = {
    protocolVersion: 3,
    targetAuthority: authority,
    checkpointIntentId: payload.checkpointIntentId,
    deadlineMs: payload.deadlineMs,
    expectedRecoveryAnchorDigest: payload.recoveryAnchorDigest,
  };
  const safePointRequest: RuntimeSafePointTransportRequest = {
    runtimeEndpoint: input.endpoint.runtimeEndpoint,
    auth: input.endpoint.auth,
    invocationId: input.context.invocation.id,
    idempotencyKey: `command:${input.command.id}`,
    request,
  };
  const safePoint = await input.runtimeClient.requestSafePoint(safePointRequest);
  if (!safePoint.accepted) throw new Error("CheckpointStale");
  // §2 步骤 8：解冻是持久工作。Runtime 腿与 Backend 腿分别确认，两条腿都确认后
  // Checkpoint Gate 才回到 open；任何一条失败都保持 `releasing`（fail-closed），
  // 由维护 lane 按 intentId 续做。这里不再用 finally + `.catch(() => undefined)` 吞掉。
  const checkpoint = await produceFilesystemCheckpoint({
    tenantId: input.tenantId,
    invocationId: input.context.invocation.id,
    ownershipId: owner.id,
    backend: workspace.backend,
    storage: workspace.snapshotStorage,
    checkpointIntentId: payload.checkpointIntentId,
    safePointEvidence: {
      checkpointIntentId: safePoint.checkpointIntentId,
      safePointEvidenceDigest: safePoint.safePointEvidenceDigest,
      writerQuiescenceAchievedAt: new Date(safePoint.writerQuiescenceAchievedAt),
    },
  });
  try {
    const release: RuntimeSafePointReleaseTransportRequest = {
      runtimeEndpoint: input.endpoint.runtimeEndpoint,
      auth: input.endpoint.auth,
      invocationId: input.context.invocation.id,
      checkpointIntentId: payload.checkpointIntentId,
      idempotencyKey: `checkpoint-release:${payload.checkpointIntentId}`,
      request: {
        protocolVersion: 3,
        targetAuthority: authority,
        checkpointIntentId: payload.checkpointIntentId,
      },
    };
    await input.runtimeClient.releaseSafePoint(release);
    const legs = await confirmCheckpointRuntimeRelease({
      tenantId: input.tenantId,
      invocationId: input.context.invocation.id,
      checkpointIntentId: payload.checkpointIntentId,
    });
    return { safePoint, checkpoint: { ...checkpoint, release: legs } };
  } catch (error) {
    // Runtime 腿未确认：Backend 腿可能已确认（`checkpoint.release`），Gate 仍停在
    // `releasing`，维护 lane 会续做。失败必须可见，不能静默。
    const reasonCode = error instanceof Error ? error.message : "RuntimeReleaseFailed";
    console.error(
      `Checkpoint Runtime 解冻未确认（intent ${payload.checkpointIntentId}），Gate 保持 releasing：${reasonCode}`,
    );
    await recordCheckpointReleaseFailure({
      tenantId: input.tenantId,
      invocationId: input.context.invocation.id,
      checkpointIntentId: payload.checkpointIntentId,
      reasonCode,
    }).catch((recordError: unknown) => {
      console.error("Checkpoint Runtime 解冻失败原因未能落库", recordError);
    });
    return {
      safePoint,
      checkpoint,
      releasePending: true as const,
      releaseReasonCode: reasonCode,
    };
  }
}
