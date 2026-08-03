import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  parseIfMatch,
  v11Error,
  v11NotFound,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  parseRouteSetEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11EtagMismatch,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * PUT /admin/api/v1/deployment-routes/{route_id} — 更新 DeploymentRoute（S03-C05）。
 *
 * 事实源：../v11-agentkit-platform/contracts/v11.openapi.json（put_admin_api_v1_deployment_routes_by_route_id）、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6.3、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W05。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 If-Match（RouteSet ETag，必填）→ parseRouteSetEtag 提取 expectedVersionNo。
 * - 校验 Idempotency-Key（必填）。
 * - 校验 Route 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 body.route_set_id 与 Route.routeSetId 一致（一致性校验）。
 * - 校验 action scope: route.update + resource { type: "agent", id: routeSet.agentId }。
 * - 调用 upsertDeploymentRoute：ETag 乐观锁 + attestation 门禁 + 能力子集校验 + 权重校验 + 审计。
 * - completeRecord + 返回 200 + route 投影（含新 ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Route 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 格式非法 → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - RouteSet 不存在 → 404 RESOURCE_NOT_FOUND
 * - RouteSet ETag 不匹配 → 412 ETAG_MISMATCH
 * - attestation 未 verified → 409 ARTIFACT_NOT_VERIFIED
 * - 能力子集不满足 → 422 AGENT_CAPABILITY_UNSUPPORTED
 * - Revision 非 published → 422 BUSINESS_CONSTRAINT_VIOLATION
 * - 权重非法 → 400 REQUEST_SCHEMA_INVALID
 */
import {
  AgentCapabilityUnsupportedError,
  RevisionNotPublishedError,
  RouteNotFoundError,
  RouteSetNotFoundError,
  RouteSetVersionConflictError,
  RouteWeightInvalidError,
  getRouteById,
  getRouteSetById,
  upsertDeploymentRoute,
} from "@/lib/v11/control-plane/deployment-route-queries";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/v11/identity/audit";
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
import { ROUTE_STATES, type RouteState } from "@/lib/v11/schema/deployment-route";

export const dynamic = "force-dynamic";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ route_id: string }>;
}

/** 请求体 schema。 */
interface UpdateRouteBody {
  route_set_id: string;
  agent_revision_id: string;
  runtime_revision_id: string;
  traffic_weight: number;
  priority_no: number;
  route_state: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is UpdateRouteBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.route_set_id !== "string" || b.route_set_id.length === 0) return false;
  if (typeof b.agent_revision_id !== "string" || b.agent_revision_id.length === 0) return false;
  if (typeof b.runtime_revision_id !== "string" || b.runtime_revision_id.length === 0) return false;
  if (typeof b.traffic_weight !== "number" || !Number.isInteger(b.traffic_weight)) return false;
  if (typeof b.priority_no !== "number" || !Number.isInteger(b.priority_no)) return false;
  if (
    typeof b.route_state !== "string" ||
    !(ROUTE_STATES as readonly string[]).includes(b.route_state)
  )
    return false;
  return true;
}

/** 从主体提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 从主体提取审计 actor。 */
function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { route_id: routeId } = await context.params;

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 If-Match（必填）→ RouteSet ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return v11SchemaInvalid(requestId, "缺少必填头 If-Match");
  }
  let expectedVersionNo: number;
  try {
    expectedVersionNo = parseRouteSetEtag(ifMatch);
  } catch (err) {
    return v11SchemaInvalid(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 3. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：缺少 route_set_id/agent_revision_id/runtime_revision_id/traffic_weight/priority_no/route_state",
    );
  }

  // 5. 校验 Route 存在且属于当前租户（跨租户隐藏为 404）
  const route = await getRouteById(principal.tenantId, routeId);
  if (!route) {
    return v11NotFound(requestId, `DeploymentRoute 不存在或无权访问: ${routeId}`);
  }

  // 6. 一致性校验：body.route_set_id 必须与 Route.routeSetId 一致
  if (body.route_set_id !== route.routeSetId) {
    return v11SchemaInvalid(
      requestId,
      `route_set_id 不一致：body=${body.route_set_id}, route=${route.routeSetId}`,
    );
  }

  // 7. 获取 RouteSet（用于 action scope 的 agentId + 再次验证 ETag）
  const routeSet = await getRouteSetById(principal.tenantId, body.route_set_id);
  if (!routeSet) {
    return v11NotFound(requestId, `RouteSet 不存在或无权访问: ${body.route_set_id}`);
  }

  // 8. 校验 action scope（resource = agent, id = routeSet.agentId）
  const scopeResult = await requireAdminActionScope(
    principal,
    "route.update",
    { type: "agent", id: routeSet.agentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 9. 计算请求 hash + 幂等守卫。重放必须先于 ETag 校验，提交后断线重试仍返回原结果。
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("PUT", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `route.update:${routeId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 11. 处理幂等结果
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
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  // 12. 新命令才校验当前 ETag；已完成命令已在上方重放。
  if (expectedVersionNo !== routeSet.versionNo) {
    await failRecord(recordId);
    return v11EtagMismatch(
      requestId,
      `If-Match route-set-${expectedVersionNo} 与当前 route-set-${routeSet.versionNo} 不匹配`,
    );
  }

  // 13. 执行业务：ETag 乐观锁 + attestation 门禁 + 能力子集 + 权重 + 审计
  try {
    const result = await upsertDeploymentRoute({
      tenantId: principal.tenantId,
      routeSetId: body.route_set_id,
      routeId,
      routeSetExpectedVersionNo: expectedVersionNo,
      agentRevisionId: body.agent_revision_id,
      runtimeRevisionId: body.runtime_revision_id,
      trafficWeight: body.traffic_weight,
      priorityNo: body.priority_no,
      routeState: body.route_state as RouteState,
      actor: actorFromAdminPrincipal(principal),
      requestId,
      idempotencyKey,
      idempotency: {
        recordId,
        httpStatus: 200,
        responseRef: routeId,
        serializeResponse: (published) =>
          JSON.stringify({
            id: published.route.id,
            route_set_id: published.routeSet.id,
            agent_revision_id: published.route.agentRevisionId,
            runtime_revision_id: published.route.runtimeRevisionId,
            traffic_weight: published.route.trafficWeight,
            route_set_version_no: published.routeSet.versionNo,
            route_revision_id: published.routeRevision.id,
            route_activation_id: published.routeActivation.id,
            etag: published.etag,
            affects_new_invocations_only: published.affectsNewInvocationsOnly,
          }),
      },
    });

    const responseBody = {
      id: result.route.id,
      route_set_id: result.routeSet.id,
      agent_revision_id: result.route.agentRevisionId,
      runtime_revision_id: result.route.runtimeRevisionId,
      traffic_weight: result.route.trafficWeight,
      route_set_version_no: result.routeSet.versionNo,
      route_revision_id: result.routeRevision.id,
      route_activation_id: result.routeActivation.id,
      etag: result.etag,
      affects_new_invocations_only: result.affectsNewInvocationsOnly,
    };

    return v11Ok(responseBody, {
      status: 200,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(result.etag),
      },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof RouteSetNotFoundError) {
      return v11NotFound(requestId, err.message);
    }
    if (err instanceof RouteSetVersionConflictError) {
      return v11EtagMismatch(
        requestId,
        `RouteSet ${err.routeSetId} versionNo 不匹配（期望 ${err.expectedVersionNo}, 实际 ${err.actualVersionNo}），并发冲突`,
      );
    }
    if (err instanceof RouteNotFoundError) {
      return v11NotFound(requestId, err.message);
    }
    // ArtifactNotVerifiedForRouteError 是 deployment-route-queries 内部类（未导出），
    // 通过 error.name 检测以避免修改 S03-C04 已完成文件。
    if (err instanceof Error && err.name === "ArtifactNotVerifiedForRouteError") {
      return v11Error("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof AgentCapabilityUnsupportedError) {
      return v11Error(
        "AGENT_CAPABILITY_UNSUPPORTED",
        `AgentRevision required capabilities [${err.missingCapabilities.join(", ")}] 不在 RuntimeRevision capabilities 内`,
        { requestId },
      );
    }
    if (err instanceof RevisionNotPublishedError) {
      return v11Error("BUSINESS_CONSTRAINT_VIOLATION", err.message, { requestId });
    }
    if (err instanceof RouteWeightInvalidError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}
