import { db } from "@/lib/db/client";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import { loadFrozenGovernanceConfig } from "@/lib/governance/governance-repository";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { invocationCommandTable } from "@/lib/persistence/schema/conversation";
import type { ExecutionBinding } from "@/lib/persistence/schema/executions";
import type { HostedRuntimeApplicationService } from "@/lib/runtime/application/hosted-runtime-application-service";
import { hostedRuntimeApplicationService } from "@/lib/runtime/application/production-resume-harness-invocation";
import { resolveEffectiveInvocationCapabilities } from "@/lib/runtime/capabilities/effective-invocation-capabilities";
import {
  type CommandDispatchResult,
  type CommandRuntimeEndpointResolution,
  dispatchCancelCommand,
  dispatchResumeCommand,
  dispatchSteerCommand,
  retryDispatchedInvocationCommand,
} from "@/lib/runtime/command-dispatcher";
import { resolveOutboundRuntimeAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { buildGatewayEndpoints } from "@/lib/runtime/gateway-endpoints";
import { createInProcessHostedRuntimeClient } from "@/lib/runtime/in-process-hosted-runtime";
import { getInvocationById } from "@/lib/runtime/invocation-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import type { RuntimeHttpClient } from "@/lib/runtime/runtime-client";
import { getSessionBindingById } from "@/lib/runtime/session-binding-queries";
import { recoverTrustedExecutionSubject } from "@/lib/runtime/transport/execution-subject";
import { createHttpHarnessRuntimeTransport } from "@/lib/runtime/transport/http-harness-runtime-transport";
import { createRuntimeTransportResolver } from "@/lib/runtime/transport/runtime-transport-resolver";
import { eq } from "drizzle-orm";

let hostedApplicationServiceForTest: HostedRuntimeApplicationService | null = null;

export function setCommandGatewayHostedApplicationServiceForTest(
  service: HostedRuntimeApplicationService | null,
): void {
  hostedApplicationServiceForTest = service;
}

export type CommandGatewayResult =
  | { dispatched: true; command: CommandDispatchResult }
  | { dispatched: false; reason: "command_not_found" | "unsupported_capability" };

async function loadCommandContext(tenantId: string, commandId: string) {
  const [command] = await db
    .select({
      id: invocationCommandTable.id,
      invocationId: invocationCommandTable.invocationId,
      commandType: invocationCommandTable.commandType,
    })
    .from(invocationCommandTable)
    .where(eq(invocationCommandTable.id, commandId))
    .limit(1);
  if (!command?.invocationId) return null;
  const invocation = await getInvocationById(tenantId, command.invocationId);
  if (!invocation) return null;
  const binding = await getExecutionBindingByInvocation(tenantId, command.invocationId);
  if (!binding) return null;
  recoverTrustedExecutionSubject(binding, tenantId);
  const runtimeRevision = await getRuntimeRevisionById(binding.runtimeRevisionId);
  if (
    !runtimeRevision ||
    runtimeRevision.protocolType !== "harness_runtime_protocol" ||
    runtimeRevision.runtimeEvidenceKind !== binding.runtimeEvidenceKind ||
    runtimeRevision.runtimeTargetDigest !== binding.runtimeTargetDigest
  ) {
    return null;
  }
  return { command, invocation, binding, runtimeRevision };
}

async function resolveTransport(
  tenantId: string,
  context: NonNullable<Awaited<ReturnType<typeof loadCommandContext>>>,
): Promise<{
  runtimeClient: RuntimeHttpClient;
  endpointResolver: (binding: ExecutionBinding) => Promise<CommandRuntimeEndpointResolution>;
}> {
  const isExternal = context.runtimeRevision.runtimeEvidenceKind === "external_endpoint";
  const endpoint = isExternal ? context.runtimeRevision.endpointRef : "in-process://hosted";
  const auth = isExternal
    ? await resolveOutboundRuntimeAuth({
        tenantId,
        identityMode: context.runtimeRevision.identityMode,
        credentialRefId: context.runtimeRevision.credentialRefId,
      })
    : {
        mode: "workload_token" as const,
        token: issueWorkloadToken({
          type: "runtime",
          tenantId,
          invocationId: context.invocation.id,
          runtimeRevisionId: context.binding.runtimeRevisionId,
          audience: "runtime",
          expiresAt: Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime,
        }),
      };
  const resolver = createRuntimeTransportResolver({
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
  });
  const runtimeClient = await resolver({
    protocolType: context.runtimeRevision.protocolType,
    runtimeEvidenceKind: context.runtimeRevision.runtimeEvidenceKind,
    endpoint,
    auth,
  });
  return {
    runtimeClient,
    endpointResolver: async (binding) => {
      const gatewayExpiresAt = Date.now() + WORKLOAD_TOKEN_DEFAULT_TTL_MS.gateway;
      const frozenGovernance = await loadFrozenGovernanceConfig(
        tenantId,
        binding.governanceConfigRevisionId,
      );
      return {
        runtimeEndpoint: endpoint,
        auth,
        gatewayEndpoints: buildGatewayEndpoints({
          external: context.runtimeRevision.runtimeEvidenceKind === "external_endpoint",
        }),
        governanceConfig: {
          revision_id: binding.governanceConfigRevisionId,
          config_digest: binding.governanceConfigDigest,
          config: frozenGovernance.config as unknown as Record<string, unknown>,
        },
        gatewayAccess: {
          access_token: issueWorkloadToken({
            type: "gateway",
            tenantId,
            invocationId: context.invocation.id,
            runtimeRevisionId: binding.runtimeRevisionId,
            audience: "gateway",
            expiresAt: gatewayExpiresAt,
          }),
          expires_at: new Date(gatewayExpiresAt).toISOString(),
        },
      };
    },
  };
}

async function dispatchCommand(params: {
  tenantId: string;
  commandId: string;
  expectedType: "interrupt" | "resume" | "steer";
  actorId?: string | null;
  correlationId?: string | null;
  retry?: boolean;
}): Promise<CommandGatewayResult> {
  const context = await loadCommandContext(params.tenantId, params.commandId);
  if (!context || context.command.commandType !== params.expectedType) {
    return { dispatched: false, reason: "command_not_found" };
  }
  const sessionBinding = context.invocation.runtimeSessionBindingId
    ? await getSessionBindingById(params.tenantId, context.invocation.runtimeSessionBindingId)
    : null;
  const capabilities = await resolveEffectiveInvocationCapabilities({
    tenantId: params.tenantId,
    binding: context.binding,
    ...(context.invocation.runtimeSessionBindingId
      ? { sessionCapabilitiesJson: sessionBinding?.runtimeCapabilitiesJson ?? null }
      : {}),
  });
  const supported =
    params.expectedType === "interrupt"
      ? capabilities.cancel
      : params.expectedType === "resume"
        ? capabilities.resume
        : capabilities.steer;
  if (!supported) return { dispatched: false, reason: "unsupported_capability" };

  const transport = await resolveTransport(params.tenantId, context);
  const common = {
    tenantId: params.tenantId,
    commandId: params.commandId,
    runtimeClient: transport.runtimeClient,
    runtimeEndpointResolver: transport.endpointResolver,
    actorType: "user" as const,
    actorId: params.actorId,
    correlationId: params.correlationId,
  };
  const command = params.retry
    ? await retryDispatchedInvocationCommand(common)
    : params.expectedType === "interrupt"
      ? await dispatchCancelCommand(common)
      : params.expectedType === "resume"
        ? await dispatchResumeCommand(common)
        : await dispatchSteerCommand(common);
  return { dispatched: true, command };
}

export function dispatchInterruptCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, expectedType: "interrupt" });
}

export function dispatchResumeCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, expectedType: "resume" });
}

export function dispatchSteerCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  return dispatchCommand({ ...params, expectedType: "steer" });
}

export async function retryDispatchedCommandToRuntime(params: {
  tenantId: string;
  commandId: string;
  actorId?: string | null;
  correlationId?: string | null;
}): Promise<CommandGatewayResult> {
  const context = await loadCommandContext(params.tenantId, params.commandId);
  if (!context) return { dispatched: false, reason: "command_not_found" };
  if (
    context.command.commandType !== "interrupt" &&
    context.command.commandType !== "resume" &&
    context.command.commandType !== "steer"
  ) {
    return { dispatched: false, reason: "command_not_found" };
  }
  return dispatchCommand({
    ...params,
    expectedType: context.command.commandType,
    retry: true,
  });
}
