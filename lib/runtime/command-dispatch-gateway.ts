import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  executionOwnershipTable,
  invocationCommandTable,
} from "@/lib/persistence/schema/executions";
import type {
  ExecutionBinding,
  ExecutionOwnership,
  Invocation,
  InvocationCommand,
  RuntimeSessionBinding,
} from "@/lib/persistence/schema/executions";
import type { RuntimeRevisionRow } from "@/lib/persistence/schema/runtimes";
import type { ExecutionResourcePurpose } from "@/lib/runtime/application/execution-resources";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/runtime-resume";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import {
  type CommandDispatchResult,
  type CommandRuntimeEndpointResolution,
  dispatchCancelCommand,
  dispatchCheckpointCommand,
  dispatchResumeCommand,
  dispatchSteerCommand,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import {
  getRuntimeSessionBindingById,
  getRuntimeSessionBindingsByInvocation,
} from "@/lib/runtime/persistence/runtime-session-store";
import { settleSupersededInvocationCommand } from "@/lib/runtime/retry/dispatch-retry-queries";
import {
  type BoundExecutionResources,
  resolveBoundExecutionResources,
} from "@/lib/runtime/retry/runtime-transport-from-binding";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
/** Builds the Runtime transport for durable InvocationCommand delivery. */
import { and, eq, sql } from "drizzle-orm";

let hostedApplicationServiceForTest: HostedRuntimeApplicationService | null = null;

export function setCommandGatewayHostedApplicationServiceForTest(
  service: HostedRuntimeApplicationService | null,
): void {
  hostedApplicationServiceForTest = service;
}

export type CommandGatewayResult =
  | { dispatched: true; command: CommandDispatchResult }
  | {
      dispatched: false;
      reason: "command_not_found" | "unsupported_capability" | "target_superseded";
    };

type CommandContextLoad =
  | {
      ok: true;
      command: InvocationCommand;
      invocation: Invocation;
      binding: ExecutionBinding;
      owner: ExecutionOwnership | null;
      session: RuntimeSessionBinding | null;
      revision: RuntimeRevisionRow;
    }
  | { ok: false; reason: "command_not_found" | "target_superseded" };

/**
 * R03 §6：命令的目标在**正式接受时**固定。
 *
 * - `cancel`/`steer`/`checkpoint`：只按 `targetOwnershipId` + `targetSessionId` 读取冻结
 *   目标，绝不回落到"当前 active ownership"；目标缺失或已失效 → `target_superseded`
 *   （不把同一命令重定向新 Owner）。
 * - `resume`：目标是 Invocation 本身而非某一代际，Session 仅用于读 effective capability，
 *   因此允许按 Invocation 取最近一条 SessionBinding。
 */
async function loadContext(tenantId: string, commandId: string): Promise<CommandContextLoad> {
  const [command] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!command) return { ok: false, reason: "command_not_found" };
  const invocation = await getInvocationById(tenantId, command.invocationId);
  const binding = invocation
    ? await getExecutionBindingByInvocation(tenantId, invocation.id)
    : null;
  const isResume = command.commandType === "resume";
  const ownerRows =
    invocation && command.targetOwnershipId
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
  const owner = ownerRows[0] ?? null;
  const session = invocation
    ? command.targetSessionId
      ? await getRuntimeSessionBindingById(tenantId, command.targetSessionId)
      : isResume
        ? ((await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id))[0] ?? null)
        : null
    : null;
  const revision = binding ? await getRuntimeRevisionById(binding.runtimeRevisionId) : null;
  if (!invocation || !binding || !revision) return { ok: false, reason: "command_not_found" };
  if (!isResume) {
    // 冻结目标必须仍然有效：Owner 属于本 Invocation、仍 active，Session 与它一一对应。
    if (
      !owner ||
      owner.ownershipState !== "active" ||
      !session ||
      session.ownershipId !== owner.id ||
      session.leaseEpoch !== owner.leaseEpoch
    ) {
      return { ok: false, reason: "target_superseded" };
    }
  }
  return { ok: true, command, invocation, binding, owner, session, revision };
}

async function resolveTransport(
  tenantId: string,
  context: Extract<CommandContextLoad, { ok: true }>,
): Promise<{ client: RuntimeTransport; endpoint: CommandRuntimeEndpointResolution }> {
  const external = context.revision.runtimeEvidenceKind === "external_endpoint";
  // A05：Resume 需要与**请求内联调度**同源的受管执行资源（Workspace 执行资源 +
  // Environment Provisioner）。它们只能来自同一份冻结 Binding，调用方不得另拼；
  // 缺了它们，默认命令网关上的 MANAGED Resume 会在"没有 Provisioner"上直接变成
  // 终态失败 —— 同一份持久意图在请求内联路径可执行、在正式恢复路径不可恢复。
  //
  // 只在需要它们的命令上解析：
  // - `resume`：受管 Environment（Provisioner）+ Workspace 执行资源；
  // - `checkpoint`：Checkpoint 生产者必须拿到带 `snapshotStorageRoot` 的真实写根，
  //   否则默认路径恒 `WorkspaceNotReady`（同一类"接线缺参"缺陷）。
  // - `cancel`/`steer` 不需要写根与实例：不该因为"部署没配受管 WorkspaceHost"而被拒。
  const managedResourcePurpose: ExecutionResourcePurpose | null =
    context.command.commandType === "resume"
      ? "resume"
      : context.command.commandType === "checkpoint"
        ? "recovery"
        : null;
  const managedResources: BoundExecutionResources = managedResourcePurpose
    ? await resolveBoundExecutionResources({
        tenantId,
        binding: context.binding,
        purpose: managedResourcePurpose,
      })
    : {};
  const endpoint = external ? context.revision.endpointRef : "http://127.0.0.1";
  const authority =
    context.owner && context.session
      ? {
          invocationId: context.invocation.id,
          runtimeRevisionId: context.binding.runtimeRevisionId,
          attemptId: context.owner.attemptId,
          ownershipId: context.owner.id,
          leaseEpoch: String(context.owner.leaseEpoch),
          sessionBindingId: context.session.id,
        }
      : null;
  const auth = external
    ? await resolveOutboundRuntimeAuth({
        tenantId,
        identityMode: context.revision.identityMode,
        credentialRefId: context.revision.credentialRefId,
      })
    : authority
      ? {
          mode: "workload_token" as const,
          token: issueWorkloadToken({
            contractVersion: 3,
            type: "execution",
            tenantId,
            ...authority,
            audience: "runtime",
            expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
          }),
        }
      : { mode: "workload_token" as const, token: "in-process-runtime" };
  const client = await createRuntimeTransportResolver({
    factories: {
      harness_runtime_protocol: {
        hosted_artifact: () =>
          createInProcessHostedRuntimeClient({
            tenantId,
            publishedCapabilityEvidence: {
              runtimeRevisionId: context.revision.id,
              runtimeCapabilitiesJson: context.revision.runtimeCapabilitiesJson,
            },
            applicationService: hostedApplicationServiceForTest ?? hostedRuntimeApplicationService,
          }),
        external_endpoint: ({ endpoint: externalEndpoint, auth: externalAuth }) =>
          createHttpHarnessRuntimeTransport({ endpoint: externalEndpoint, auth: externalAuth }),
      },
    },
  })({
    protocolType: context.revision.protocolType,
    runtimeEvidenceKind: context.revision.runtimeEvidenceKind,
    endpoint,
    auth,
  });
  return {
    client,
    endpoint: {
      runtimeEndpoint: endpoint,
      auth,
      callbackEndpoints: buildGatewayEndpoints({ external, invocationId: context.invocation.id }),
      ...managedResources,
    },
  };
}

/**
 * R03 §6：目标失效（`target_superseded`）的唯一终态收口入口。
 *
 * 目标失效在到达 dispatcher 之前就可能被判出；此时必须同样落终态，否则
 * `queued` 行无人扫描、`dispatched` 行会被维护 lane 每 30s 反复领取，永不排空。
 */
async function settleIfSuperseded(
  params: CommandGatewayInput,
  reason: "command_not_found" | "target_superseded",
): Promise<void> {
  if (reason !== "target_superseded") return;
  await settleSupersededInvocationCommand({
    tenantId: params.tenantId,
    commandId: params.commandId,
    claimToken: params.claimToken ?? null,
  });
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  type: "cancel" | "resume" | "steer" | "checkpoint";
  retry?: boolean;
  /** R04 §5：维护 lane 领取到的 claim 令牌；请求内联路径为 undefined。 */
  claimToken?: string;
}): Promise<CommandGatewayResult> {
  const loaded = await loadContext(params.tenantId, params.commandId);
  if (!loaded.ok) {
    await settleIfSuperseded(params, loaded.reason);
    return { dispatched: false, reason: loaded.reason };
  }
  const context = loaded;
  if (context.command.commandType !== params.type)
    return { dispatched: false, reason: "command_not_found" };
  // Resume 前置 capability 门控：effective capability（SessionBinding 冻结快照与
  // RuntimeRevision 发布事实的交集；session 缺省时回退发布事实，形状不可识别一律
  // fail-closed）未声明 resume 时零网络拒绝，不产生 transport 调用。
  if (params.type === "resume") {
    const capabilities = await resolveEffectiveInvocationCapabilities({
      tenantId: params.tenantId,
      binding: context.binding,
      ...(context.session
        ? { sessionCapabilitiesJson: context.session.runtimeCapabilitiesJson }
        : {}),
    });
    if (!capabilities.resume) return { dispatched: false, reason: "unsupported_capability" };
  }
  const transport = await resolveTransport(params.tenantId, context);
  const input = {
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: transport.client,
    runtimeEndpointResolver: async (_binding: ExecutionBinding) => transport.endpoint,
    ...(params.claimToken ? { claimToken: params.claimToken } : {}),
  };
  const command = params.retry
    ? await retryDispatchedInvocationCommand(input)
    : params.type === "cancel"
      ? await dispatchCancelCommand(input)
      : params.type === "resume"
        ? await dispatchResumeCommand(input)
        : params.type === "steer"
          ? await dispatchSteerCommand(input)
          : await dispatchCheckpointCommand(input);
  return { dispatched: true, command };
}

type CommandGatewayInput = {
  tenantId: string;
  commandId: string;
  actorId?: string;
  correlationId?: string;
  /** R04 §5：维护 lane 领取到的 claim 令牌（重投时用于复核完成身份）。 */
  claimToken?: string;
};

export function dispatchInterruptCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "cancel" });
}
export function dispatchResumeCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "resume" });
}
export function dispatchSteerCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "steer" });
}
export function dispatchCheckpointCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, type: "checkpoint" });
}
export async function retryDispatchedCommandToRuntime(
  params: CommandGatewayInput,
): Promise<CommandGatewayResult> {
  const loaded = await loadContext(params.tenantId, params.commandId);
  if (!loaded.ok) {
    await settleIfSuperseded(params, loaded.reason);
    return { dispatched: false, reason: loaded.reason };
  }
  const type = loaded.command.commandType;
  if (type !== "cancel" && type !== "resume" && type !== "steer" && type !== "checkpoint") {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  // 重投沿用冻结目标；目标失效同样返回 target_superseded，不追随 current。
  return dispatchCommand({ ...params, type, retry: true });
}
