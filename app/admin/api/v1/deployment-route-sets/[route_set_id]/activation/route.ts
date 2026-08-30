import { randomUUID } from "node:crypto";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseRouteSetEtag,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  etagHeader,
  getRequestId,
  parseIfMatch,
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
  type ActivateRouteSetResult,
  RouteSetRequiresAtomicUpdateError,
} from "@/lib/routes/application/activate-route-set";
import { createActivateRouteSet } from "@/lib/routes/application/activate-route-set";
import type { RouteRevisionTarget } from "@/lib/routes/domain/route-revision";
import {
  ArtifactNotVerifiedForRouteError,
  RevisionNotPublishedError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
} from "@/lib/routes/domain/route-revision";
import { mysqlRouteSetActivationStore } from "@/lib/routes/persistence/mysql-route-set-activation-store";

const activateRouteSet = createActivateRouteSet({ store: mysqlRouteSetActivationStore });

export const dynamic = "force-dynamic";

// ─── 请求体类型 ────────────────────────────────────────────

/** wire 判别 target（snake_case），严格 exact keys。 */
type WireRouteTarget =
  | { kind: "runtime"; runtime_revision_id: string }
  | {
      kind: "agent";
      agent_revision_id: string;
      endpoint_ref: string;
      identity_mode: "none" | "bearer";
      credential_ref_id: string | null;
      network_zone: string;
    };

interface ActivationRequestBody {
  expected_version_no: number;
  reason: string;
  routes: Array<{
    route_id?: string;
    route_group_id: string;
    target: WireRouteTarget;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ROUTE_KEYS = [
  "activation_state",
  "effective_from",
  "effective_until",
  "eligibility_conditions",
  "model_policy_revision_id",
  "policy_revision_id",
  "priority_no",
  "route_group_id",
  "route_id",
  "target",
  "toolset_revision_id",
  "traffic_weight",
].sort();
const BODY_KEYS = ["expected_version_no", "reason", "routes"].sort();

/**
 * 严格解析判别 target（exact keys，fail-closed）。
 * - runtime：仅 {kind, runtime_revision_id}。
 * - agent：仅 {kind, agent_revision_id, endpoint_ref, identity_mode, credential_ref_id, network_zone}；
 *   bearer 必须非空 credential_ref_id；none 允许 null 或合法非空（跟随 domain）。
 * omitted/null/extra/cross-group/旧 flat 一律 null。
 */
function parseWireTarget(raw: unknown): WireRouteTarget | null {
  if (!isPlainObject(raw)) return null;
  if (raw.kind === "runtime") {
    const keys = Object.keys(raw).sort();
    if (keys.length !== 2 || keys.join(",") !== "kind,runtime_revision_id") return null;
    if (!isNonBlankString(raw.runtime_revision_id)) return null;
    return { kind: "runtime", runtime_revision_id: raw.runtime_revision_id.trim() };
  }
  if (raw.kind === "agent") {
    const keys = Object.keys(raw).sort();
    const expected = [
      "agent_revision_id",
      "credential_ref_id",
      "endpoint_ref",
      "identity_mode",
      "kind",
      "network_zone",
    ];
    if (keys.length !== 6 || keys.join(",") !== expected.join(",")) return null;
    if (!isNonBlankString(raw.agent_revision_id)) return null;
    if (!isNonBlankString(raw.endpoint_ref)) return null;
    if (raw.identity_mode !== "none" && raw.identity_mode !== "bearer") return null;
    if (!isNonBlankString(raw.network_zone)) return null;
    if (raw.identity_mode === "bearer") {
      if (!isNonBlankString(raw.credential_ref_id)) return null;
    } else if (raw.credential_ref_id !== null && !isNonBlankString(raw.credential_ref_id)) {
      return null;
    }
    return {
      kind: "agent",
      agent_revision_id: raw.agent_revision_id.trim(),
      endpoint_ref: raw.endpoint_ref.trim(),
      identity_mode: raw.identity_mode,
      credential_ref_id:
        typeof raw.credential_ref_id === "string" ? raw.credential_ref_id.trim() : null,
      network_zone: raw.network_zone.trim(),
    };
  }
  return null;
}

/** 把 wire 判别 target 映射为唯一 camelCase RouteRevisionTarget。 */
function wireTargetToCamel(wire: WireRouteTarget): RouteRevisionTarget {
  if (wire.kind === "runtime") {
    return { kind: "runtime", runtimeRevisionId: wire.runtime_revision_id };
  }
  return {
    kind: "agent",
    agentRevisionId: wire.agent_revision_id,
    agentEndpointRef: wire.endpoint_ref,
    agentIdentityMode: wire.identity_mode,
    agentCredentialRefId: wire.credential_ref_id,
    agentNetworkZone: wire.network_zone,
  };
}

function validateBody(body: unknown): body is ActivationRequestBody {
  if (!isPlainObject(body)) return false;
  const b = body;
  const bodyKeys = Object.keys(b).sort();
  if (bodyKeys.length !== BODY_KEYS.length || bodyKeys.join(",") !== BODY_KEYS.join(",")) {
    return false;
  }
  if (
    typeof b.expected_version_no !== "number" ||
    !Number.isInteger(b.expected_version_no) ||
    b.expected_version_no < 1
  )
    return false;
  if (!isNonBlankString(b.reason)) return false;
  if (!Array.isArray(b.routes) || b.routes.length === 0) return false;
  for (const route of b.routes) {
    if (!isPlainObject(route)) return false;
    const r = route as Record<string, unknown>;
    // 每 route 严格 exact known keys，extra key fail-closed。
    const routeKeys = Object.keys(r).sort();
    if (routeKeys.length !== routeKeys.filter((k) => ROUTE_KEYS.includes(k)).length) return false;
    if ("route_id" in r && !isNonBlankString(r.route_id)) return false;
    if (typeof r.route_group_id !== "string" || r.route_group_id.trim().length === 0) return false;
    for (const key of [
      "policy_revision_id",
      "model_policy_revision_id",
      "toolset_revision_id",
    ] as const) {
      if (key in r && !isNonBlankString(r[key])) return false;
    }
    for (const key of ["effective_from", "effective_until"] as const) {
      if (key in r && (!isNonBlankString(r[key]) || !Number.isFinite(Date.parse(r[key])))) {
        return false;
      }
    }
    if (
      typeof r.traffic_weight !== "number" ||
      !Number.isInteger(r.traffic_weight) ||
      r.traffic_weight < 0 ||
      r.traffic_weight > 10_000
    )
      return false;
    if (typeof r.priority_no !== "number" || !Number.isInteger(r.priority_no)) return false;
    if ("eligibility_conditions" in r && !isPlainObject(r.eligibility_conditions)) return false;
    if (
      "activation_state" in r &&
      r.activation_state !== "active" &&
      r.activation_state !== "disabled"
    ) {
      return false;
    }
    if (parseWireTarget(r.target) === null) return false;
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

function buildActivationResponse(result: ActivateRouteSetResult) {
  return {
    route_set_id: result.routeSetId,
    route_set_version_no: result.routeSetVersionNo,
    activations: result.activations.map((activation) => ({
      route_id: activation.routeId,
      route_revision_id: activation.routeRevisionId,
      route_activation_id: activation.routeActivationId,
      activation_state: activation.activationState,
      route_group_id: activation.routeGroupId,
      previous_route_revision_id: activation.previousRouteRevisionId,
      previous_route_activation_id: activation.previousRouteActivationId,
    })),
    affected_new_invocations_only: result.affectsNewInvocationsOnly,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isActivationResponseBody(
  body: Record<string, unknown>,
  routeSetId: string,
  expectedVersionNo: number,
): boolean {
  if (body.route_set_id !== routeSetId) return false;
  if (
    !Number.isInteger(body.route_set_version_no) ||
    body.route_set_version_no !== expectedVersionNo + 1
  ) {
    return false;
  }
  if (body.affected_new_invocations_only !== true) return false;
  if (!Array.isArray(body.activations) || body.activations.length === 0) return false;

  return body.activations.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const activation = candidate as Record<string, unknown>;
    return (
      isNonEmptyString(activation.route_id) &&
      isNonEmptyString(activation.route_revision_id) &&
      isNonEmptyString(activation.route_activation_id) &&
      (activation.activation_state === "active" || activation.activation_state === "disabled") &&
      isNonEmptyString(activation.route_group_id) &&
      isNullableNonEmptyString(activation.previous_route_revision_id) &&
      isNullableNonEmptyString(activation.previous_route_activation_id)
    );
  });
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
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  let etagVersionNo: number;
  try {
    etagVersionNo = parseRouteSetEtag(ifMatch);
  } catch (err) {
    return schemaInvalidTable(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 3. Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  let body: ActivationRequestBody;
  try {
    const raw = await request.json();
    if (!validateBody(raw)) {
      return schemaInvalidTable(requestId, "请求体格式非法");
    }
    body = raw;
  } catch {
    return schemaInvalidTable(requestId, "请求体解析失败");
  }

  // 5. If-Match 与 expected_version_no 一致
  if (body.expected_version_no !== etagVersionNo) {
    return schemaInvalidTable(
      requestId,
      `If-Match (${etagVersionNo}) 与 expected_version_no (${body.expected_version_no}) 不一致`,
    );
  }

  // 6. 幂等守卫
  const caller = callerFromAdminPrincipal(principal);
  const actor = actorFromAdminPrincipal(principal);
  const commandScope = `route_set.activate:${routeSetId}`;
  const requestHash = computeRequestHash("PUT", commandScope, {
    routeSetId,
    expectedVersionNo: body.expected_version_no,
    desiredRoutes: body.routes,
    actor,
    reason: body.reason,
  });

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  if (outcome.kind === "replay") {
    return buildReplayResponse(outcome.record, requestId, (responseBody) =>
      isActivationResponseBody(responseBody, routeSetId, body.expected_version_no),
    );
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
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
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
        // routeId 省略时不传（不落地空串 fallback）；routeKey 仍是稳定身份键。
        ...(r.route_id ? { routeId: r.route_id.trim() } : {}),
        routeKey: `route-${r.route_id?.trim() || randomUUID()}`,
        routeGroupId: r.route_group_id,
        target: wireTargetToCamel(r.target),
        policyRevisionId: r.policy_revision_id ?? null,
        modelPolicyRevisionId: r.model_policy_revision_id ?? null,
        toolsetRevisionId: r.toolset_revision_id ?? null,
        trafficWeight: r.traffic_weight,
        priorityNo: r.priority_no,
        effectiveFrom: r.effective_from ? new Date(r.effective_from) : null,
        effectiveUntil: r.effective_until ? new Date(r.effective_until) : null,
        eligibilityConditions: r.eligibility_conditions ?? {},
        activationState: (r.activation_state ?? "active") as "active" | "disabled",
      })),
      actor,
      reason: body.reason,
      requestId,
      idempotencyKey,
      idempotencyCompletion: {
        recordId,
        httpStatus: 200,
        serializeResponse: (activationResult) =>
          JSON.stringify(buildActivationResponse(activationResult)),
      },
    });

    // 8. 返回 200 + ETag
    const etag = `route-set-${result.routeSetVersionNo}`;
    return apiSuccess(buildActivationResponse(result), {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(etag),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof RouteSetNotFoundError) {
      return apiError("RESOURCE_NOT_FOUND", err.message, { requestId });
    }
    if (err instanceof RouteSetVersionConflictError) {
      return etagMismatchTable(requestId, err.message);
    }
    if (err instanceof ArtifactNotVerifiedForRouteError) {
      return apiError("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof RevisionNotPublishedError) {
      return apiError("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof RouteSetRequiresAtomicUpdateError) {
      return apiError("ROUTE_SET_REQUIRES_ATOMIC_UPDATE", err.message, { requestId });
    }
    throw err;
  }
}
