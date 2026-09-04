import {
  type RuntimeTransportAuth,
  outboundAuthHeaders,
} from "@/lib/runtime/credentials/resolve-outbound-runtime-auth";
import { RuntimeHttpClientError } from "@/lib/runtime/errors";
import { createHttpRuntimeClient } from "@/lib/runtime/runtime-client";
import type { RuntimeTransport } from "@/lib/runtime/transport/runtime-transport";

export interface CreateHttpHarnessRuntimeTransportParams {
  endpoint: string;
  auth: RuntimeTransportAuth;
  timeoutMs?: number;
}

/** External Harness Runtime 的正式黑盒 HTTP transport。 */
export function createHttpHarnessRuntimeTransport(
  params: CreateHttpHarnessRuntimeTransportParams,
): RuntimeTransport {
  const endpoint = normalizeExternalRuntimeEndpoint(params.endpoint);
  // External 只允许外部凭据；在创建 transport 时先验证，保证网络前 fail closed。
  outboundAuthHeaders(params.auth);
  const client = createHttpRuntimeClient({ timeoutMs: params.timeoutMs });
  return {
    probeCapabilities: () => client.probeCapabilities(endpoint, params.auth),
    startInvocation: (request) =>
      client.startInvocation({ ...request, runtimeEndpoint: endpoint, auth: params.auth }),
    cancelInvocation: (request) =>
      client.cancelInvocation({ ...request, runtimeEndpoint: endpoint, auth: params.auth }),
    resumeInvocation: (request) =>
      client.resumeInvocation({ ...request, runtimeEndpoint: endpoint, auth: params.auth }),
    steerInvocation: (request) =>
      client.steerInvocation({ ...request, runtimeEndpoint: endpoint, auth: params.auth }),
  };
}

function normalizeExternalRuntimeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw invalidEndpoint();
  }
  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "[::1]";
  if (
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw invalidEndpoint();
  }
  return endpoint.href.replace(/\/$/, "");
}

function invalidEndpoint(): RuntimeHttpClientError {
  return new RuntimeHttpClientError(
    "protocol",
    "External Runtime endpoint 缺失或非法",
    undefined,
    undefined,
    { stableCode: "RUNTIME_PROTOCOL_SCHEMA_MISMATCH", retryable: false },
  );
}
