import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import {
  executionOwnershipTable,
  invocationCommandTable,
} from "@/lib/persistence/schema/executions";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
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
  | { dispatched: false; reason: "command_not_found" | "unsupported_capability" };

async function loadContext(tenantId: string, commandId: string) {
  const [command] = await db
    .select()
    .from(invocationCommandTable)
    .where(
      and(eq(invocationCommandTable.tenantId, tenantId), eq(invocationCommandTable.id, commandId)),
    )
    .limit(1);
  if (!command) return null;
  const invocation = await getInvocationById(tenantId, command.invocationId);
  const binding = invocation
    ? await getExecutionBindingByInvocation(tenantId, invocation.id)
    : null;
  const ownerRows = invocation
    ? command.targetOwnershipId
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
          .limit(1)
    : [];
  const [owner] = ownerRows;
  // Session 与 Current Authority 绑定：targetSessionId 缺省时按 invocation 解析
  // 最近一条 SessionBinding，供 effective capability 事实读取。
  const session = invocation
    ? command.targetSessionId
      ? await getRuntimeSessionBindingById(tenantId, command.targetSessionId)
      : ((await getRuntimeSessionBindingsByInvocation(tenantId, invocation.id))[0] ?? null)
    : null;
  const revision = binding ? await getRuntimeRevisionById(binding.runtimeRevisionId) : null;
  if (!invocation || !binding || !revision) return null;
  if (command.commandType !== "resume" && (!owner || !session)) return null;
  return { command, invocation, binding, owner, session, revision };
}

async function resolveTransport(
  tenantId: string,
  context: NonNullable<Awaited<ReturnType<typeof loadContext>>>,
): Promise<{ client: RuntimeTransport; endpoint: CommandRuntimeEndpointResolution }> {
  const external = context.revision.runtimeEvidenceKind === "external_endpoint";
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
    },
  };
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  type: "cancel" | "resume" | "steer" | "checkpoint";
  retry?: boolean;
}): Promise<CommandGatewayResult> {
  const context = await loadContext(params.tenantId, params.commandId);
  if (!context || context.command.commandType !== params.type)
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
  const context = await loadContext(params.tenantId, params.commandId);
  if (
    !context ||
    !["cancel", "resume", "steer", "checkpoint"].includes(context.command.commandType)
  )
    return { dispatched: false, reason: "command_not_found" };
  const type = context.command.commandType;
  if (type !== "cancel" && type !== "resume" && type !== "steer" && type !== "checkpoint") {
    return { dispatched: false, reason: "unsupported_capability" };
  }
  return dispatchCommand({ ...params, type, retry: true });
}
