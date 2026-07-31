/**
 * GET / POST /admin/api/v1/knowledge-bases — KnowledgeBase 集合（阶段 7 S07-C05）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §12（Knowledge Base）。
 * - ../v11-agentkit-platform/10-core-data-model.md §4.4（knowledge_base 字段）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W06。
 *
 * 行为：
 * - GET：列出 KnowledgeBase（lifecycle 过滤；默认排除 deleted）。
 * - POST：创建 KnowledgeBase（Idempotency-Key 必填；返回 201 + ETag）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - KnowledgeValidationError → 400 REQUEST_SCHEMA_INVALID
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  etagHeader,
  getRequestId,
  v11Ok,
} from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  type KnowledgeBaseLifecycleState,
  KnowledgeValidationError,
  createKnowledgeBase,
  listKnowledgeBases,
} from "@/lib/v11/context/knowledge-queries";
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
} from "@/lib/v11/identity/idempotency";

export const dynamic = "force-dynamic";

const VALID_LIFECYCLE_STATES: readonly KnowledgeBaseLifecycleState[] = [
  "active",
  "archived",
  "deleted",
];

interface CreateBody {
  knowledge_key: string;
  display_name: string;
  description?: string;
  owner_user_id?: string;
  visibility_policy_id?: string;
}

function validateBody(body: unknown): body is CreateBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.knowledge_key !== "string" || b.knowledge_key.length === 0) return false;
  if (typeof b.display_name !== "string" || b.display_name.length === 0) return false;
  if (b.description !== undefined && typeof b.description !== "string") return false;
  if (b.owner_user_id !== undefined && typeof b.owner_user_id !== "string") return false;
  if (b.visibility_policy_id !== undefined && typeof b.visibility_policy_id !== "string")
    return false;
  return true;
}

function callerFromAdminPrincipal(principal: AdminPrincipal) {
  if ("userIdentityId" in principal) {
    return callerFromPrincipal(principal);
  }
  return callerFromWorkloadPrincipal(principal);
}

function createdByFromAdminPrincipal(principal: AdminPrincipal): string {
  if ("userIdentityId" in principal) {
    return principal.userIdentityId;
  }
  return principal.serviceId ?? principal.claims.tenantId;
}

function projectBase(base: {
  id: string;
  knowledgeKey: string;
  displayName: string;
  description: string | null;
  ownerUserId: string | null;
  visibilityPolicyId: string | null;
  indexState: string;
  lifecycleState: string;
  versionNo: string;
  createdAt: Date;
  updatedAt: Date;
}): Record<string, unknown> {
  return {
    id: base.id,
    knowledge_key: base.knowledgeKey,
    display_name: base.displayName,
    description: base.description,
    owner_user_id: base.ownerUserId,
    visibility_policy_id: base.visibilityPolicyId,
    index_state: base.indexState,
    lifecycle_state: base.lifecycleState,
    version_no: base.versionNo,
    created_at: base.createdAt.toISOString(),
    updated_at: base.updatedAt.toISOString(),
    etag: `knowledge-base-${base.versionNo}`,
  };
}

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.base.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const lifecycleParam = url.searchParams.get("lifecycle_state");

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  const lifecycleStates: KnowledgeBaseLifecycleState[] | undefined = lifecycleParam
    ? (lifecycleParam
        .split(",")
        .filter((s) =>
          (VALID_LIFECYCLE_STATES as readonly string[]).includes(s),
        ) as KnowledgeBaseLifecycleState[])
    : undefined;

  const items = await listKnowledgeBases(principal.tenantId, {
    lifecycleStates,
    limit,
  });

  return v11Ok(
    { items: items.map(projectBase) },
    {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const scopeResult = await requireAdminActionScope(
    principal,
    "knowledge.base.create",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(
      requestId,
      "请求体非法：缺少 knowledge_key/display_name 或字段类型错误",
    );
  }

  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = "knowledge.base.create";

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
      return buildIdempotencyErrorResponse({
        record: outcome.record,
        reason: "conflict",
        requestId,
      });
    }
    recordId = reset.id;
  }

  try {
    const base = await createKnowledgeBase({
      tenantId: principal.tenantId,
      knowledgeKey: body.knowledge_key,
      displayName: body.display_name,
      description: body.description ?? null,
      ownerUserId: body.owner_user_id ?? null,
      visibilityPolicyId: body.visibility_policy_id ?? null,
      createdBy: createdByFromAdminPrincipal(principal),
    });

    const responseBody = projectBase(base);
    await completeRecord({
      recordId,
      httpStatus: 201,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 201,
      headers: {
        [REQUEST_ID_HEADER]: requestId,
        ...etagHeader(`knowledge-base-${base.versionNo}`),
      },
    });
  } catch (err) {
    await failRecord(recordId);
    if (err instanceof KnowledgeValidationError) {
      return v11SchemaInvalid(requestId, err.message);
    }
    throw err;
  }
}
