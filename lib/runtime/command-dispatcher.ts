import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { allocateEventSequences, insertThreadEvent } from "@/lib/conversations/thread-queries";
/**
 * 命令调度器（S05-C04）。
 *
 * 事实源：
 * - docs/architecture/persistence.md （InvocationCommand 表）、-（Invocation/Binding/Attempt）
 * - docs/architecture/agent-control-plane.md （Steer）、（Stop/Interrupt）、（Regenerate）、（Resume）
 * - docs/architecture/api-and-events.md §4（Runtime Protocol API：cancel/resume/steer）
 * - docs/architecture/runtime-control-plane.md S05-C04
 *
 * 职责：
 * - dispatchSteerCommand：将 queued Steer 命令调度到 Runtime（POST /invocations/{id}:steer），ack 后标记 acknowledged + 写 turn.steered。
 * - dispatchCancelCommand：将 queued Interrupt 命令调度到 Runtime（POST /invocations/{id}:cancel），ack 后标记 acknowledged（Turn 终态由 ingress execution.cancelled 推进）。
 * - dispatchResumeCommand：将 queued Resume 命令调度到 Runtime（POST /invocations/{id}:resume），ack 后标记 acknowledged + Invocation waiting_user → running + 写 turn.resumed/invocation.resumed。
 *
 * 命令状态机（，不可逆）：
 * - queued → dispatched → acknowledged/failed
 * - 已成功副作用不可撤销；Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * 错误处理（与 dispatcher.ts dispatchToRuntime 一致）：
 * - kind=network → 保持 dispatched（Runtime 不可达，等待重试）。
 * - kind=http + 503 → 保持 dispatched（Runtime 暂不可用，等待重试）。
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 幂等复用，标记 acknowledged。
 * - 其他错误 → 标记 failed（Runtime 拒绝，不伪造成功）。
 *
 * 关键约束：
 * - Cancel 在 Runtime ack 前先写 turn.interrupt_requested（由 requestInterrupt 入队时写，不等 Runtime ack）。
 * - Steer 不创建第二个 Turn（将 user_guidance Item 加入当前 Turn）。
 * - waiting_user 必须解析对应 UserActionRequest（Resume 携带 resume_payload）。
 * - Resume 不能新建 continuation Invocation（只恢复原 Invocation）。
 * - commandState 转换不可逆：queued → dispatched → acknowledged/failed。
 * - Runtime 不可达时保持 dispatched（不报错，等待重试）。
 */
import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import type { AgentRevision } from "@/lib/persistence/schema/agent";
import type { ThreadEvent, ThreadEventActorType } from "@/lib/persistence/schema/conversation";
import {
  invocationCommandTable,
  threadTable,
  turnTable,
} from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding, Invocation } from "@/lib/persistence/schema/runtime";
import {
  CommandAlreadyDispatchedError,
  CommandInvocationNotFoundError,
  CommandNotFoundError,
  ResumeInvocationNotWaitingError,
  RuntimeHttpClientError,
} from "@/lib/runtime/errors";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { redispatchInvocation } from "@/lib/runtime/redispatch-queries";
import type {
  CancelInvocationRequest,
  ResumeInvocationRequest,
  ResumeInvocationResponse,
  RuntimeHttpClient,
  SteerInvocationRequest,
} from "@/lib/runtime/runtime-client";
import { and, eq } from "drizzle-orm";

/** 事务句柄类型。 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** RuntimeEndpointResolution（与 dispatcher.ts 一致，从此处独立声明避免循环依赖）。 */
export interface CommandRuntimeEndpointResolution {
  /** Runtime HTTP 端点基础 URL。 */
  runtimeEndpoint: string;
  /** 短期 Workload Token（绑定 runtime_revision/invocation/租户）。 */
  authToken: string;
  /**
   * 平台 Gateway 回调端点（S09-C06：requires_redispatch=true 时必需，供 redispatchInvocation
   * 构造 StartInvocationRequestBody 使用）。
   *
   * cancel/steer 命令不需要此字段；resume 命令在 requires_redispatch=true 分支需要。
   */
  gatewayEndpoints?: {
    events: string;
    cancel: string;
    resume: string;
    steer: string;
  };
}

/** 命令调度结果。 */
export interface CommandDispatchResult {
  /** 命令 id。 */
  commandId: string;
  /** 最终命令状态。 */
  commandState: "acknowledged" | "failed" | "dispatched";
  /** Runtime 调度是否被跳过（网络不可达/503 → 保持 dispatched，等待重试）。 */
  skipped?: boolean;
  /** 跳过原因（skipped=true 时填）。 */
  skipReason?: "runtime_network_unavailable" | "runtime_unavailable";
  /** Runtime 执行引用（dispatched/acknowledged 时填）。 */
  runtimeExecutionRef?: string;
  /** ack 时间（acknowledged 时填）。 */
  acknowledgedAt?: Date;
  /** 失败时间（failed 时填）。 */
  failedAt?: Date;
  /** 失败错误码（failed 时填）。 */
  errorCode?: string;
  /** 失败错误消息（failed 时填）。 */
  errorMessage?: string;
  /** 调度产生的事件（ack 后写入的 turn.steered/turn.resumed/invocation.resumed 等）。 */
  events: ThreadEvent[];
  /**
   * S09-C06：Resume 命令是否触发了重调度（Runtime 返回 requires_redispatch=true）。
   * true 时表示平台为同一 Invocation 创建了新 Attempt 并重新调用 Runtime startInvocation。
   */
  redispatched?: boolean;
}

// ─── 公共辅助：加载命令 + 校验状态 ────────────────────────

/** InvocationCommand 行 + 关联 Invocation 的加载结果。 */
interface LoadedCommand {
  command: {
    id: string;
    commandType: string;
    commandState: string;
    invocationId: string | null;
    threadId: string;
    turnId: string | null;
    commandPayloadJson: unknown;
    idempotencyKey: string | null;
  };
  invocation: Invocation;
  binding: ExecutionBinding;
}

/**
 * 加载命令 + 关联 Invocation + ExecutionBinding（跨租户隔离）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度（非 queued）
 * @throws CommandInvocationNotFoundError 命令关联的 Invocation 不存在
 */
async function loadCommandForDispatch(tenantId: string, commandId: string): Promise<LoadedCommand> {
  const [commandRow] = await db
    .select()
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);

  // 跨租户隔离：通过 threadId 关联租户校验
  if (!commandRow) {
    throw new CommandNotFoundError(commandId);
  }

  // 通过 Thread 校验租户归属
  const [threadRow] = await db
    .select({ tenantId: threadTable.tenantId })
    .from(threadTable)
    .where(eq(threadTable.id, commandRow.threadId))
    .limit(1);
  if (!threadRow || threadRow.tenantId !== tenantId) {
    throw new CommandNotFoundError(commandId);
  }

  // 校验命令状态为 queued
  if (commandRow.commandState !== "queued") {
    throw new CommandAlreadyDispatchedError(commandId, commandRow.commandState);
  }

  // 校验 invocationId 已绑定
  if (!commandRow.invocationId) {
    throw new CommandInvocationNotFoundError("<null>");
  }

  const invocation = await getInvocationById(tenantId, commandRow.invocationId);
  if (!invocation) {
    throw new CommandInvocationNotFoundError(commandRow.invocationId);
  }

  const binding = await getExecutionBindingByInvocation(tenantId, invocation.id);
  if (!binding) {
    throw new CommandInvocationNotFoundError(invocation.id);
  }

  return {
    command: {
      id: commandRow.id,
      commandType: commandRow.commandType,
      commandState: commandRow.commandState,
      invocationId: commandRow.invocationId,
      threadId: commandRow.threadId,
      turnId: commandRow.turnId,
      commandPayloadJson: commandRow.commandPayloadJson,
      idempotencyKey: commandRow.idempotencyKey,
    },
    invocation,
    binding,
  };
}

/**
 * 事务内 CAS 转换命令状态（queued → dispatched）。
 *
 * @returns true=成功转换；false=并发冲突（已被其他调度器处理）
 */
async function transitionCommandToDispatched(
  tx: Tx,
  commandId: string,
  runtimeExecutionRef: string | null,
): Promise<boolean> {
  const now = new Date();
  const result = await tx
    .update(invocationCommandTable)
    .set({
      commandState: "dispatched",
      dispatchedAt: now,
      runtimeExecutionRef,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "queued"),
      ),
    );
  return result[0].affectedRows > 0;
}

/**
 * 事务内 CAS 转换命令状态（dispatched → acknowledged）。
 */
async function transitionCommandToAcknowledged(tx: Tx, commandId: string): Promise<void> {
  const now = new Date();
  await tx
    .update(invocationCommandTable)
    .set({
      commandState: "acknowledged",
      acknowledgedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

/**
 * 标记命令失败（dispatched → failed，事务外调用）。
 *
 * Runtime 拒绝时不能伪造成功（行 366）。
 */
async function markCommandFailed(
  commandId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "failed",
      failedAt: now,
      errorCode,
      errorMessage,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

/**
 * 标记命令 acknowledged（dispatched → acknowledged，事务外调用，用于幂等冲突复用场景）。
 */
async function markCommandAcknowledged(commandId: string): Promise<void> {
  const now = new Date();
  await db
    .update(invocationCommandTable)
    .set({
      commandState: "acknowledged",
      acknowledgedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(invocationCommandTable.id, commandId),
        eq(invocationCommandTable.commandState, "dispatched"),
      ),
    );
}

// ─── dispatchSteerCommand ─────────────────────────────────

/**
 * 调度 Steer 命令到 Runtime。
 *
 * 流程：
 * 1. 加载命令 + Invocation + ExecutionBinding（校验 queued 状态）。
 * 2. 事务内：CAS queued → dispatched（设置 dispatchedAt）。
 * 3. 解析 runtimeEndpoint + authToken。
 * 4. 调用 runtimeClient.steerInvocation（携带 steer_payload = commandPayloadJson）。
 * 5. 成功：事务内 CAS dispatched → acknowledged + 写 turn.steered Event。
 * 6. 网络/503：保持 dispatched（等待重试）。
 * 7. 其他错误：标记 failed。
 * 8. 409 IDEMPOTENCY_CONFLICT：标记 acknowledged（幂等复用）。
 *
 * 关键约束：
 * - Steer 不创建第二个 Turn（行 366），将 user_guidance Item 加入当前 Turn。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 */
export async function dispatchSteerCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandDispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "steer") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  // 1. 事务内 CAS queued → dispatched
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    // 并发冲突：已被其他调度器处理
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  // 2. 解析 runtimeEndpoint + authToken
  const { runtimeEndpoint, authToken } = await params.runtimeEndpointResolver(loaded.binding);

  // 3. 构造 steer 请求
  const steerPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `steer-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  const request: SteerInvocationRequest = {
    runtimeEndpoint,
    authToken,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      steer_payload: steerPayload,
      trace_context: traceContext,
    },
  };

  // 4. 调用 Runtime
  try {
    await params.runtimeClient.steerInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded.command.id);
  }

  // 5. 成功：事务内 CAS dispatched → acknowledged + 写 turn.steered Event
  // ack 事件使用派生唯一 key（不复用命令的 idempotencyKey，避免与 turn.steer_queued 冲突）
  const steerAckIdempotencyKey = `steer-ack-${loaded.command.id}`;
  const events = await db.transaction(async (tx) => {
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // 写 turn.steered Event（Steer 不创建第二个 Turn，只标记已引导）
    if (loaded.invocation.threadId && loaded.command.turnId) {
      const seq = await allocateEventSequences(tx, loaded.invocation.threadId, 1);
      const event = await insertThreadEvent(tx, loaded.invocation.threadId, seq, {
        eventType: "turn.steered",
        turnId: loaded.command.turnId,
        invocationId: loaded.invocation.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          command_id: loaded.command.id,
          guidance_item_id: steerPayload.guidance_item_id ?? null,
          runtime_acknowledged: true,
        },
        correlationId: params.correlationId ?? undefined,
        idempotencyKey: steerAckIdempotencyKey,
      });
      return [event];
    }
    return [];
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events,
  };
}

// ─── dispatchCancelCommand ────────────────────────────────

/**
 * 调度 Cancel（Interrupt）命令到 Runtime。
 *
 * 流程：
 * 1. 加载命令 + Invocation + ExecutionBinding（校验 queued 状态）。
 * 2. 事务内：CAS queued → dispatched（设置 dispatchedAt）。
 * 3. 解析 runtimeEndpoint + authToken。
 * 4. 调用 runtimeClient.cancelInvocation（携带 reason = commandPayloadJson.reason_code）。
 * 5. 成功：事务内 CAS dispatched → acknowledged（Turn 终态由 ingress execution.cancelled 推进）。
 * 6. 网络/503：保持 dispatched（等待重试）。
 * 7. 其他错误：标记 failed。
 * 8. 409 IDEMPOTENCY_CONFLICT：标记 acknowledged（幂等复用）。
 *
 * 关键约束：
 * - Cancel 在 Runtime ack 前先写 turn.interrupt_requested（由 requestInterrupt 入队时写）。
 * - 已成功副作用不可撤销（行 393）。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 */
export async function dispatchCancelCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandDispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "interrupt") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  // 1. 事务内 CAS queued → dispatched
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  // 2. 解析 runtimeEndpoint + authToken
  const { runtimeEndpoint, authToken } = await params.runtimeEndpointResolver(loaded.binding);

  // 3. 构造 cancel 请求
  const commandPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const reason =
    typeof commandPayload.reason_code === "string" ? commandPayload.reason_code : "user_cancel";
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `cancel-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  const request: CancelInvocationRequest = {
    runtimeEndpoint,
    authToken,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      reason,
      trace_context: traceContext,
    },
  };

  // 4. 调用 Runtime
  try {
    await params.runtimeClient.cancelInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded.command.id);
  }

  // 5. 成功：事务内 CAS dispatched → acknowledged
  // Turn 终态由 ingress execution.cancelled 推进（Runtime 通过 events:batch 上报）
  await db.transaction(async (tx) => {
    await transitionCommandToAcknowledged(tx, loaded.command.id);
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events: [],
  };
}

// ─── dispatchResumeCommand ────────────────────────────────

/**
 * 调度 Resume 命令到 Runtime。
 *
 * 流程：
 * 1. 加载命令 + Invocation + ExecutionBinding（校验 queued 状态）。
 * 2. 校验 Invocation 处于 waiting_user 状态（Resume 仅可作用于 waiting_user）。
 * 3. 事务内：CAS queued → dispatched（设置 dispatchedAt）。
 * 4. 解析 runtimeEndpoint + authToken（+ 可选 gatewayEndpoints）。
 * 5. 调用 runtimeClient.resumeInvocation（携带 resume_payload = commandPayloadJson.resume_payload）。
 * 6. 成功：
 * - requires_redispatch=false/undefined：事务内 CAS dispatched → acknowledged +
 * Invocation waiting_user → running + CAS Turn waiting_user → running +
 * 写 turn.resumed + invocation.resumed Event。
 * - requires_redispatch=true（S09-C06）：事务内 CAS dispatched → acknowledged +
 * CAS Turn waiting_user → running + 写 turn.resumed Event（带 redispatched=true 标记），
 * 随后调用 redispatchInvocation 创建新 Attempt + 调用 Runtime startInvocation +
 * 写 invocation.started Event（attempt_no > 1）。不写 invocation.resumed Event
 * （因为 Invocation 不是简单恢复，而是重新调度）。
 * 7. 网络/503：保持 dispatched（等待重试）。
 * 8. 其他错误：标记 failed。
 * 9. 409 IDEMPOTENCY_CONFLICT：标记 acknowledged（幂等复用）。
 *
 * 关键约束：
 * - waiting_user 必须解析对应 UserActionRequest（Resume 携带 resume_payload）。
 * - Resume 不能新建 continuation Invocation（只恢复原 Invocation）；redispatch 同样不新建 Invocation。
 * - Runtime 拒绝时不能伪造成功（command 标记 failed）。
 * - requires_redispatch=true 时必须有 gatewayEndpoints（用于 redispatch 的 startInvocation 调用）。
 *
 * @throws CommandNotFoundError 命令不存在或跨租户不可见
 * @throws CommandAlreadyDispatchedError 命令已调度
 * @throws CommandInvocationNotFoundError 关联 Invocation 不存在
 * @throws ResumeInvocationNotWaitingError Invocation 不在 waiting_user 状态
 */
export async function dispatchResumeCommand(params: {
  tenantId: string;
  commandId: string;
  runtimeClient: RuntimeHttpClient;
  runtimeEndpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
  /**
   * S09-C06：requires_redispatch=true 时使用的 AgentRevision（用于构造 redispatch 的 StartInvocationRequestBody）。
   * 不传则从 ExecutionBinding.agentRevisionId 自动加载。
   */
  agentRevision?: AgentRevision;
  actorType?: ThreadEventActorType;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandDispatchResult> {
  const actorType: ThreadEventActorType = params.actorType ?? "system";
  const loaded = await loadCommandForDispatch(params.tenantId, params.commandId);

  if (loaded.command.commandType !== "resume") {
    throw new CommandAlreadyDispatchedError(loaded.command.id, loaded.command.commandType);
  }

  // 校验 Invocation 处于 waiting_user 状态
  if (loaded.invocation.executionState !== "waiting_user") {
    throw new ResumeInvocationNotWaitingError(
      loaded.invocation.id,
      loaded.invocation.executionState,
    );
  }

  // 1. 事务内 CAS queued → dispatched
  const transitioned = await db.transaction(async (tx) =>
    transitionCommandToDispatched(tx, loaded.command.id, null),
  );
  if (!transitioned) {
    throw new CommandAlreadyDispatchedError(loaded.command.id, "dispatched");
  }

  // 2. 解析 runtimeEndpoint + authToken（+ 可选 gatewayEndpoints）
  const endpointResolution = await params.runtimeEndpointResolver(loaded.binding);
  const { runtimeEndpoint, authToken } = endpointResolution;

  // 3. 构造 resume 请求
  const commandPayload = loaded.command.commandPayloadJson as Record<string, unknown>;
  const resumePayload = commandPayload.resume_payload ?? commandPayload;
  const runtimeIdempotencyKey = loaded.command.idempotencyKey ?? `resume-${loaded.command.id}`;
  const traceContext = params.correlationId
    ? { trace_id: params.correlationId, span_id: loaded.invocation.id }
    : null;

  const request: ResumeInvocationRequest = {
    runtimeEndpoint,
    authToken,
    invocationId: loaded.invocation.id,
    idempotencyKey: runtimeIdempotencyKey,
    requestBody: {
      resume_payload: resumePayload,
      trace_context: traceContext,
    },
  };

  // 4. 调用 Runtime
  let response: ResumeInvocationResponse;
  try {
    response = await params.runtimeClient.resumeInvocation(request);
  } catch (err) {
    return handleRuntimeError(err, loaded.command.id);
  }

  // 5. 检查 requires_redispatch 分支（S09-C06）
  if (response.requires_redispatch === true) {
    return await handleResumeRequiresRedispatch(params, loaded, endpointResolution, actorType);
  }

  // 6. 成功（requires_redispatch=false/undefined）：事务内 CAS dispatched → acknowledged
  // + Invocation waiting_user → running
  // + CAS Turn waiting_user → running
  // + 写 turn.resumed + invocation.resumed Event
  const threadId = loaded.invocation.threadId;
  const turnId = loaded.command.turnId ?? loaded.invocation.turnId;

  const events = await db.transaction(async (tx) => {
    if (!threadId) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // CAS dispatched → acknowledged
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // Invocation waiting_user → running
    await updateInvocationState(tx, params.tenantId, loaded.invocation.id, "running");

    // CAS Turn waiting_user → running（仅在 turnId 存在且 Turn 处于 waiting_user 时）
    if (turnId) {
      const [turnRow] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, turnId))
        .for("update")
        .limit(1);
      if (turnRow && turnRow.turnState === "waiting_user") {
        await tx
          .update(turnTable)
          .set({
            turnState: "running",
            versionNo: turnRow.versionNo + 1,
          })
          .where(eq(turnTable.id, turnId));
      }
    }

    // 写 turn.resumed + invocation.resumed Event（2 个事件，原子分配 sequence）
    // ack 事件使用派生唯一 key（不复用命令的 idempotencyKey，避免与 turn.steer_queued 等队列事件冲突）
    const writtenEvents: ThreadEvent[] = [];
    const startSeq = await allocateEventSequences(tx, threadId, 2);

    if (turnId) {
      const turnResumedEvent = await insertThreadEvent(tx, threadId, startSeq, {
        eventType: "turn.resumed",
        turnId,
        invocationId: loaded.invocation.id,
        actorType,
        actorId: params.actorId ?? undefined,
        payload: {
          command_id: loaded.command.id,
          invocation_id: loaded.invocation.id,
          runtime_acknowledged: true,
        },
        correlationId: params.correlationId ?? undefined,
        idempotencyKey: `resume-ack-turn-${loaded.command.id}`,
      });
      writtenEvents.push(turnResumedEvent);
    }

    const invocationResumedEvent = await insertThreadEvent(tx, threadId, startSeq + 1, {
      eventType: "invocation.resumed",
      turnId: turnId ?? undefined,
      invocationId: loaded.invocation.id,
      actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        command_id: loaded.command.id,
        resume_payload_present: resumePayload !== null && resumePayload !== undefined,
        runtime_acknowledged: true,
      },
      correlationId: params.correlationId ?? undefined,
      idempotencyKey: `resume-ack-inv-${loaded.command.id}`,
    });
    writtenEvents.push(invocationResumedEvent);

    return writtenEvents;
  });

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: undefined,
    acknowledgedAt: new Date(),
    events,
  };
}

/**
 * S09-C06：处理 Runtime 返回 requires_redispatch=true 的 Resume 响应。
 *
 * 事实源：docs/architecture/api-and-events.md L924-928、
 * docs/architecture/persistence.md §13（Worker 失联恢复）。
 *
 * 流程：
 * 1. 事务内：CAS dispatched → acknowledged + CAS Turn waiting_user → running +
 * 写 turn.resumed Event（带 redispatched=true 标记）。不写 invocation.resumed Event
 * （因为不是简单恢复，而是重新调度）。
 * 2. 加载 AgentRevision（如未通过 params 提供，从 ExecutionBinding.agentRevisionId 自动加载）。
 * 3. 调用 redispatchInvocation：
 * - 创建新 Attempt（attemptNo = max+1, queued）
 * - 调用 Runtime startInvocation（带 attempt_no > 1, retry_reason=requires_redispatch）
 * - 标记旧 RuntimeSessionBinding 为 lost
 * - 创建新 RuntimeSessionBinding
 * - CAS Invocation waiting_user → running + CAS Attempt queued → running
 * - 写 invocation.started Event（带 attempt_no + retry_reason + redispatched=true）
 * 4. 返回组合事件（turn.resumed + invocation.started）。
 */
async function handleResumeRequiresRedispatch(
  params: {
    tenantId: string;
    runtimeClient: RuntimeHttpClient;
    agentRevision?: AgentRevision;
    actorType?: ThreadEventActorType;
    actorId?: string | null;
    correlationId?: string | null;
  },
  loaded: LoadedCommand,
  endpointResolution: CommandRuntimeEndpointResolution,
  actorType: ThreadEventActorType,
): Promise<CommandDispatchResult> {
  const threadId = loaded.invocation.threadId;
  const turnId = loaded.command.turnId ?? loaded.invocation.turnId;

  // 校验 gatewayEndpoints 可用（redispatch 需要）
  if (!endpointResolution.gatewayEndpoints) {
    // gatewayEndpoints 缺失：标记命令 failed（不能处理 redispatch）
    await markCommandFailed(
      loaded.command.id,
      "REDISPATCH_GATEWAY_ENDPOINTS_MISSING",
      "Runtime 返回 requires_redispatch=true 但未提供 gatewayEndpoints 解析器",
    );
    return {
      commandId: loaded.command.id,
      commandState: "failed",
      failedAt: new Date(),
      errorCode: "REDISPATCH_GATEWAY_ENDPOINTS_MISSING",
      errorMessage: "Runtime 返回 requires_redispatch=true 但未提供 gatewayEndpoints 解析器",
      events: [],
    };
  }
  const gatewayEndpoints = endpointResolution.gatewayEndpoints;

  // 1. 事务内：CAS dispatched → acknowledged + CAS Turn waiting_user → running + 写 turn.resumed Event
  const turnResumedEvent = await db.transaction(async (tx) => {
    if (!threadId) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // 锁定 Thread 行
    const [thread] = await tx
      .select({ id: threadTable.id })
      .from(threadTable)
      .where(eq(threadTable.id, threadId))
      .for("update")
      .limit(1);
    if (!thread) {
      throw new CommandInvocationNotFoundError(loaded.invocation.id);
    }

    // CAS dispatched → acknowledged
    await transitionCommandToAcknowledged(tx, loaded.command.id);

    // CAS Turn waiting_user → running（不更新 Invocation 状态，由 redispatchInvocation 处理）
    if (turnId) {
      const [turnRow] = await tx
        .select()
        .from(turnTable)
        .where(eq(turnTable.id, turnId))
        .for("update")
        .limit(1);
      if (turnRow && turnRow.turnState === "waiting_user") {
        await tx
          .update(turnTable)
          .set({
            turnState: "running",
            versionNo: turnRow.versionNo + 1,
          })
          .where(eq(turnTable.id, turnId));
      }
    }

    // 写 turn.resumed Event（带 redispatched=true 标记，仅 1 个事件；invocation.started 由 redispatch 写入）
    const seq = await allocateEventSequences(tx, threadId, 1);
    if (!turnId) {
      return null;
    }
    return insertThreadEvent(tx, threadId, seq, {
      eventType: "turn.resumed",
      turnId,
      invocationId: loaded.invocation.id,
      actorType,
      actorId: params.actorId ?? undefined,
      payload: {
        command_id: loaded.command.id,
        invocation_id: loaded.invocation.id,
        runtime_acknowledged: true,
        redispatched: true,
        requires_redispatch: true,
      },
      correlationId: params.correlationId ?? undefined,
      idempotencyKey: `resume-ack-turn-redispatch-${loaded.command.id}`,
    });
  });

  // 2. 加载 AgentRevision（如未通过 params 提供，从 ExecutionBinding.agentRevisionId 自动加载）
  const agentRevision =
    params.agentRevision ?? (await getRevisionById(loaded.binding.agentRevisionId));
  if (!agentRevision) {
    throw new Error(
      `handleResumeRequiresRedispatch: AgentRevision 不存在（id=${loaded.binding.agentRevisionId}）`,
    );
  }

  // 3. 调用 redispatchInvocation（创建新 Attempt + 调用 Runtime startInvocation + 写 invocation.started Event）
  const redispatchResult = await redispatchInvocation({
    tenantId: params.tenantId,
    invocationId: loaded.invocation.id,
    retryReasonCode: "requires_redispatch",
    checkpointRef: null,
    runtimeClient: params.runtimeClient,
    runtimeEndpointResolver: async () => ({
      runtimeEndpoint: endpointResolution.runtimeEndpoint,
      authToken: endpointResolution.authToken,
      gatewayEndpoints,
    }),
    runtimeRevisionId: loaded.binding.runtimeRevisionId,
    agentRevision,
    actorType,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });

  // 4. 返回组合事件
  const events: ThreadEvent[] = [];
  if (turnResumedEvent) {
    events.push(turnResumedEvent);
  }
  if (redispatchResult.invocationStartedEvent) {
    events.push(redispatchResult.invocationStartedEvent);
  }

  return {
    commandId: loaded.command.id,
    commandState: "acknowledged",
    runtimeExecutionRef: redispatchResult.invocation?.runtimeExecutionRef ?? undefined,
    acknowledgedAt: new Date(),
    events,
    redispatched: redispatchResult.redispatched,
  };
}

// ─── Runtime 错误处理（公共） ─────────────────────────────

/**
 * 处理 Runtime HTTP 调用错误。
 *
 * 错误分类（与 dispatcher.ts dispatchToRuntime 一致）：
 * - kind=network → 保持 dispatched（Runtime 不可达，等待重试）。
 * - kind=http + 503 → 保持 dispatched（Runtime 暂不可用，等待重试）。
 * - kind=http + 409 IDEMPOTENCY_CONFLICT → 标记 acknowledged（幂等复用）。
 * - 其他 → 标记 failed（Runtime 拒绝，不伪造成功）。
 */
async function handleRuntimeError(err: unknown, commandId: string): Promise<CommandDispatchResult> {
  if (err instanceof RuntimeHttpClientError) {
    // 网络不可达 → 保持 dispatched（等待重试）
    if (err.kind === "network") {
      return {
        commandId,
        commandState: "dispatched",
        skipped: true,
        skipReason: "runtime_network_unavailable",
        events: [],
      };
    }
    // 503 RUNTIME_UNAVAILABLE → 保持 dispatched（等待重试）
    if (err.kind === "http" && err.httpStatus === 503) {
      return {
        commandId,
        commandState: "dispatched",
        skipped: true,
        skipReason: "runtime_unavailable",
        events: [],
      };
    }
    // 409 IDEMPOTENCY_CONFLICT → 幂等复用，标记 acknowledged
    if (
      err.kind === "http" &&
      err.httpStatus === 409 &&
      err.runtimeErrorCode === "IDEMPOTENCY_CONFLICT"
    ) {
      await markCommandAcknowledged(commandId);
      return {
        commandId,
        commandState: "acknowledged",
        acknowledgedAt: new Date(),
        events: [],
      };
    }
    // 其他 HTTP 错误 → 标记 failed（Runtime 拒绝，不伪造成功）
    const errorCode = err.runtimeErrorCode ?? `HTTP_${err.httpStatus ?? 0}`;
    await markCommandFailed(commandId, errorCode, err.message);
    return {
      commandId,
      commandState: "failed",
      failedAt: new Date(),
      errorCode,
      errorMessage: err.message,
      events: [],
    };
  }
  // 非 RuntimeHttpClientError → 标记 failed
  const errorMessage = err instanceof Error ? err.message : String(err);
  await markCommandFailed(commandId, "UNKNOWN", errorMessage);
  return {
    commandId,
    commandState: "failed",
    failedAt: new Date(),
    errorCode: "UNKNOWN",
    errorMessage,
    events: [],
  };
}
