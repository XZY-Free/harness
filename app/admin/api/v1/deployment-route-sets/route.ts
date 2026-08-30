/**
 * POST /admin/api/v1/deployment-route-sets — RouteSet 登记（create-or-reuse）。
 *
 * 授权管理员只需给出判别 target + route_scope_key + route_scope，即可创建或复用
 * 对应 RouteSet（自然键 tenantId+targetKind+targetIdentity+routeScopeKey），无需
 * 知道 RouteSet id。首次创建后 route_scope 不可变（RFC 8785 语义比较）。
 *
 * 必填：Idempotency-Key header。
 * 请求体：{ target, route_scope_key, route_scope }（严格 exact keys）。
 * target：{kind:"runtime"} | {kind:"agent", agent_id}（严格 exact keys）。
 *
 * 冻结架构：旧扁平 { agent_id, ... } 一律 400，绝不走到 create-or-reuse。
 * 本路由不创建 Route/Revision/Activation。
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
import type { RouteTarget } from "@/lib/routes/application/deployment-route-service";
import {
  type DeploymentRouteSetRow,
  RouteSetScopeMismatchError,
  ensureRouteSetByTargetScope,
} from "@/lib/routes/application/deployment-route-service";

export const dynamic = "force-dynamic";

/** wire target（snake_case agent_id）— 未经 parseTarget 前仍是原始 body，非 camel RouteTarget。 */
type WireRouteSetTarget = { kind: "runtime" } | { kind: "agent"; agent_id: string };

interface CreateRouteSetBody {
  target: WireRouteSetTarget;
  route_scope_key: string;
  route_scope: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 严格校验 target 判别联合（exact keys）。
 * - runtime：仅 {kind:"runtime"}。
 * - agent：仅 {kind:"agent", agent_id}，agent_id trim 后非空。
 * omitted/null/extra/blank 一律失败。
 */
function parseTarget(raw: unknown): RouteTarget | null {
  if (!isPlainObject(raw)) return null;
  const keys = Object.keys(raw).sort();
  if (raw.kind === "runtime") {
    if (keys.length !== 1 || keys[0] !== "kind") return null;
    return { kind: "runtime" };
  }
  if (raw.kind === "agent") {
    if (keys.length !== 2 || keys.join(",") !== "agent_id,kind") return null;
    if (!isNonBlankString(raw.agent_id)) return null;
    return { kind: "agent", agentId: raw.agent_id.trim() };
  }
  return null;
}

/** 严格校验：恰好三个 key，route_scope_key 非空，route_scope 为纯 JSON object。 */
function validateBody(body: unknown): body is CreateRouteSetBody {
  if (!isPlainObject(body)) return false;
  const keys = Object.keys(body).sort();
  if (keys.length !== 3) return false;
  if (keys.join(",") !== "route_scope,route_scope_key,target") return false;
  if (!isNonBlankString(body.route_scope_key)) return false;
  if (!isPlainObject(body.route_scope)) return false;
  return parseTarget(body.target) !== null;
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
    target: routeSetTargetToWire(row),
    route_scope_key: row.routeScopeKey,
    route_scope: row.routeScopeJson,
    version_no: row.versionNo,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    created,
  };
}

/** 从显式 DB trio（targetKind/targetIdentity/agentId）严格构造 wire target，畸形抛错。 */
function routeSetTargetToWire(row: DeploymentRouteSetRow) {
  if (row.targetKind === "runtime") {
    if (row.targetIdentity !== "runtime" || row.agentId !== null) {
      throw new Error(`RouteSet ${row.id} runtime target trio 畸形`);
    }
    return { kind: "runtime" as const };
  }
  if (row.targetKind === "agent") {
    if (
      typeof row.agentId !== "string" ||
      row.agentId.trim() === "" ||
      row.targetIdentity !== row.agentId
    ) {
      throw new Error(`RouteSet ${row.id} agent target trio 畸形`);
    }
    return { kind: "agent" as const, agent_id: row.agentId };
  }
  throw new Error(`RouteSet ${row.id} targetKind 非法: ${String(row.targetKind)}`);
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

  // 3. 严格请求体（exact keys，target 判别联合）
  const raw = await request.json().catch(() => null);
  if (!validateBody(raw)) return schemaInvalidTable(requestId, "请求体格式非法");
  const body = raw;
  const target = parseTarget(body.target);
  if (!target) return schemaInvalidTable(requestId, "请求体格式非法");

  const routeScopeKey = body.route_scope_key.trim();

  // 4. 授权 + 目标存在性（agent target 查 Agent；runtime target 用 environment scope）
  if (target.kind === "agent") {
    const agent = await getAgentById(principal.tenantId, target.agentId);
    if (!agent) return resourceNotFound(requestId, `Agent 不存在或无权访问: ${target.agentId}`);
    const scope = await requireAdminActionScope(
      principal,
      "route.update",
      { type: "agent", id: agent.id },
      requestId,
    );
    if (!scope.ok) return scope.response;
  } else {
    const scope = await requireAdminActionScope(
      principal,
      "route.update",
      { type: "environment", id: routeScopeKey },
      requestId,
    );
    if (!scope.ok) return scope.response;
  }

  // 5. 幂等守卫（command scope 含 target kind/identity + scope）
  const targetKey = target.kind === "agent" ? target.agentId : "runtime";
  const commandScope = `route_set.ensure:${target.kind}:${targetKey}:${routeScopeKey}`;
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

  // 6. create-or-reuse（显式 target 自然键）
  try {
    const result = await ensureRouteSetByTargetScope({
      tenantId: principal.tenantId,
      target,
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
      // 自然键已存在且 route_scope 语义不一致：冲突（409），不泄露 scope 内容。
      return apiError("OPERATION_PAYLOAD_CONFLICT", err.message, { requestId });
    }
    throw err;
  }
}
