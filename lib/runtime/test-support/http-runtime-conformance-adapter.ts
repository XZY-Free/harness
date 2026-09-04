import type {
  CancelParams,
  ResumeParams,
  RuntimeAdapter,
  StartInvocationParams,
  SteerParams,
} from "@/lib/runtime/adapters/hosted-adapter";
import type { RuntimeTransportAuth } from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";

/**
 * 测试专用协议桥：让 Publication Conformance runner 通过真实 HTTP transport
 * 调用黑盒 External Runtime，不引用 Hosted 实现。
 */
export function createHttpRuntimeConformanceAdapterForTest(params: {
  transport: RuntimeTransport;
  endpoint: string;
  auth: RuntimeTransportAuth;
}): RuntimeAdapter {
  return {
    probeCapabilities: () => params.transport.probeCapabilities(params.endpoint, params.auth),
    async startInvocation(input: StartInvocationParams) {
      const response = await params.transport.startInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        idempotencyKey: `conformance-start:${input.invocationId}`,
        requestBody: {
          protocol_version: "2",
          invocation_id: input.invocationId,
          turn_context:
            input.threadId && input.turnId
              ? { thread_id: input.threadId, turn_id: input.turnId }
              : null,
          input_items: input.inputItems,
          context_handle: input.contextHandle ?? `conformance:${input.invocationId}`,
          governance_config: {
            revision_id: "conformance-governance",
            config_digest: "sha256:conformance",
            config: {},
          },
          gateway_access: {
            access_token: input.authToken,
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
          gateway_endpoints: input.gatewayEndpoints,
          workspace: input.workspace ?? null,
          execution_limits: input.executionLimits ?? {
            max_invocation_seconds: 60,
            max_event_bytes: 1_048_576,
          },
          trace_context: input.traceContext ?? {
            trace_id: input.correlationId ?? "conformance-trace",
            span_id: "conformance-span",
          },
        },
      });
      return {
        accepted: response.accepted,
        runtime_session_ref: response.runtime_session_ref,
        runtime_execution_ref: response.runtime_execution_ref,
        capabilities: response.capabilities,
      };
    },
    async handleCancel(input: CancelParams) {
      const response = await params.transport.cancelInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        invocationId: input.invocationId,
        idempotencyKey: `conformance-cancel:${input.invocationId}`,
        requestBody: { reason: input.reason ?? "conformance_cancel" },
      });
      if (!response.cancelled) throw new Error("External Runtime 未确认 cancel");
      return { cancel_state: "accepted", already_completed_effects_preserved: true };
    },
    async handleResume(input: ResumeParams) {
      const response = await params.transport.resumeInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        invocationId: input.invocationId,
        idempotencyKey: `conformance-resume:${input.invocationId}`,
        requestBody: {
          resume_payload: input.resumePayload ?? null,
          gateway_access: {
            access_token: input.authToken ?? "conformance-gateway-token",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      });
      if (!response.resumed) throw new Error("External Runtime 未确认 resume");
      return {
        resume_state: "accepted",
        runtime_execution_ref: `resumed:${input.invocationId}`,
        requires_redispatch: response.requires_redispatch ?? false,
      };
    },
    async handleSteer(input: SteerParams) {
      const response = await params.transport.steerInvocation({
        runtimeEndpoint: params.endpoint,
        auth: params.auth,
        invocationId: input.invocationId,
        idempotencyKey: `conformance-steer:${input.invocationId}`,
        requestBody: { steer_payload: input.steerPayload ?? null },
      });
      if (!response.steered) throw new Error("External Runtime 未确认 steer");
      return {
        steer_state: "accepted",
        applies_at: "next_safe_point",
        generation_interrupted: false,
      };
    },
  };
}
