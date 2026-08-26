/**
 * POST /admin/api/v1/deployment-route-sets — RouteSet 登记（create-or-reuse）。
 *
 * 授权管理员只需给出 agent_id + route_scope_key + route_scope，即可创建或复用
 * 该 Agent+Scope 的正式 RouteSet（自然键 tenantId+agentId+routeScopeKey），无需
 * 知道 RouteSet id。首次创建后 route_scope 不可变（RFC 8785 语义比较）。
 *
 * 必填：Idempotency-Key header。
 * 请求体：{ agent_id, route_scope_key, route_scope }（严格 exact keys）。
 *
 * 本路由不创建 Route/Revision/Activation，也不读取 contract/runtime/source。
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
  resourceNotFound,
} from "@/lib/http";
import {
  buildIdempotencyErrorResponse,
  buildReplayResponse,
  callerFromPrincipal,
  callerFromWorkloadPrincipal,
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";
import {
  type DeploymentRouteSetRow,
  RouteSetScopeMismatchError,
  ensureRouteSetByAgentScope,
} from "@/lib/routes/application/deployment-route-service";

export const dynamic = "force-dynamic";

interface CreateRouteSetBody {
  agent_id: string;
  route_scope_key: string;
  route_scope: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格校验：恰好三个 key，字符串 trim 后非空，route_scope 为纯 JSON object。 */
function validateBody(body: unknown): body is CreateRouteSetBody {
  if (!isPlainObject(body)) return false;
  const keys = Object.keys(body).sort();
  if (keys.length !== 3) return false;
  if (keys.join(",") !== "agent_id,route_scope,route_scope_key") return false;
  if (typeof body.agent_id !== "string" || body.agent_id.trim().length === 0) return false;
  if (typeof body.route_scope_key !== "string" || body.route_scope_key.trim().length === 0)
    return false;
  return isPlainObject(body.route_scope);
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  return "userIdentityId" in principal
    ? callerFromPrincipal(principal)
    : callerFromWorkloadPrincipal(principal);
}

/** 精确投影：仅 8 个字段，不含 contract/runtime/secret/source 等任何底层数据。 */
function buildRouteSetProjection(row: DeploymentRouteSetRow, created: boolean) {
  return {
    id: row.id,
    agent_id: row.agentId,
    route_scope_key: row.routeScopeKey,
    route_scope: row.routeScopeJson,
    version_no: row.versionNo,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    created,
  };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 认证
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");

  // 3. 严格请求体
  const raw = await request.json().catch(() => null);
  if (!validateBody(raw)) return schemaInvalidTable(requestId, "请求体格式非法");
  const body = raw;

  // 4. Agent 必须存在于调用方租户（跨租户/缺失统一隐藏 404）；agent_id 统一 trim 一次
  const agentId = body.agent_id.trim();
  const agent = await getAgentById(principal.tenantId, agentId);
  if (!agent) return resourceNotFound(requestId, `Agent 不存在或无权访问: ${agentId}`);

  // 5. 授权：route.update 限定到具体 Agent
  const scope = await requireAdminActionScope(
    principal,
    "route.update",
    {
      type: "agent",
      id: agent.id,
    },
    requestId,
  );
  if (!scope.ok) return scope.response;

  // 6. 幂等守卫（command scope = Agent + route_scope_key）
  const routeScopeKey = body.route_scope_key.trim();
  const commandScope = `route_set.ensure:${agentId}:${routeScopeKey}`;
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

  // 7. create-or-reuse
  try {
    const result = await ensureRouteSetByAgentScope({
      tenantId: principal.tenantId,
      agentId,
      routeScopeKey,
      routeScopeJson: body.route_scope,
    });
    const projection = buildRouteSetProjection(result.routeSet, result.created);
    const httpStatus = result.created ? 201 : 200;
    await completeRecord({
      recordId,
      httpStatus,
      responseRedactedJson: JSON.stringify(projection),
    });
    return apiSuccess(projection, {
      status: httpStatus,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof RouteSetScopeMismatchError) {
      // 自然键已存在且 route_scope 语义不一致：冲突（409，目录映射），不泄露 scope 内容。
      return apiError("OPERATION_PAYLOAD_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
