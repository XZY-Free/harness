import { db } from "@/lib/db/client";
/**
 * 命令调度生产网关（08 §5/§6，Batch 10）。
 *
 * Interrupt（Cancel）/ Resume 命令入队后的生产接线：按 ExecutionBinding 的
 * RuntimeRevision.protocolType 解析 Transport 并调度到 Runtime。
 *
 * 协议能力边界（04 §10：协议驱动，无行为回退）：
 * - protocolType=a2a（external endpoint）：cancel → tasks/cancel、resume → message/send
 *   真实远端调用（08 §5/§6 平台完成条件：真实发出协议调用 + 远端终态推进）；
 * - protocolType=agent_runtime_protocol（hosted in-process）：hosted 执行模型由
 *   Turn/Invocation 状态机与 in-process adapter 吸收命令（无远端协议端点可调），
 *   网关返回 skipped，命令保持在队列由既有状态机处理。
 */
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import {
  type CommandRuntimeEndpointResolution,
  dispatchCancelCommand,
  dispatchResumeCommand,
} from "@/lib/runtime/command-dispatcher";
import { IngressInvocationTerminalError, InvocationStateConflictError } from "@/lib/runtime/errors";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import { getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import { and, eq } from "drizzle-orm";

/** 网关调度结果。 */
export interface CommandGatewayResult {
  /** 是否真正执行了协议调度（false = 非 A2A 协议或命令不存在，由既有状态机吸收）。 */
  dispatched: boolean;
  /** 未调度原因。 */
  reason?: "command_not_found" | "protocol_not_remote";
}

/** 查询命令关联的 Invocation + Binding（跨租户隔离）。 */
async function loadCommandContext(tenantId: string, commandId: string) {
  const [command] = await db
    .select({ id: invocationCommandTable.id, invocationId: invocationCommandTable.invocationId })
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);
  if (!command?.invocationId) return null;
  // 租户隔离由 Invocation/Binding 查询保证（命令表本身无租户列）。
  const invocation = await getInvocationById(tenantId, command.invocationId);
  if (!invocation) return null;
  const binding = await getExecutionBindingByInvocation(tenantId, command.invocationId);
  if (!binding) return null;
  return { command, invocation, binding };
}

/**
 * 按协议解析命令 Transport + endpoint resolver（A2A 真实远端）。
 * 非 a2a 协议返回 null（网关跳过）。
 */
async function resolveA2ACommandTransport(params: {
  tenantId: string;
  binding: ExecutionBinding;
}): Promise<{
  transport: ReturnType<typeof createA2ATransport>;
  endpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
} | null> {
  const runtimeRevision = await getRuntimeRevisionById(params.binding.runtimeRevisionId);
  if (!runtimeRevision) return null;
  if (runtimeRevision.protocolType !== "a2a") return null;
  const endpoint = runtimeRevision.endpointRef;

  const transport = createA2ATransport({
    eventBatchSink: async ({ invocationId, events }) => {
      // 逐事件提交（与 Hosted Agent Loop 语义一致，hosted-adapter 6 步：response.completed
      // 与 execution.completed 分批提交）。容错规则：
      // - IngressInvocationTerminalError（response.completed 已推进终态，后续
      //   execution.completed 属"终态后事件"）→ 按平台既有容错语义忽略；
      // - waiting_user→终态冲突（远端已接受 Resume 但 dispatcher 尚未推进 running）→
      //   先执行 Resume 本身的 waiting_user→running 恢复转换再重试该事件；
      // - 其余错误上抛（transport fail-closed，不 false ack）。
      for (const event of events) {
        try {
          await ingressEventBatch({
            tenantId: params.tenantId,
            invocationId,
            events: [event],
            producerSequenceStart: event.producer_sequence,
          });
        } catch (err) {
          if (err instanceof InvocationStateConflictError) {
            const invocation = await getInvocationById(params.tenantId, invocationId);
            if (invocation?.executionState === "waiting_user") {
              await db.transaction(async (tx) => {
                await updateInvocationState(tx, params.tenantId, invocationId, "running");
              });
              await ingressEventBatch({
                tenantId: params.tenantId,
                invocationId,
                events: [event],
                producerSequenceStart: event.producer_sequence,
              });
              continue;
            }
            throw err;
          }
          if (err instanceof IngressInvocationTerminalError) {
            continue;
          }
          throw err;
        }
      }
    },
    resolveRuntimeRefs: async (invocationId) => {
      const invocation = await getInvocationById(params.tenantId, invocationId);
      if (!invocation) return null;
      const bindingRow = invocation.runtimeSessionBindingId
        ? await getSessionBindingById(params.tenantId, invocation.runtimeSessionBindingId)
        : null;
      return {
        runtimeExecutionRef: invocation.runtimeExecutionRef,
        runtimeSessionRef: bindingRow?.externalSessionRef ?? null,
      };
    },
    // resume 事件序号重定位：MAX(producer_sequence)+1（租户隔离查询；Invocation
    // 不存在/跨租户返回 null → transport fail-closed；无进程内计数器）。
    resolveNextProducerSequence: async (invocationId) => {
      const latest = await getLatestProducerSequence(params.tenantId, invocationId);
      return latest === null ? null : latest + 1;
    },
  });

  const endpointResolver = async (binding: ExecutionBinding) => ({
    runtimeEndpoint: endpoint,
    authToken: issueWorkloadToken({
      type: "runtime",
      tenantId: params.tenantId,
      invocationId: binding.invocationId,
      runtimeRevisionId: binding.runtimeRevisionId,
      audience: "runtime",
      expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
    }),
    // §27/§28：Resume 必须携带重新签发的 Gateway Access Token（新 jti/expiry）。
    gatewayAccess: {
      access_token: issueWorkloadToken({
        type: "gateway",
        tenantId: params.tenantId,
        invocationId: binding.invocationId,
        audience: "gateway",
        expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway,
      }),
      expires_at: new Date(Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway).toISOString(),
    },
  });

  return { transport, endpointResolver };
}

/**
 * 调度 Interrupt（Cancel）命令（08 §6：真实 tasks/cancel + 远端终态推进）。
 * 仅供生产 route 在 requestInterrupt 后调用；幂等由命令状态机保证。
 */
export async function dispatchInterruptCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  const ctx = await loadCommandContext(params.tenantId, params.commandId);
  if (!ctx) return { dispatched: false, reason: "command_not_found" };
  const a2a = await resolveA2ACommandTransport({ tenantId: params.tenantId, binding: ctx.binding });
  if (!a2a) return { dispatched: false, reason: "protocol_not_remote" };

  await dispatchCancelCommand({
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: a2a.transport,
    runtimeEndpointResolver: a2a.endpointResolver,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });
  return { dispatched: true };
}

/**
 * 调度 Resume 命令（08 §5：继续原 Invocation/taskId/contextId，不新建 continuation）。
 * 仅供生产 route 在 UserAction resolve 后调用；幂等由命令状态机保证。
 */
export async function dispatchResumeCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  const ctx = await loadCommandContext(params.tenantId, params.commandId);
  if (!ctx) return { dispatched: false, reason: "command_not_found" };
  const a2a = await resolveA2ACommandTransport({ tenantId: params.tenantId, binding: ctx.binding });
  if (!a2a) return { dispatched: false, reason: "protocol_not_remote" };

  await dispatchResumeCommand({
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: a2a.transport,
    runtimeEndpointResolver: a2a.endpointResolver,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });
  return { dispatched: true };
}
