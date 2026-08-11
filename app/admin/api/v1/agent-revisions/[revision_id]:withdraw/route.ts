import {
  AGENT_REVISION_ETAG_PREFIX,
  type AdminPrincipal,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseAgentRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { createWithdrawAgentRevision } from "@/lib/agents/application/withdraw-agent-revision";
import {
  AgentRevisionWithdrawalNotFoundError,
  AgentRevisionWithdrawalPublicationNotFoundError,
  AgentRevisionWithdrawalStateError,
  AgentRevisionWithdrawalValidationError,
  AgentWithdrawalVersionConflictError,
} from "@/lib/agents/domain/agent-revision-withdrawal-policy";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import { getRevisionById } from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentWithdrawalStore } from "@/lib/agents/persistence/mysql-agent-withdrawal-store";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
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

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

interface WithdrawBody {
  reason_code: string;
  reason: string;
}

function validateBody(body: unknown): body is WithdrawBody {
  if (!body || typeof body !== "object") return false;
  const candidate = body as Record<string, unknown>;
  return (
    typeof candidate.reason_code === "string" &&
    Boolean(candidate.reason_code.trim()) &&
    typeof candidate.reason === "string" &&
    Boolean(candidate.reason.trim())
  );
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  return "userIdentityId" in principal
    ? callerFromPrincipal(principal)
    : callerFromWorkloadPrincipal(principal);
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  return "userIdentityId" in principal
    ? actorFromPrincipal(principal)
    : actorFromWorkloadPrincipal(principal);
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

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const raw = (await context.params)["revision_id:withdraw"];
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
    parseAgentRevisionEtag(ifMatch);
  } catch (error) {
    return schemaInvalidTable(
      requestId,
      error instanceof Error ? error.message : "If-Match ETag 格式非法",
    );
  }
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "reason_code 和 reason 必须为非空字符串");
  }

  const revision = await getRevisionById(revisionId);
  if (!revision) {
    return resourceNotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }
  const agent = await getAgentById(principal.tenantId, revision.agentId);
  if (!agent) {
    return resourceNotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }
  const scope = await requireAdminActionScope(
    principal,
    "agent.retract",
    { type: "agent", id: agent.id },
    requestId,
  );
  if (!scope.ok) return scope.response;
  const currentEtag = `${AGENT_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
  if (ifMatch !== currentEtag) {
    return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }

  const commandScope = `agent.withdraw:${revisionId}`;
  const requestHash = computeRequestHash("POST", new URL(request.url).pathname, body);
  const outcome = await enforceIdempotency({
    caller: callerFromAdminPrincipal(principal),
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
    const result = await createWithdrawAgentRevision({ store: mysqlAgentWithdrawalStore })({
      tenantId: principal.tenantId,
      revisionId,
      agentExpectedVersionNo: agent.versionNo,
      actor: actorFromAdminPrincipal(principal),
      reasonCode: body.reason_code.trim(),
      reason: body.reason.trim(),
      requestId,
      idempotency: {
        recordId,
        httpStatus: 200,
        responseRef: revisionId,
        serializeResponse,
      },
    });
    return apiSuccess(JSON.parse(serializeResponse(result)), {
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(currentEtag),
      },
    });
  } catch (error) {
    await failRecord(recordId);
    if (error instanceof AgentRevisionWithdrawalNotFoundError) {
      return resourceNotFound(requestId, error.message);
    }
    if (error instanceof AgentWithdrawalVersionConflictError) {
      return etagMismatchTable(requestId, error.message);
    }
    if (error instanceof AgentRevisionWithdrawalValidationError) {
      return schemaInvalidTable(requestId, error.message);
    }
    if (
      error instanceof AgentRevisionWithdrawalStateError ||
      error instanceof AgentRevisionWithdrawalPublicationNotFoundError
    ) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", error.message, { requestId });
    }
    throw error;
  }
}
