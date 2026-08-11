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
import {
  RuntimeWithdrawalNotFoundError,
  RuntimeWithdrawalPublicationNotFoundError,
  RuntimeWithdrawalStateError,
  RuntimeWithdrawalValidationError,
  RuntimeWithdrawalVersionConflictError,
  createWithdrawRuntimeRevision,
} from "@/lib/runtime/application/withdraw-runtime-revision";
import { mysqlRuntimeWithdrawalStore } from "@/lib/runtime/persistence/mysql-runtime-withdrawal-store";
import { getRuntimeById } from "@/lib/runtime/persistence/runtime-queries";
import { getRuntimeRevisionById } from "@/lib/runtime/persistence/runtime-revision-queries";

export const dynamic = "force-dynamic";

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

function validateBody(value: unknown): value is { reason_code: string; reason: string } {
  if (!value || typeof value !== "object") return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.reason_code === "string" &&
    body.reason_code.trim().length > 0 &&
    typeof body.reason === "string" &&
    body.reason.trim().length > 0
  );
}

function serializeResponse(result: {
  revision: { id: string; revisionState: string };
  withdrawalRecordId: string;
  currentRevisionId: string | null;
  auditEventId: string;
}): string {
  return JSON.stringify({
    id: result.revision.id,
    revision_state: result.revision.revisionState,
    withdrawal_record_id: result.withdrawalRecordId,
    current_revision_id: result.currentRevisionId,
    audit_event_id: result.auditEventId,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<Record<string, string | string[]>> },
): Promise<Response> {
  const requestId = getRequestId(request);
  const raw = (await params)["revision_id:withdraw"];
  const revisionId = typeof raw === "string" ? (raw.split(":")[0] ?? "") : "";
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
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "reason_code 和 reason 必须为非空字符串");
  }
  const revision = await getRuntimeRevisionById(revisionId);
  const runtime = revision ? await getRuntimeById(principal.tenantId, revision.runtimeId) : null;
  if (!revision || !runtime) {
    return resourceNotFound(requestId, `RuntimeRevision 不存在或无权访问: ${revisionId}`);
  }
  const scope = await requireAdminActionScope(
    principal,
    "runtime.retract",
    { type: "runtime", id: runtime.id },
    requestId,
  );
  if (!scope.ok) return scope.response;
  const currentEtag = `${RUNTIME_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
  if (ifMatch !== currentEtag) {
    return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }
  const commandScope = `runtime.withdraw:${revisionId}`;
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
    const result = await createWithdrawRuntimeRevision({ store: mysqlRuntimeWithdrawalStore })({
      tenantId: principal.tenantId,
      revisionId,
      runtimeExpectedVersionNo: runtime.versionNo,
      actor: actorFrom(principal),
      reasonCode: body.reason_code,
      reason: body.reason,
      requestId,
      idempotency: {
        recordId,
        httpStatus: 200,
        responseRef: revisionId,
        serializeResponse,
      },
    });
    return apiSuccess(JSON.parse(serializeResponse(result)), {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    await failRecord(recordId);
    if (error instanceof RuntimeWithdrawalNotFoundError) {
      return resourceNotFound(requestId, error.message);
    }
    if (error instanceof RuntimeWithdrawalVersionConflictError) {
      return etagMismatchTable(requestId, error.message);
    }
    if (error instanceof RuntimeWithdrawalValidationError) {
      return schemaInvalidTable(requestId, error.message);
    }
    if (
      error instanceof RuntimeWithdrawalStateError ||
      error instanceof RuntimeWithdrawalPublicationNotFoundError
    ) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, { requestId });
    }
    throw error;
  }
}
