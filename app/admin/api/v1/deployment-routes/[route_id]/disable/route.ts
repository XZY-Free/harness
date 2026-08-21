import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseRouteSetEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
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
import { getRouteById, getRouteSetById } from "@/lib/routes/application/deployment-route-service";
import {
  RouteDisableAuthorityError,
  createDisableRoute,
} from "@/lib/routes/application/disable-route";
import {
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
} from "@/lib/routes/domain/route-revision";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

function routeIdFrom(params: Record<string, string | string[]>): string {
  const raw = params.route_id;
  return typeof raw === "string" ? raw : "";
}

function validateBody(body: unknown): body is { reason: string } {
  return (
    Boolean(body) &&
    typeof body === "object" &&
    typeof (body as { reason?: unknown }).reason === "string" &&
    Boolean((body as { reason: string }).reason.trim())
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

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const routeId = routeIdFrom(await context.params);
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
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseRouteSetEtag(ifMatch);
  } catch (error) {
    return schemaInvalidTable(
      requestId,
      error instanceof Error ? error.message : "If-Match ETag 格式非法",
    );
  }
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) return schemaInvalidTable(requestId, "请求体 reason 必须为非空字符串");

  const route = await getRouteById(principal.tenantId, routeId);
  if (!route) return resourceNotFound(requestId, `DeploymentRoute 不存在或无权访问: ${routeId}`);
  const routeSet = await getRouteSetById(principal.tenantId, route.routeSetId);
  if (!routeSet)
    return resourceNotFound(requestId, `RouteSet 不存在或无权访问: ${route.routeSetId}`);
  const scope = await requireAdminActionScope(
    principal,
    "route.update",
    { type: "agent", id: routeSet.agentId },
    requestId,
  );
  if (!scope.ok) return scope.response;

  const commandScope = `route.disable:${routeId}`;
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
  if (routeSet.versionNo !== expectedVersionNo) {
    await failRecord(recordId);
    return etagMismatchTable(
      requestId,
      `If-Match route-set-${expectedVersionNo} 与当前 route-set-${routeSet.versionNo} 不匹配`,
    );
  }

  try {
    const result = await createDisableRoute({ store: mysqlRouteSetActivationStore })({
      tenantId: principal.tenantId,
      routeSetId: route.routeSetId,
      routeId,
      expectedVersionNo,
      actor: actorFromAdminPrincipal(principal),
      reason: body.reason.trim(),
      requestId,
      idempotencyKey,
      idempotencyCompletion: {
        recordId,
        httpStatus: 200,
        responseRef: routeId,
        serializeResponse: serializeDisableRouteResponse,
      },
    });
    return apiSuccess(JSON.parse(serializeDisableRouteResponse(result)), {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`route-set-${result.routeSetVersionNo}`),
      },
    });
  } catch (error) {
    await failRecord(recordId);
    if (error instanceof RouteNotFoundError || error instanceof RouteSetNotFoundError) {
      return resourceNotFound(requestId, error.message);
    }
    if (error instanceof RouteSetVersionConflictError) {
      return etagMismatchTable(requestId, error.message);
    }
    if (error instanceof RouteDisableAuthorityError) throw error;
    throw error;
  }
}

function serializeDisableRouteResponse(result: {
  route: { id: string };
  routeSetId: string;
  routeSetVersionNo: number;
  routeRevisionId: string;
  routeActivationId: string;
  previousRouteActivationId: string;
  affectsNewInvocationsOnly: true;
}): string {
  return JSON.stringify({
    route_id: result.route.id,
    route_set_id: result.routeSetId,
    route_set_version_no: result.routeSetVersionNo,
    route_revision_id: result.routeRevisionId,
    route_activation_id: result.routeActivationId,
    previous_route_activation_id: result.previousRouteActivationId,
    activation_state: "disabled",
    affects_new_invocations_only: result.affectsNewInvocationsOnly,
  });
}
