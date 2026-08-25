import {
  type AdminPrincipal,
  RUNTIME_REVISION_ETAG_PREFIX,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseRuntimeRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  parseIfMatch,
  resourceNotFound,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import { RuntimeConformanceCaseFailedError } from "@/lib/runtime/domain/runtime-conformance";
import {
  RuntimeArtifactAttestationInvalidError,
  RuntimeArtifactAttestationRequiredError,
  RuntimeConformanceRunInvalidError,
  RuntimePublicationVersionConflictError,
  RuntimeRevisionNotFoundError,
  RuntimeRevisionStateError,
} from "@/lib/runtime/domain/runtime-revision-publication-policy";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";
import { publishRuntimeRevisionThroughControlPlane } from "@/lib/runtime/provisioning/publish-runtime-revision-service";

export const dynamic = "force-dynamic";

interface Body {
  expected_version_no: number;
  /** hosted_artifact 必填；external_endpoint 不得携带（03 §3/§4）。 */
  attestation_id: string | null;
  conformance_run_id: string;
}

function validateBody(value: unknown): value is Body {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.expected_version_no === "number" &&
    Number.isInteger(body.expected_version_no) &&
    (body.attestation_id === null ||
      (typeof body.attestation_id === "string" && body.attestation_id.length > 0)) &&
    typeof body.conformance_run_id === "string" &&
    body.conformance_run_id.length > 0
  );
}

function actorFrom(principal: AdminPrincipal): AuditActor {
  return "userIdentityId" in principal
    ? actorFromPrincipal(principal)
    : actorFromWorkloadPrincipal(principal);
}

function callerFrom(principal: AdminPrincipal) {
  return "userIdentityId" in principal
    ? callerFromPrincipal(principal)
    : callerFromWorkloadPrincipal(principal);
}

function serializeResponse(
  result: {
    revision: { id: string; revisionState: string; publishedAt: Date | null };
    publicationRecordId: string;
    auditEventId: string;
  },
  conformanceRunId: string,
): string {
  if (!result.revision.publishedAt) {
    throw new Error(`RuntimeRevision ${result.revision.id} 发布后缺少 publishedAt`);
  }
  return JSON.stringify({
    id: result.revision.id,
    revision_state: result.revision.revisionState,
    published_at: result.revision.publishedAt.toISOString(),
    publication_record_id: result.publicationRecordId,
    conformance_run_id: conformanceRunId,
    audit_event_id: result.auditEventId,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<Record<string, string | string[]>> },
): Promise<Response> {
  const requestId = getRequestId(request);
  const { revision_id } = await params;
  const revisionId = typeof revision_id === "string" ? revision_id : "";
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (error) {
    const response = adminAuthErrorResponse(error, requestId);
    if (response) return response;
    throw error;
  }
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  try {
    parseRuntimeRevisionEtag(ifMatch);
  } catch (error) {
    return schemaInvalidTable(requestId, error instanceof Error ? error.message : "If-Match 非法");
  }
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) return schemaInvalidTable(requestId, "发布请求体字段非法");
  const revision = await getRuntimeRevisionById(revisionId);
  const runtime = revision ? await getRuntimeById(principal.tenantId, revision.runtimeId) : null;
  if (!revision || !runtime) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }
  const scope = await requireAdminActionScope(
    principal,
    "runtime.publish",
    { type: "runtime", id: runtime.id },
    requestId,
  );
  if (!scope.ok) return scope.response;
  const currentEtag = `${RUNTIME_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
  if (ifMatch !== currentEtag) {
    return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }
  if (runtime.versionNo !== body.expected_version_no) {
    return etagMismatchTable(
      requestId,
      `Runtime 版本 ${runtime.versionNo} 与 expected_version_no ${body.expected_version_no} 不匹配`,
    );
  }
  const commandScope = `runtime.publish:${revisionId}`;
  const requestHash = computeRequestHash("POST", new URL(request.url).pathname, body);
  const outcome = await enforceIdempotency({
    caller: callerFrom(principal),
    commandScope,
    idempotencyKey,
    requestHash,
  });
  if (outcome.kind === "replay") return buildReplayResponse(outcome.record, requestId);
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }
  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({ record: outcome.record, requestHash });
    if (!reset) {
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }
  try {
    const result = await publishRuntimeRevisionThroughControlPlane({
      tenantId: principal.tenantId,
      revisionId,
      runtimeExpectedVersionNo: body.expected_version_no,
      conformanceRunId: body.conformance_run_id,
      attestationId: body.attestation_id,
      actor: actorFrom(principal),
      requestId,
      idempotencyKey,
      idempotency: {
        recordId,
        httpStatus: 200,
        responseRef: revisionId,
        serializeResponse: (published) => serializeResponse(published, body.conformance_run_id),
      },
    });
    return apiSuccess(JSON.parse(serializeResponse(result, body.conformance_run_id)), {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    await failRecord(recordId);
    if (error instanceof RuntimeRevisionNotFoundError)
      return resourceNotFound(requestId, error.message);
    if (error instanceof RuntimePublicationVersionConflictError) {
      return etagMismatchTable(requestId, error.message);
    }
    if (error instanceof RuntimeArtifactAttestationRequiredError) {
      return schemaInvalidTable(requestId, error.message);
    }
    if (error instanceof RuntimeArtifactAttestationInvalidError) {
      if (error.reason.includes("已撤销")) {
        return apiError("ARTIFACT_ATTESTATION_REVOKED", error.message, { requestId });
      }
      if (!error.reason.includes("绑定") && !error.reason.includes("Digest")) {
        return apiError("ARTIFACT_NOT_VERIFIED", error.message, { requestId });
      }
      return apiError("ARTIFACT_BINDING_MISMATCH", error.message, { requestId });
    }
    if (
      error instanceof RuntimeConformanceRunInvalidError ||
      error instanceof RuntimeConformanceCaseFailedError ||
      error instanceof RuntimeRevisionStateError
    ) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, { requestId });
    }
    throw error;
  }
}
