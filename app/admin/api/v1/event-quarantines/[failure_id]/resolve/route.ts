import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import {
  type QuarantineResolution,
  getDeliveryFailureById,
  resolveQuarantine,
} from "@/lib/conversations/projection-operations";
/**
 * POST /admin/api/v1/event-quarantines/{failure_id}/resolve — 管理员处置 quarantined 事件交付失败（S12-W01）。
 *
 * 事实源：
 * - docs/architecture/security.md §2.1（投影消费协议七条规则）
 * - docs/architecture/persistence.md §8.1（event_delivery_failure）
 * - docs/architecture/security.md S12-W01
 *
 * 行为：
 * - 解析 admin 主体。
 * - 校验 Idempotency-Key（必填）。
 * - 从路径提取 failure_id。
 * - 校验请求体（resolution: replay|skip，reason 可选）。
 * - 按 (tenantId, failureId) 查询失败记录（跨租户隐藏为 404）。
 * - 校验 failure 处于 quarantined 状态（否则 422 EVENT_QUARANTINE_RESOLUTION_NOT_ALLOWED）。
 * - 校验 action scope: event.quarantine.resolve + resource { type: "tenant", id: tenantId }。
 * - 幂等守卫。
 * - 调用 resolveQuarantine（replay 重放 / skip 前移 checkpoint），写审计 event.quarantine.resolve。
 * - completeRecord + 返回 200 + resolved 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - 失败记录不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 非 quarantined 状态 → 422 EVENT_QUARANTINE_RESOLUTION_NOT_ALLOWED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
  getRequestId,
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
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/identity/idempotency";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface ResolveBody {
  resolution: string;
  reason?: string;
}

/** 校验请求体。返回 [valid, errorMessage, parsed]。 */
function validateBody(body: unknown): [boolean, string, ResolveBody | null] {
  if (!body || typeof body !== "object") {
    return [false, "请求体必须是 JSON 对象", null];
  }
  const b = body as Record<string, unknown>;

  if (typeof b.resolution !== "string" || (b.resolution !== "replay" && b.resolution !== "skip")) {
    return [false, "resolution 必须是 replay 或 skip", null];
  }

  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== "string") {
      return [false, "reason 必须是字符串", null];
    }
  }

  return [true, "", body as ResolveBody];
}

/** 从 AdminPrincipal 提取幂等 caller。 */
function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

/** 从 AdminPrincipal 提取审计 actor。 */
function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const failureId = typeof params.failure_id === "string" ? params.failure_id : "";

  // 1. 解析 admin 身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? apiError("AUTHENTICATION_REQUIRED", "身份解析失败", { requestId });
  }

  // 2. 校验 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析请求体
  const body = await request.json().catch(() => null);
  const [valid, errorMessage, parsed] = validateBody(body);
  if (!valid || !parsed) {
    return schemaInvalidTable(requestId, errorMessage);
  }

  // 4. 查询失败记录（租户隔离，跨租户 404）
  const failure = await getDeliveryFailureById(principal.tenantId, failureId);
  if (!failure) {
    return resourceNotFound(requestId, `事件交付失败记录不存在或无权访问: ${failureId}`);
  }

  // 5. 校验 failure 处于 quarantined 状态
  if (failure.failureState !== "quarantined") {
    return apiError(
      "EVENT_QUARANTINE_RESOLUTION_NOT_ALLOWED",
      `failure 状态非 quarantined（当前 ${failure.failureState}），拒绝处置`,
      { requestId },
    );
  }

  // 6. 校验 action scope: event.quarantine.resolve + resource { type: "tenant", id: tenantId }
  const scopeResult = await requireAdminActionScope(
    principal,
    "event.quarantine.resolve",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 7. 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `event.quarantine.resolve:${failureId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 8. 幂等重放 / 冲突处理
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

  // 9. 执行业务：resolveQuarantine（replay 或 skip）+ 审计
  try {
    const result = await resolveQuarantine({
      failureId,
      resolution: parsed.resolution as QuarantineResolution,
      actor: actorFromAdminPrincipal(principal),
      reason: parsed.reason ?? null,
      requestId,
    });

    const responseBody = {
      id: result.failure.id,
      consumer_name: result.failure.consumerName,
      stream_type: result.failure.streamType,
      stream_id: result.failure.streamId,
      event_id: result.failure.eventId,
      event_sequence: result.failure.eventSequence,
      failure_state: result.failure.failureState,
      resolution: result.resolution,
      replayed_count: result.replayedCount,
      resolved_at: result.failure.resolvedAt ? result.failure.resolvedAt.toISOString() : null,
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);
    throw err;
  }
}
