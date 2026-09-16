import { randomUUID } from "node:crypto";
import type {
  CancelParams,
  CancelResult,
  ResumeParams,
  ResumeResult,
  RuntimeAdapter,
  StartInvocationParams,
  StartInvocationResult,
  SteerParams,
  SteerResult,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import {
  type AuthorityIdentity,
  AuthorityIdentitySchema,
  type Credentials,
  type RuntimeStartRequest,
  computeSemanticRequestDigest,
  protocolDigest,
} from "@/lib/runtime/runtime-protocol";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";

/**
 * 测试专用协议桥：让 Publication Conformance runner 通过真实 HTTP transport
 * 调用黑盒 External Runtime。请求和响应均使用唯一 RuntimeProtocol contract。
 */
export function createHttpRuntimeConformanceAdapterForTest(params: {
  transport: RuntimeTransport;
  endpoint: string;
  auth: RuntimeTransportAuth;
}): RuntimeAdapter {
  return {
    probeCapabilities: () => params.transport.probeCapabilities(params.endpoint, params.auth),
    async startInvocation(input: StartInvocationParams): Promise<StartInvocationResult> {
      const authority = requireAuthority(input.authority);
      const request = buildRequest(input, authority, "start");
      const response = await params.transport.startInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        idempotencyKey: `start:${authority.ownershipId}`,
        request,
      });
      return { response };
    },
    async handleCancel(input: CancelParams): Promise<CancelResult> {
      const authority = requireAuthority(input.authority);
      const commandId = randomUUID();
      const response = await params.transport.cancelInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        invocationId: input.invocationId,
        idempotencyKey: `command:${commandId}`,
        request: {
          protocolVersion: 3,
          commandId,
          targetAuthority: authority,
          reasonCode: input.reason ?? "conformance_cancel",
        },
      });
      return { response };
    },
    async handleResume(input: ResumeParams): Promise<ResumeResult> {
      const authority = requireAuthority(input.authority);
      const base = buildRequest(
        {
          invocationId: input.invocationId,
          authority,
          tenantId: input.tenantId,
          threadId: null,
          turnId: null,
          inputItems: [{ type: "resume", payload: input.resumePayload ?? null }],
          gatewayEndpoints: requiredEndpoints(),
          workspace: { mode: "NONE" },
          traceContext: undefined,
          authToken: input.authToken ?? "conformance-runtime-token",
        },
        authority,
        "resume",
      );
      const recovery = {
        kind: "resume" as const,
        anchor: input.checkpointRef ?? `conformance:${input.invocationId}`,
        anchorDigest: protocolDigest(input.checkpointRef ?? input.invocationId),
      };
      const request: RuntimeStartRequest = {
        ...base,
        recovery,
        semanticRequestDigest: computeSemanticRequestDigest({ ...base, recovery }),
      };
      const response = await params.transport.resumeInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        idempotencyKey: `start:${authority.ownershipId}`,
        request,
      });
      return { response };
    },
    async handleSteer(input: SteerParams): Promise<SteerResult> {
      const authority = requireAuthority(input.authority);
      const commandId = randomUUID();
      const inputRef = `conformance:${input.invocationId}:steer`;
      const response = await params.transport.steerInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        invocationId: input.invocationId,
        idempotencyKey: `command:${commandId}`,
        request: {
          protocolVersion: 3,
          commandId,
          targetAuthority: authority,
          inputRef,
          inputDigest: protocolDigest(input.steerPayload ?? inputRef),
        },
      });
      return { response };
    },
  };
}

function requireAuthority(authority: AuthorityIdentity | undefined): AuthorityIdentity {
  if (!authority) throw new Error("Conformance RuntimeAdapter 缺少 Execution Authority");
  return AuthorityIdentitySchema.parse(authority);
}

function buildRequest(
  input: Pick<
    StartInvocationParams,
    | "invocationId"
    | "authority"
    | "tenantId"
    | "threadId"
    | "turnId"
    | "inputItems"
    | "gatewayEndpoints"
    | "workspace"
    | "executionLimits"
    | "traceContext"
    | "authToken"
  >,
  authority: AuthorityIdentity,
  intentType: "start" | "resume",
): RuntimeStartRequest {
  const tenantId = isUuid(input.tenantId) ? input.tenantId : authority.invocationId;
  const bindingDigest = protocolDigest({ invocationId: input.invocationId, authority });
  const contextSubject =
    isUuid(input.threadId) && isUuid(input.turnId)
      ? {
          type: "thread" as const,
          threadId: input.threadId,
          turnId: input.turnId,
          triggerItemId: authority.attemptId,
          triggerItemDigest: protocolDigest(input.inputItems),
        }
      : {
          type: "job" as const,
          jobId: authority.invocationId,
          inputKind: "inline" as const,
          inputHash: protocolDigest(input.inputItems),
          triggerRef: `conformance:${input.invocationId}`,
        };
  const now = Date.now();
  const context = {
    common: {
      contractVersion: 1 as const,
      tenantId,
      invocationId: authority.invocationId,
      bindingDigest,
      principal: {
        type: "service" as const,
        id: "conformance",
        source: "trusted_service" as const,
      },
      runtimeRevisionId: authority.runtimeRevisionId,
      policy: { revisionId: authority.runtimeRevisionId, digest: bindingDigest },
      workspace: { bindingId: authority.attemptId, contractDigest: bindingDigest },
      environment: { mode: "NO_PLATFORM_ENVIRONMENT" as const },
      contextSourceDigest: protocolDigest(["conformance"]),
      issuedAt: now,
      expiresAt: now + 60_000,
      jti: randomUUID(),
    },
    subject: contextSubject,
  };
  const credentials: Credentials = {
    runtimeToken: input.authToken,
    gatewayToken: input.authToken,
    expiresAt: now + 60_000,
  };
  const base = {
    protocolVersion: 3 as const,
    authority,
    intentType,
    semanticRequestDigest: protocolDigest({ invocationId: input.invocationId, intentType }),
    executionBinding: {
      bindingDigest,
      runtimeRevisionId: authority.runtimeRevisionId,
      policyRefs: [authority.runtimeRevisionId],
      governanceRefs: [authority.runtimeRevisionId],
      capabilityRefs: [authority.runtimeRevisionId],
      modelRefs: [],
      allowedEgress: [],
    },
    context,
    inputs: [{ kind: "inline" as const, digest: protocolDigest(input.inputItems) }],
    environment: { mode: "NO_PLATFORM_ENVIRONMENT" as const },
    workspace: input.workspace ?? { mode: "NONE" as const },
    activationDigest: protocolDigest({ invocationId: input.invocationId, authority }),
    recovery: { kind: "initial" as const },
    producerSequenceStart: "1",
    callbackEndpoints: input.gatewayEndpoints ?? requiredEndpoints(),
    credentials,
    executionLimits: input.executionLimits ?? {
      maxEventBytes: 262_144,
      maxBatchEvents: 100,
      maxBatchBytes: 1_048_576,
      dispatchDeadlineMs: 120_000,
      executionTimeoutMs: 60_000,
    },
    ...(input.traceContext ? { traceContext: input.traceContext } : {}),
  } satisfies RuntimeStartRequest;
  return { ...base, semanticRequestDigest: computeSemanticRequestDigest(base) };
}

function requiredEndpoints() {
  return {
    events: "https://conformance.invalid/runtime/events",
    heartbeat: "https://conformance.invalid/runtime/heartbeat",
    context: "https://conformance.invalid/runtime/context",
    capabilityActions: "https://conformance.invalid/gateway/capability-actions",
    toolCalls: "https://conformance.invalid/gateway/tool-calls",
    userActions: "https://conformance.invalid/gateway/user-actions",
  };
}

function isUuid(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
