/** Durable InvocationCommand delivery to the current Runtime authority. */
import { createHash } from "node:crypto";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
import { db } from "@/lib/db/client";
import type { EnvironmentProvisioner } from "@/lib/environment/environment-provisioner";
import { getLatestAttempt } from "@/lib/executions/persistence/attempt-store";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { type ThreadEvent, threadTable, turnTable } from "@/lib/persistence/schema/conversation";
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
import { scheduleCommandTransientRetry } from "@/lib/runtime/retry/dispatch-retry-queries";
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
  computeCheckpointAnchorDigest,
  produceFilesystemCheckpoint,
} from "@/lib/workspace/checkpoint-producer";
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

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
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
  // Command 目标是 Invocation 的 Current Authority：targetOwnershipId 缺省时
  // 解析当前 active ownership，保证共享 command gateway 对任何命令来源都成立。
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
    : await db
        .select()
        .from(executionOwnershipTable)
        .where(
          and(
            eq(executionOwnershipTable.tenantId, tenantId),
            eq(executionOwnershipTable.invocationId, invocation.id),
            eq(executionOwnershipTable.ownershipState, "active"),
          ),
        )
        .orderBy(sql`${executionOwnershipTable.leaseEpoch} DESC`)
        .limit(1);
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
 * Resume ACK 原子收口：CAS dispatched → acknowledged + Invocation/Turn
 * waiting_user → running + turn.resumed 事件。transport 事件流可能已在网络调用
 * 期间把 Invocation/Turn 推进到别的状态，CAS 绝不回退。
 */
async function acknowledgeResumeAndAdvanceStates(params: {
  tenantId: string;
  commandId: string;
  invocation: Invocation;
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
    if (command.commandState === "dispatched") {
      await tx
        .update(invocationCommandTable)
        .set({
          commandState: "acknowledged",
          receiptJson: params.response,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(invocationCommandTable.id, params.commandId));
    }
    const [invocation] = await tx
      .select()
      .from(invocationTable)
      .where(
        and(
          eq(invocationTable.tenantId, params.tenantId),
          eq(invocationTable.id, params.invocation.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!invocation) throw new CommandInvocationNotFoundError(params.invocation.id);
    if (invocation.executionState === "waiting_user") {
      await tx
        .update(invocationTable)
        .set({
          executionState: "running",
          errorCode: null,
          errorSummary: null,
          versionNo: invocation.versionNo + 1,
          updatedAt: new Date(),
        })
        .where(eq(invocationTable.id, invocation.id));
    }
    if (!invocation.threadId || !invocation.turnId) return;
    const [turn] = await tx
      .select()
      .from(turnTable)
      .where(eq(turnTable.id, invocation.turnId))
      .for("update")
      .limit(1);
    if (turn && turn.turnState === "waiting_user") {
      await tx
        .update(turnTable)
        .set({
          turnState: "running",
          errorCode: null,
          waitingAt: null,
          versionNo: turn.versionNo + 1,
        })
        .where(eq(turnTable.id, turn.id));
    }
    const sequence = await allocateEventSequences(tx, invocation.threadId, 1);
    await insertThreadEvent(tx, invocation.threadId, sequence, {
      eventType: "turn.resumed",
      turnId: invocation.turnId,
      invocationId: invocation.id,
      actorType: "system",
      payload: { command_id: params.commandId },
    });
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
      if (!context.owner)
        throw new CommandInvocationNotFoundError(`owner:${context.invocation.id}`);
      // Session 与 Current Authority 绑定：targetSessionId 缺省时按 ownership 解析。
      const session = command.targetSessionId
        ? await getRuntimeSessionBindingById(params.tenantId, command.targetSessionId)
        : await getRuntimeSessionBindingByOwnership(params.tenantId, context.owner.id);
      if (
        !session ||
        session.ownershipId !== context.owner.id ||
        session.leaseEpoch !== context.owner.leaseEpoch
      ) {
        throw new Error("RuntimeSessionMismatch");
      }
      const authority = {
        invocationId: context.invocation.id,
        runtimeRevisionId: context.binding.runtimeRevisionId,
        attemptId: context.owner.attemptId,
        ownershipId: context.owner.id,
        leaseEpoch: String(context.owner.leaseEpoch),
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
        const inputRef =
          typeof payload.inputRef === "string"
            ? payload.inputRef
            : `invocation-command:${command.id}`;
        const inputDigest =
          typeof payload.inputDigest === "string" ? payload.inputDigest : digest(payload);
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
      // Resume ACK 原子收口：CAS dispatched→acknowledged + waiting_user→running
      // + turn.resumed 事件；其余命令维持通用 acknowledge。
      await acknowledgeResumeAndAdvanceStates({
        tenantId: params.tenantId,
        commandId: params.commandId,
        invocation: context.invocation,
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
      const outcome = await scheduleCommandTransientRetry({
        commandId: params.commandId,
        errorCode,
        now: new Date(),
      });
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
    await reject(params.tenantId, params.commandId, error);
    return {
      commandId: params.commandId,
      commandState: "failed",
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
  recoveryAnchor: Record<string, unknown>;
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
    computeCheckpointAnchorDigest(value.recoveryAnchor) !== value.recoveryAnchorDigest
  )
    return null;
  return {
    checkpointIntentId: value.checkpointIntentId,
    deadlineMs: value.deadlineMs,
    recoveryAnchor: value.recoveryAnchor as Record<string, unknown>,
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
  if (!input.context.owner)
    throw new CommandInvocationNotFoundError(`owner:${input.context.invocation.id}`);
  const payload = readCheckpointPayload(input.command.payloadJson);
  if (!payload || protocolDigest(input.command.payloadJson) !== input.command.payloadDigest) {
    throw new Error("CheckpointStale");
  }
  const session = input.command.targetSessionId
    ? await getRuntimeSessionBindingById(input.tenantId, input.command.targetSessionId)
    : null;
  if (
    !session ||
    session.ownershipId !== input.context.owner.id ||
    session.leaseEpoch !== input.context.owner.leaseEpoch ||
    session.bindingState !== "active"
  ) {
    throw new Error("RuntimeSessionMismatch");
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
    attemptId: input.context.owner.attemptId,
    ownershipId: input.context.owner.id,
    leaseEpoch: String(input.context.owner.leaseEpoch),
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
  try {
    const checkpoint = await produceFilesystemCheckpoint({
      tenantId: input.tenantId,
      invocationId: input.context.invocation.id,
      ownershipId: input.context.owner.id,
      backend: workspace.backend,
      storageRoot: workspace.snapshotStorageRoot,
      checkpointIntentId: payload.checkpointIntentId,
      safePointEvidence: {
        checkpointIntentId: safePoint.checkpointIntentId,
        safePointEvidenceDigest: safePoint.safePointEvidenceDigest,
        writerQuiescenceAchievedAt: new Date(safePoint.writerQuiescenceAchievedAt),
      },
    });
    return { safePoint, checkpoint };
  } finally {
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
    await input.runtimeClient.releaseSafePoint(release).catch(() => undefined);
  }
}
