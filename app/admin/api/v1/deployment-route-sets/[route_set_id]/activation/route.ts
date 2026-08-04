import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  parseIfMatch,
  v11Error,
  v11Ok,
} from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
/**
 * PUT /admin/api/v1/deployment-route-sets/{route_set_id}/activation
 * — RouteSet 整体激活（任务 1.6）。
 *
 * 必填：Idempotency-Key header、If-Match header
 * 请求体：{ expected_version_no, reason, routes[] }
 *
 * 错误映射见 JSDoc 上方文档注释。
 */
import {
  RouteSetRequiresAtomicUpdateError,
} from "@/lib/routes/application/activate-route-set";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";
import {
  AgentCapabilityUnsupportedError,
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
} from "@/lib/routes/domain/route-revision";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  parseRouteSetEtag,
  resolveAdminPrincipalAsync,
  v11EtagMismatch,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/v11/identity/idempotency";

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

export const dynamic = "force-dynamic";

// ─── 请求体类型 ────────────────────────────────────────────

interface ActivationRequestBody {
  expected_version_no: number;
  reason: string;
  routes: Array<{
    route_id?: string;
    route_group_id: string;
    agent_revision_id: string;
    runtime_revision_id: string;
    policy_revision_id?: string;
    model_policy_revision_id?: string;
    toolset_revision_id?: string;
    traffic_weight: number;
    priority_no: number;
    effective_from?: string;
    effective_until?: string;
    eligibility_conditions?: Record<string, unknown>;
    activation_state?: "active" | "disabled";
  }>;
}

function validateBody(body: unknown): body is ActivationRequestBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.expected_version_no !== "number" || !Number.isInteger(b.expected_version_no)) return false;
  if (typeof b.reason !== "string") return false;
  if (!Array.isArray(b.routes) || b.routes.length === 0) return false;
  for (const route of b.routes) {
    if (!route || typeof route !== "object") return false;
    const r = route as Record<string, unknown>;
    if (typeof r.agent_revision_id !== "string") return false;
    if (typeof r.runtime_revision_id !== "string") return false;
    if (typeof r.route_group_id !== "string") return false;
    if (typeof r.traffic_weight !== "number" || !Number.isInteger(r.traffic_weight)) return false;
    if (typeof r.priority_no !== "number" || !Number.isInteger(r.priority_no)) return false;
  }
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) return callerFromPrincipal(principal);
  return callerFromWorkloadPrincipal(principal);
}

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) return actorFromPrincipal(principal);
  return actorFromWorkloadPrincipal(principal);
}

// ─── PUT handler ───────────────────────────────────────────

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ route_set_id: string }> },
) {
  const requestId = getRequestId(request);
  const { route_set_id: routeSetId } = await params;

  // 1. 认证
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. If-Match（必填）
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return v11SchemaInvalid(requestId, "缺少必填头 If-Match");
  }
  let etagVersionNo: number;
  try {
    etagVersionNo = parseRouteSetEtag(ifMatch);
  } catch (err) {
    return v11SchemaInvalid(requestId, err instanceof Error ? err.message : "If-Match ETag 格式非法");
  }

  // 3. Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  let body: ActivationRequestBody;
  try {
    const raw = await request.json();
    if (!validateBody(raw)) {
      return v11SchemaInvalid(requestId, "请求体格式非法");
    }
    body = raw;
  } catch {
    return v11SchemaInvalid(requestId, "请求体解析失败");
  }

  // 5. If-Match 与 expected_version_no 一致
  if (body.expected_version_no !== etagVersionNo) {
    return v11SchemaInvalid(
      requestId,
      `If-Match (${etagVersionNo}) 与 expected_version_no (${body.expected_version_no}) 不一致`,
    );
  }

  // 6. 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PUT", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `route_set.activation:${routeSetId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId);
  }
  if (outcome.kind === "in_flight" || outcome.kind === "conflict") {
    return buildIdempotencyErrorResponse({
      record: outcome.kind === "conflict" ? outcome.existingRecord : outcome.record,
      reason: outcome.kind === "conflict" ? "conflict" : "in_flight",
      requestId,
    });
  }

  let recordId = outcome.record.id;
  if (outcome.kind === "retry_allowed") {
    const reset = await prepareRetryForFailedRecord({
      record: outcome.record,
      requestHash,
    });
    if (!reset) {
      return buildIdempotencyErrorResponse({ record: outcome.record, reason: "conflict", requestId });
    }
    recordId = reset.id;
  }

  // 7. 执行业务
  try {
    const result = await activateRouteSet({
      tenantId: principal.tenantId,
      routeSetId,
      expectedVersionNo: body.expected_version_no,
      desiredRoutes: body.routes.map((r) => ({
        routeId: r.route_id,
        routeGroupId: r.route_group_id,
        agentRevisionId: r.agent_revision_id,
        runtimeRevisionId: r.runtime_revision_id,
        policyRevisionId: r.policy_revision_id ?? null,
        modelPolicyRevisionId: r.model_policy_revision_id ?? null,
        toolsetRevisionId: r.toolset_revision_id ?? null,
        trafficWeight: r.traffic_weight,
        priorityNo: r.priority_no,
        effectiveFrom: r.effective_from ? new Date(r.effective_from) : null,
        effectiveUntil: r.effective_until ? new Date(r.effective_until) : null,
        eligibilityConditions: r.eligibility_conditions ?? {},
        activationState: r.activation_state,
      })),
      actor: actorFromAdminPrincipal(principal),
      reason: body.reason,
      requestId,
      idempotencyKey,
      idempotency: {
        recordId,
        httpStatus: 200,
        serializeResponse: (r) =>
          JSON.stringify({
            route_set_id: r.routeSetId,
            route_set_version_no: r.routeSetVersionNo,
          }),
      },
    });

    // 8. 返回 200 + ETag
    const etag = `route-set-${result.routeSetVersionNo}`;
    return v11Ok(
      {
        route_set_id: result.routeSetId,
        route_set_version_no: result.routeSetVersionNo,
        activations: result.activations.map((a) => ({
          route_id: a.routeId,
          route_revision_id: a.routeRevisionId,
          route_activation_id: a.routeActivationId,
          activation_state: a.activationState,
          route_group_id: a.routeGroupId,
        })),
        affected_new_invocations_only: true,
      },
      {
        status: 200,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
          ...etagHeader(etag),
        },
      },
    );
  } catch (err) {
    if (err instanceof RouteSetNotFoundError) {
      await failRecord(recordId);
      return v11Error("RESOURCE_NOT_FOUND", err.message, { requestId });
    }
    if (err instanceof RouteSetVersionConflictError) {
      await failRecord(recordId);
      return v11EtagMismatch(requestId, err.message);
    }
    if (err instanceof ArtifactNotVerifiedForRouteError) {
      await failRecord(recordId);
      return v11Error("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof RevisionNotPublishedError) {
      await failRecord(recordId);
      return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof AgentCapabilityUnsupportedError) {
      await failRecord(recordId);
      return v11Error("AGENT_CAPABILITY_UNSUPPORTED", err.message, { requestId });
    }
    if (err instanceof RouteSetRequiresAtomicUpdateError) {
      await failRecord(recordId);
      return v11Error("ROUTE_SET_REQUIRES_ATOMIC_UPDATE", err.message, { requestId });
    }
    throw err;
  }
}
