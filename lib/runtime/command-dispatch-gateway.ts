import { buildBoundAgentInvocationContext } from "@/lib/context/enrichment/build-bound-agent-invocation-context";
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
import { invocationCommandTable, threadTable } from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import {
  type CommandDispatchResult,
  type CommandRuntimeEndpointResolution,
  dispatchCancelCommand,
  dispatchResumeCommand,
} from "@/lib/runtime/command-dispatcher";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { IngressInvocationTerminalError, InvocationStateConflictError } from "@/lib/runtime/errors";
import { ingressEventBatch } from "@/lib/runtime/event-ingress-queries";
import { getInvocationById, updateInvocationState } from "@/lib/runtime/invocation-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { getLatestProducerSequence } from "@/lib/runtime/recovery-queries";
import { getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { createA2ATransport } from "@/lib/runtime/transport/a2a-transport";
import { executionSubjectFromUserIdentity } from "@/lib/runtime/transport/execution-subject";
import { and, eq } from "drizzle-orm";

/**
 * 网关调度结果（03 §3 判别联合）：真正远端调度时携带真实 CommandDispatchResult
 * （acknowledged/dispatched/failed），调用方不得丢弃；skipped 携带稳定 reason。
 */
export type CommandGatewayResult =
  | { dispatched: true; command: CommandDispatchResult }
  | {
      dispatched: false;
      reason: "command_not_found" | "protocol_not_remote" | "unsupported_capability";
    };

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
  /** 05 §6：Transport 冻结能力 profile（Binding 派生）。 */
  capabilities: { cancel: boolean; resume: boolean; steer: boolean };
}): Promise<{
  transport: ReturnType<typeof createA2ATransport>;
  endpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
} | null> {
  const runtimeRevision = await getRuntimeRevisionById(params.binding.runtimeRevisionId);
  if (!runtimeRevision) return null;
  if (runtimeRevision.protocolType !== "a2a") return null;
  const endpoint = runtimeRevision.endpointRef;

  const transport = createA2ATransport({
    // 05 §6：Transport 创建即获得冻结能力 profile（Binding 派生）。
    capabilities: params.capabilities,
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

  // 03 §11：Cancel/Resume 的 outbound auth 只能来自唯一 resolver
  // （Binding.runtimeRevisionId → RuntimeRevision → resolveOutboundRuntimeAuth）；
  // 不再给第三方 Agent 签内部 Workload Token。Resume 同时携带的新签发
  // Gateway Access Token（gatewayAccess）职责完全不同，二者不混用。
  const endpointResolver = async (binding: ExecutionBinding) => ({
    runtimeEndpoint: endpoint,
    auth: await resolveOutboundRuntimeAuth({
      tenantId: params.tenantId,
      identityMode: runtimeRevision.identityMode,
      credentialRefId: runtimeRevision.credentialRefId,
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
  // 05 §8：命令网关二次门禁 —— 依据 Binding 重新检查 effective cancel；
  // false → 不发 tasks/cancel，明确返回 unsupported reason（不发任何网络请求）。
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: ctx.binding,
  });
  if (!capabilities.cancel) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  const a2a = await resolveA2ACommandTransport({
    tenantId: params.tenantId,
    binding: ctx.binding,
    capabilities: {
      cancel: capabilities.cancel,
      resume: capabilities.resume,
      steer: capabilities.steer,
    },
  });
  if (!a2a) return { dispatched: false, reason: "protocol_not_remote" };

  const command = await dispatchCancelCommand({
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: a2a.transport,
    runtimeEndpointResolver: a2a.endpointResolver,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
  });
  return { dispatched: true, command };
}

/**
 * 04 §6：从持久化 Authority 重建 trusted ExecutionSubject（Resume retry 可脱离
 * 原 HTTP request）。固定来源：Invocation 所属 Thread owner；actorId（UAR
 * resolvedBy 语义）与 owner 不一致 → fail closed，绝不取当前登录用户覆盖原 subject。
 */
async function resolveResumeExecutionSubject(params: {
  tenantId: string;
  invocationThreadId: string | null;
  actorId?: string | null;
}) {
  if (!params.invocationThreadId) return null;
  const [thread] = await db
    .select({ tenantId: threadTable.tenantId, ownerUserId: threadTable.ownerUserId })
    .from(threadTable)
    .where(eq(threadTable.id, params.invocationThreadId))
    .limit(1);
  if (!thread || thread.tenantId !== params.tenantId) return null;
  if (params.actorId && params.actorId !== thread.ownerUserId) {
    throw new Error(
      "dispatchResumeCommandToRuntime: Resume actor 与 Thread owner 不一致（fail closed）",
    );
  }
  return executionSubjectFromUserIdentity(params.tenantId, thread.ownerUserId);
}

/**
 * 调度 Resume 命令（08 §5：继续原 Invocation/taskId/contextId，不新建 continuation）。
 * 仅供生产 route 在 UserAction resolve 后调用；幂等由命令状态机保证。
 *
 * 04 专项：每次真正 dispatch 前重新做 Binding-frozen Context Enrichment
 * （same task/context、same trusted subject、fresh current_datetime），并把 supplied
 * entries 经 invocation_context 传入 Transport（Transport 只做 wire 映射）。
 */
export async function dispatchResumeCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  const ctx = await loadCommandContext(params.tenantId, params.commandId);
  if (!ctx) return { dispatched: false, reason: "command_not_found" };
  // 05 §11：Resume 沿同一 Effective Capability 模型门禁；false 不兜底新建 Invocation。
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: ctx.binding,
  });
  if (!capabilities.resume) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  const a2a = await resolveA2ACommandTransport({
    tenantId: params.tenantId,
    binding: ctx.binding,
    capabilities: {
      cancel: capabilities.cancel,
      resume: capabilities.resume,
      steer: capabilities.steer,
    },
  });
  if (!a2a) return { dispatched: false, reason: "protocol_not_remote" };

  const executionSubject = await resolveResumeExecutionSubject({
    tenantId: params.tenantId,
    invocationThreadId: ctx.invocation.threadId,
    actorId: params.actorId ?? null,
  });

  const command = await dispatchResumeCommand({
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: a2a.transport,
    runtimeEndpointResolver: a2a.endpointResolver,
    actorId: params.actorId ?? null,
    correlationId: params.correlationId ?? null,
    // 04 §5/§7：Context 在 Harness dispatch 层构建（Transport 不猜上下文）；
    // now 每次 dispatch 刷新（retry 的 current_datetime 可以变化）。
    resolveInvocationContext: async () => {
      const bundle = await buildBoundAgentInvocationContext({
        tenantId: params.tenantId,
        binding: {
          agentContractSnapshotId: ctx.binding.agentContractSnapshotId,
          agentContextDigest: ctx.binding.agentContextDigest,
        },
        executionSubject,
        now: new Date(),
      });
      if (!bundle) return null;
      return bundle.entries
        .filter((entry) => entry.supplied)
        .map((entry) => ({ context_kind: entry.contextKind, value: entry.value }));
    },
  });
  return { dispatched: true, command };
}
