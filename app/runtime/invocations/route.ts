import { db } from "@/lib/db/client";
import { requireCurrentExecutionAuthority } from "@/lib/executions/application/require-current-execution-authority";
import { getExecutionBindingByInvocation } from "@/lib/executions/persistence/execution-binding-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
import type { WorkloadTokenClaims } from "@/lib/identity/workload-token";
import type { RuntimeSessionBinding } from "@/lib/persistence/schema/executions";
import {
  getRuntimeSessionBindingByStartIntent,
  updateRuntimeSessionDispatch,
} from "@/lib/runtime/persistence/runtime-session-store";
import {
  RuntimeStartRequestSchema,
  type RuntimeStartResponse,
  buildStartSemanticDigestInput,
  computeSemanticRequestDigest,
} from "@/lib/runtime/runtime-protocol";

export const dynamic = "force-dynamic";

/** Runtime Start is a durable handoff: 202 records transport acknowledgement only. */
export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);
  const token = extractBearerToken(request.headers);
  if (!token)
    return apiError("AUTHENTICATION_REQUIRED", "缺少 Authorization Bearer Token", { requestId });
  let claims: WorkloadTokenClaims;
  try {
    claims = decodeWorkloadToken(token);
    assertAudienceMatch(claims, "runtime");
  } catch (error) {
    const response = workloadTokenErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (idempotencyKey !== `start:${claims.ownershipId}`)
    return apiError("REQUEST_SCHEMA_INVALID", "Idempotency-Key 必须为 start:{ownershipId}", {
      requestId,
    });
  const parsed = RuntimeStartRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError("REQUEST_SCHEMA_INVALID", "RuntimeStartRequest 非法", { requestId });
  const start = parsed.data;
  if (
    start.authority.invocationId !== claims.invocationId ||
    start.authority.runtimeRevisionId !== claims.runtimeRevisionId ||
    start.authority.attemptId !== claims.attemptId ||
    start.authority.ownershipId !== claims.ownershipId ||
    start.authority.leaseEpoch !== claims.leaseEpoch ||
    start.authority.sessionBindingId !== claims.sessionBindingId
  )
    return apiError("ACCESS_DENIED", "Runtime Start Authority 与凭据不一致", { requestId });
  if (start.intentType !== "start")
    return apiError("REQUEST_SCHEMA_INVALID", "Start endpoint 只接受 intentType=start", {
      requestId,
    });
  const binding = await getExecutionBindingByInvocation(claims.tenantId, claims.invocationId);
  if (!binding || binding.runtimeRevisionId !== claims.runtimeRevisionId)
    return apiError("RESOURCE_NOT_FOUND", "ExecutionBinding 不存在或不可见", { requestId });
  const semanticDigest = computeSemanticRequestDigest(start);
  if (semanticDigest !== start.semanticRequestDigest)
    return apiError("REQUEST_SCHEMA_INVALID", "semanticRequestDigest 不匹配", { requestId });
  const now = Date.now();
  let session: RuntimeSessionBinding;
  try {
    session = await db.transaction(async (tx) => {
      await requireCurrentExecutionAuthority({
        tenantId: claims.tenantId,
        authority: claims,
        executor: tx,
        requiredPhase: "dispatching",
      });
      const current = await getRuntimeSessionBindingByStartIntent(
        claims.tenantId,
        idempotencyKey.slice("start:".length),
        tx,
      );
      if (
        !current ||
        current.invocationId !== claims.invocationId ||
        current.ownershipId !== claims.ownershipId ||
        current.leaseEpoch !== Number(claims.leaseEpoch)
      ) {
        throw new Error("RuntimeSessionMismatch");
      }
      if (
        current.semanticRequestDigest &&
        current.semanticRequestDigest !== start.semanticRequestDigest
      ) {
        throw new Error("StartIntentConflict");
      }
      if (current.bindingState === "active") return current;
      const remoteSessionRef = current.remoteSessionRef ?? `runtime-session:${current.id}`;
      const remoteExecutionRef = current.remoteExecutionRef ?? `runtime-execution:${current.id}`;
      return updateRuntimeSessionDispatch(
        claims.tenantId,
        current.id,
        {
          bindingState: "dispatching",
          semanticRequestDigest: start.semanticRequestDigest,
          semanticRequestJson: buildStartSemanticDigestInput(start),
          remoteSessionRef,
          remoteExecutionRef,
          transportAcknowledgement: { protocolVersion: 3, acceptedAt: now, idempotencyKey },
          acknowledgedAt: new Date(now),
        },
        tx,
      );
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "NotCurrentExecutor";
    return apiError(
      code === "StartIntentConflict" ? "IDEMPOTENCY_CONFLICT" : "ACCESS_DENIED",
      code,
      { requestId },
    );
  }
  const remoteSessionRef = session.remoteSessionRef ?? `runtime-session:${session.id}`;
  const remoteExecutionRef = session.remoteExecutionRef ?? `runtime-execution:${session.id}`;
  const response: RuntimeStartResponse = {
    protocolVersion: 3,
    authority: start.authority,
    semanticRequestDigest: start.semanticRequestDigest,
    accepted: true,
    remoteSessionRef,
    remoteExecutionRef,
    capabilitiesDigest: `sha256:${"0".repeat(64)}`,
    acceptedAt: now,
  };
  return apiSuccess(response, { status: 202, headers: { [REQUEST_ID_HEADER]: requestId } });
}
