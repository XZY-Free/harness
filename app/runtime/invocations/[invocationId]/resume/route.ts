import { db } from "@/lib/db/client";
import { requireCurrentExecutionAuthority } from "@/lib/executions/application/require-current-execution-authority";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
} from "@/lib/http";
import {
  type WorkloadTokenClaims,
  assertAudienceMatch,
  decodeWorkloadToken,
  extractBearerToken,
  workloadTokenErrorResponse,
} from "@/lib/identity/workload-token";
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
type RouteContext = { params: Promise<{ invocationId: string }> };

/** Resume is a new ownership-generation delivery of the persisted resume intent. */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { invocationId } = await context.params;
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
  if (claims.invocationId !== invocationId)
    return apiError("ACCESS_DENIED", "Runtime Resume Invocation 不一致", { requestId });
  if (request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim() !== `start:${claims.ownershipId}`)
    return apiError("REQUEST_SCHEMA_INVALID", "Idempotency-Key 必须为 start:{ownershipId}", {
      requestId,
    });
  const parsed = RuntimeStartRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError("REQUEST_SCHEMA_INVALID", "RuntimeStartRequest 非法", { requestId });
  const resume = parsed.data;
  if (
    resume.intentType !== "resume" ||
    resume.authority.invocationId !== claims.invocationId ||
    resume.authority.runtimeRevisionId !== claims.runtimeRevisionId ||
    resume.authority.attemptId !== claims.attemptId ||
    resume.authority.ownershipId !== claims.ownershipId ||
    resume.authority.leaseEpoch !== claims.leaseEpoch ||
    resume.authority.sessionBindingId !== claims.sessionBindingId
  )
    return apiError("ACCESS_DENIED", "Runtime Resume Authority 不一致", { requestId });
  if (computeSemanticRequestDigest(resume) !== resume.semanticRequestDigest)
    return apiError("REQUEST_SCHEMA_INVALID", "semanticRequestDigest 不匹配", { requestId });
  const acceptedAt = Date.now();
  let session: RuntimeSessionBinding;
  try {
    session = await db.transaction(async (tx) => {
      await requireCurrentExecutionAuthority({
        tenantId: claims.tenantId,
        authority: claims,
        executor: tx,
        requiredPhase: "dispatching",
        // Resume 是新执行的起点：Checkpoint Gate 未解除时不得接纳。
        operationKind: "new_action",
      });
      const current = await getRuntimeSessionBindingByStartIntent(
        claims.tenantId,
        `start:${claims.ownershipId}`,
        tx,
      );
      if (!current || current.invocationId !== invocationId || current.intentType !== "resume") {
        throw new Error("RuntimeSessionMismatch");
      }
      if (
        current.semanticRequestDigest &&
        current.semanticRequestDigest !== resume.semanticRequestDigest
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
          semanticRequestJson: buildStartSemanticDigestInput(resume),
          semanticRequestDigest: resume.semanticRequestDigest,
          remoteSessionRef,
          remoteExecutionRef,
          transportAcknowledgement: { protocolVersion: 3, acceptedAt },
          acknowledgedAt: new Date(acceptedAt),
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
    authority: resume.authority,
    semanticRequestDigest: resume.semanticRequestDigest,
    accepted: true,
    remoteSessionRef,
    remoteExecutionRef,
    capabilitiesDigest: `sha256:${"0".repeat(64)}`,
    acceptedAt,
  };
  return apiSuccess(response, { status: 202, headers: { [REQUEST_ID_HEADER]: requestId } });
}
