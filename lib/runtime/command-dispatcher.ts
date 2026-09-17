/** Durable InvocationCommand delivery to the current Runtime authority. */
import { db } from "@/lib/db/client";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { getLatestAttempt } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import type { ThreadEvent } from "@/lib/persistence/schema/conversation";
import {
  type ExecutionBinding,
  type ExecutionOwnership,
  type Invocation,
  type InvocationCommand,
  executionOwnershipTable,
  invocationCommandTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
import { resumeRuntimeInvocation } from "@/lib/runtime/application/runtime-resume";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingByOwnership,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
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
import { protocolDigest } from "@/lib/runtime/runtime-protocol";
import {
  abandonFilesystemCheckpoint,
  produceFilesystemCheckpoint,
} from "@/lib/workspace/checkpoint-producer";
import {
  confirmCheckpointRuntimeRelease,
  recordCheckpointReleaseFailure,
} from "@/lib/workspace/checkpoint-release";
import { type RecoveryAnchor, computeRecoveryAnchorDigest } from "@/lib/workspace/recovery-anchor";
import type { WorkspaceExecutionResources } from "@/lib/workspace/workspace-backend";
import { and, eq, sql } from "drizzle-orm";

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

async function loadCommand(
  tenantId: string,
  commandId: string,
  expectedState: "queued" | "dispatched",
): Promise<CommandContext> {
  const [command] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!command) throw new CommandNotFoundError(commandId);
  if (command.commandState !== expectedState)
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

async function markDispatched(tenantId: string, commandId: string): Promise<InvocationCommand> {
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
    if (!["queued", "dispatched"].includes(command.commandState))
      throw new CommandAlreadyDispatchedError(`${commandId}:${command.commandState}`);
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "dispatched",
        dispatchCount: sql`${invocationCommandTable.dispatchCount} + 1`,
        updatedAt: new Date(),
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
}): Promise<void> {
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
    await tx
      .update(invocationCommandTable)
      .set({
        commandState: "acknowledged",
        receiptJson: params.response,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(invocationCommandTable.id, params.commandId));
  });
}

async function acknowledge(tenantId: string, commandId: string, response: unknown): Promise<void> {
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "acknowledged",
      receiptJson: response,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invocationCommandTable.tenantId, tenantId),
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

async function reject(tenantId: string, commandId: string, error: unknown): Promise<void> {
  const code =
    error instanceof RuntimeHttpClientError ? error.stableCode : "RUNTIME_COMMAND_FAILED";
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "failed",
      lastErrorCode: code,
      receiptJson: { code },
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invocationCommandTable.tenantId, tenantId),
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  expectedType: "cancel" | "resume" | "steer" | "checkpoint";
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  expectedState?: "queued" | "dispatched";
  /** R04 §5：维护 lane 的 claim 令牌；请求内联调度不带（undefined → null）。 */
  claimToken?: string;
}): Promise<CommandDispatchResult> {
  const context = await loadCommand(
    params.tenantId,
    params.commandId,
    params.expectedState ?? "queued",
  );
  if (context.command.commandType !== params.expectedType)
    throw new CommandNotFoundError(params.commandId);
  const command = await markDispatched(params.tenantId, params.commandId);
  const endpoint = await params.runtimeEndpointResolver(context.binding);
  let resumeAcknowledged = false;
  try {
    let response: unknown;
    if (params.expectedType === "resume") {
      // Resume 前置状态：waiting_user，或 UserAction resolve 事务已先落 Authority 的
      // post-authority running（resume_source=user_action_resolution + request_id +
      // resume_payload 凭证）。其余状态一律拒绝。
      if (context.invocation.executionState !== "waiting_user" && !isPostAuthorityResume(context)) {
        throw new ResumeInvocationNotWaitingError(context.invocation.id);
      }
      const attempt = await getLatestAttempt(context.invocation.id);
      if (!attempt || attempt.attemptState !== "suspended")
        throw new CommandInvocationNotFoundError(`suspended-attempt:${context.invocation.id}`);
      const anchor = attempt.filesystemCheckpointId
        ? `checkpoint:${attempt.filesystemCheckpointId}`
        : `invocation:${context.invocation.id}:recovery:${context.invocation.recoveryVersion}`;
      response = await resumeRuntimeInvocation({
        tenantId: params.tenantId,
        invocation: context.invocation,
        binding: context.binding,
        attempt,
        runtimeClient: params.runtimeClient,
        runtimeEndpoint: endpoint.runtimeEndpoint,
        auth: endpoint.auth,
        callbackEndpoints: endpoint.callbackEndpoints,
        workspace: endpoint.workspace,
        environmentProvisioner: endpoint.environmentProvisioner,
        anchor,
        anchorDigest: attempt.resumeAnchorDigest ?? protocolDigest(anchor),
      });
    } else if (params.expectedType === "checkpoint") {
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
      if (!session || session.ownershipId !== owner.id || session.leaseEpoch !== owner.leaseEpoch) {
        throw new CommandTargetSupersededError(`目标代际的 Session 不匹配：ownership=${owner.id}`);
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
    if (params.expectedType === "resume") {
      // Resume ACK 收口：CAS dispatched→acknowledged；状态推进留给 execution.started。
      await acknowledgeResumeCommand({
        tenantId: params.tenantId,
        commandId: params.commandId,
        response,
      });
      resumeAcknowledged = true;
    }
    if (!resumeAcknowledged) await acknowledge(params.tenantId, params.commandId, response);
    return { commandId: params.commandId, commandState: "acknowledged", response, events: [] };
  } catch (error) {
    if (error instanceof RuntimeHttpClientError && error.retryable) {
      const errorCode =
        error.kind === "network" ? "runtime_network_unavailable" : "runtime_unavailable";
      const outcome = await scheduleCommandTransientRetry(
        {
          tenantId: params.tenantId,
          commandId: params.commandId,
          claimToken: params.claimToken ?? null,
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
            errorCode: error.stableCode,
            errorMessage: error.message,
          }
        : {
            commandId: params.commandId,
            commandState: "failed",
            retryExhausted: true,
            events: [],
            errorCode: error.stableCode,
            errorMessage: error.message,
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
        claimToken: params.claimToken ?? null,
      });
    } else {
      await reject(params.tenantId, params.commandId, error);
    }
    return {
      commandId: params.commandId,
      commandState: "failed",
      ...(superseded ? { targetSuperseded: true as const } : {}),
      events: [],
      errorCode: error instanceof Error ? error.name : "RUNTIME_COMMAND_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
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
    const context = await loadCommand(params.tenantId, params.commandId, "dispatched");
    return dispatchCommand({
      ...params,
      expectedState: "dispatched",
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
  if (
    !workspace ||
    workspace.binding.id !== input.context.binding.workspaceBindingId ||
    !workspace.snapshotStorageRoot
  )
    throw new Error("WorkspaceNotReady");
  const authority = {
    invocationId: input.context.invocation.id,
    runtimeRevisionId: input.context.binding.runtimeRevisionId,
    attemptId: owner.attemptId,
    ownershipId: owner.id,
    leaseEpoch: String(owner.leaseEpoch),
    sessionBindingId: session.id,
  } as const;
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
    storageRoot: workspace.snapshotStorageRoot,
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
