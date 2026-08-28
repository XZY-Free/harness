import { db } from "@/lib/db/client";
/**
 * 命令调度生产网关（08 §5/§6，Batch 10）。
 *
 * Interrupt（Cancel）/ Resume 命令入队后的生产接线：按 ExecutionBinding 的
 * RuntimeRevision.protocolType 解析 Transport 并调度到 Runtime。
 *
 * 专题01 冻结架构：A2A 不再是 Harness Runtime 协议。Runtime 只有
 * `harness_runtime_protocol`（hosted in-process），无远端协议端点可调，
 * 命令保持队列由 Turn/Invocation 状态机与 in-process adapter 吸收（04 §10）。
 * 网关因此只保留门禁（command_not_found / unsupported_capability）与
 * protocol_not_remote 的 hosted 语义；A2A 真实远端命令调度属后续批次
 * AgentCall 语义，不在本网关范围。
 */
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import type { CommandDispatchResult } from "@/lib/runtime/command-dispatcher";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { eq } from "drizzle-orm";

/**
 * 网关调度结果（03 §3 判别联合）：hosted 协议下恒为 protocol_not_remote
 * （命令留在队列由状态机吸收）；command_not_found / unsupported_capability
 * 是真实失败。真正远端调度（A2A）属后续 AgentCall 批次。
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
 * 调度 Interrupt（Cancel）命令。hosted 协议无远端端点，命令保持队列由
 * 既有状态机吸收（protocol_not_remote）；effective cancel=false → 真实失败。
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
  // 05 §8：命令网关门禁 —— 依据 Binding 重新检查 effective cancel；
  // false → 明确返回 unsupported reason（不发送任何网络请求）。
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: ctx.binding,
  });
  if (!capabilities.cancel) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  // 冻结架构：Runtime 仅 harness_runtime_protocol（in-process hosted），无远端端点。
  return { dispatched: false, reason: "protocol_not_remote" };
}

/**
 * 调度 Resume 命令。hosted 协议无远端端点，命令保持队列由既有状态机吸收
 * （protocol_not_remote）；effective resume=false → 真实失败。
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
  // 05 §11：Resume 沿同一 Effective Capability 模型门禁。
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: ctx.binding,
  });
  if (!capabilities.resume) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  // 冻结架构：Runtime 仅 harness_runtime_protocol（in-process hosted），无远端端点。
  return { dispatched: false, reason: "protocol_not_remote" };
}

/**
 * Durable Retry Worker 命令 lane 网关入口：对已 dispatched 的命令重新发起远端调度。
 *
 * 冻结架构下 hosted 协议无远端端点，恒返回 protocol_not_remote；仍保留命令类型
 * 的 effective capability 门禁（unsupported_capability 是真实失败）。命令不在
 * dispatched 状态（已被并发处理/终态）→ command_not_found 语义的 no-op。
 */
export async function retryDispatchedCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  const ctx = await loadCommandContext(params.tenantId, params.commandId);
  if (!ctx) return { dispatched: false, reason: "command_not_found" };
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: ctx.binding,
  });
  const commandType = await (async () => {
    const [row] = await db
      .select({ commandType: invocationCommandTable.commandType })
      .from(invocationCommandTable)
      .where(eq(invocationCommandTable.id, params.commandId))
      .limit(1);
    return row?.commandType ?? null;
  })();
  if (commandType === "interrupt" && !capabilities.cancel) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  if (commandType === "resume" && !capabilities.resume) {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  // 冻结架构：Runtime 仅 harness_runtime_protocol（in-process hosted），无远端端点。
  return { dispatched: false, reason: "protocol_not_remote" };
}
