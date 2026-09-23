import { db } from "@/lib/db/client";
import { renewExecutionOwnership } from "@/lib/executions/persistence/execution-ownership-store";
import { getInvocationById } from "@/lib/executions/persistence/invocation-store";
import { WORKLOAD_TOKEN_DEFAULT_TTL_MS, issueWorkloadToken } from "@/lib/identity/workload-token";
import { getRuntimeSessionBindingById } from "@/lib/runtime/persistence/runtime-session-store";
import {
  type Credentials,
  type HeartbeatRequest,
  HeartbeatRequestSchema,
  type HeartbeatResponse,
} from "@/lib/runtime/runtime-protocol";

export async function handleRuntimeHeartbeat(input: {
  tenantId: string;
  invocationId: string;
  request: unknown;
}): Promise<HeartbeatResponse> {
  const request = HeartbeatRequestSchema.parse(input.request);
  if (request.authority.invocationId !== input.invocationId)
    throw new Error("Heartbeat Invocation 不匹配");
  const invocation = await getInvocationById(input.tenantId, input.invocationId);
  if (!invocation) throw new Error("Invocation 不存在或不可见");
  const session = await getRuntimeSessionBindingById(
    input.tenantId,
    request.authority.sessionBindingId,
  );
  if (
    !session ||
    session.invocationId !== input.invocationId ||
    session.attemptId !== request.authority.attemptId ||
    session.ownershipId !== request.authority.ownershipId ||
    session.runtimeRevisionId !== request.authority.runtimeRevisionId ||
    session.leaseEpoch !== BigInt(request.authority.leaseEpoch)
  ) {
    throw new Error("RuntimeSessionBinding 不匹配");
  }
  const owner = await renewExecutionOwnership({
    tenantId: input.tenantId,
    invocationId: input.invocationId,
    ownershipId: request.authority.ownershipId,
    attemptId: request.authority.attemptId,
    leaseEpoch: BigInt(request.authority.leaseEpoch),
  });
  const response: HeartbeatResponse = {
    protocolVersion: 3,
    authority: request.authority,
    serverTime: Date.now(),
    leaseExpiresAt: owner.leaseExpiresAt.getTime(),
    acceptedThroughProducerSequence: String(invocation.lastProducerSequence),
    continueExecution: true,
  };
  if (request.requestCredentialRefresh)
    response.renewedCredentials = issueCredentials(input.tenantId, request);
  return response;
}

function issueCredentials(tenantId: string, request: HeartbeatRequest): Credentials {
  const base = {
    contractVersion: 3 as const,
    type: "execution" as const,
    tenantId,
    invocationId: request.authority.invocationId,
    runtimeRevisionId: request.authority.runtimeRevisionId,
    attemptId: request.authority.attemptId,
    ownershipId: request.authority.ownershipId,
    leaseEpoch: request.authority.leaseEpoch,
    sessionBindingId: request.authority.sessionBindingId,
  };
  const issuedAt = Date.now();
  const expiresAt = issuedAt + WORKLOAD_TOKEN_DEFAULT_TTL_MS.runtime;
  return {
    runtimeToken: issueWorkloadToken({ ...base, audience: "runtime", expiresAt }),
    gatewayToken: issueWorkloadToken({ ...base, audience: "gateway", expiresAt }),
    expiresAt,
  };
}
