/**
 * POST /admin/api/v1/memory-candidates/{candidate_id}:resolve — 管理员复核 Memory Candidate（阶段 7 S07-C03）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/03-context-memory-and-knowledge.md §10（写入路径）、§11（禁止内容与用户控制）。
 * - ../v11-agentkit-platform/10-core-data-model.md §7.5（memory_candidate / memory_entry / memory_source）。
 * - ../v11-agentkit-platform/13-memory-and-job-api.md §2（Memory Candidate API）。
 * - ../v11-agentkit-platform/14-production-operations-security-and-retention.md §5（动作目录与资源 Scope）。
 * - ../v11-agentkit-platform-development-plan/07-context-memory-and-knowledge.md S07-W04。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员或 CI/CD Service Identity）。
 * - 校验 Idempotency-Key（必填）。
 * - 从路径提取 candidate_id。
 * - 校验请求体（decision / scope / reason_codes / notes）。
 * - 按 (tenantId, candidateId) 查询 Candidate（跨租户隔离）。
 * - 校验 candidate 的 proposedScopeType 可复核（workspace/agent/organization）。
 * - 校验 admin 拥有 memory.review action scope（resource = candidate 的 scope）。
 * - 校验 scope 收窄方向（accept 时只能缩小 scope）。
 * - 调用 resolveMemoryCandidate（SELECT FOR UPDATE 防并发）。
 *   - 已复核 → 409 MEMORY_CANDIDATE_ALREADY_RESOLVED。
 * - completeRecord + 返回 200 + candidate 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少 Idempotency-Key → 400 REQUEST_SCHEMA_INVALID
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 * - Candidate 不存在 → 404 RESOURCE_NOT_FOUND
 * - Candidate 已复核 → 409 MEMORY_CANDIDATE_ALREADY_RESOLVED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 *
 * 边界：
 * - 管理员只能缩小 scope，不能扩大。
 * - reject 时销毁正文。
 * - accept 时同事务创建 MemoryEntry + MemorySource。
 */
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  getRequestId,
  v11Error,
  v11NotFound,
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
  MemoryCandidateAlreadyResolvedError,
  getMemoryCandidateById,
  isReviewableScopeType,
  isScopeNarrowingValid,
  resolveMemoryCandidate,
} from "@/lib/v11/context/memory-queries";
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
import { MEMORY_SCOPE_TYPES, type MemoryScopeType } from "@/lib/v11/schema/memory";

export const dynamic = "force-dynamic";

/** 从 URL 路径提取 candidate_id（路径形如 /admin/api/v1/memory-candidates/{candidate_id}:resolve）。 */
function extractCandidateId(url: string): string | null {
  const match = url.match(/\/admin\/api\/v1\/memory-candidates\/(.+?):resolve(?:[/?#]|$)/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** 请求体 schema。 */
interface ResolveBody {
  decision: string;
  scope?: {
    type?: string;
    ref?: string;
  };
  reason_codes?: string[];
  notes?: string;
}

/** 校验请求体。返回 [valid, errorMessage, parsed]。 */
function validateBody(body: unknown): [boolean, string, ResolveBody | null] {
  if (!body || typeof body !== "object") {
    return [false, "请求体必须是 JSON 对象", null];
  }
  const b = body as Record<string, unknown>;

  // decision 必填，accept 或 reject
  if (typeof b.decision !== "string" || (b.decision !== "accept" && b.decision !== "reject")) {
    return [false, "decision 必须是 accept 或 reject", null];
  }

  // scope 可选，对象
  if (b.scope !== undefined && b.scope !== null) {
    if (typeof b.scope !== "object") {
      return [false, "scope 必须是对象", null];
    }
    const scope = b.scope as Record<string, unknown>;
    if (scope.type !== undefined && scope.type !== null) {
      if (
        typeof scope.type !== "string" ||
        !MEMORY_SCOPE_TYPES.includes(scope.type as MemoryScopeType)
      ) {
        return [false, `scope.type 必须是 ${MEMORY_SCOPE_TYPES.join(" / ")} 之一`, null];
      }
    }
    if (scope.ref !== undefined && scope.ref !== null) {
      if (typeof scope.ref !== "string" || scope.ref.length === 0) {
        return [false, "scope.ref 必须是非空字符串", null];
      }
    }
  }

  // reason_codes 可选，字符串数组
  if (b.reason_codes !== undefined && b.reason_codes !== null) {
    if (!Array.isArray(b.reason_codes) || !b.reason_codes.every((c) => typeof c === "string")) {
      return [false, "reason_codes 必须是字符串数组", null];
    }
  }

  // notes 可选，字符串
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== "string") {
      return [false, "notes 必须是字符串", null];
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

/** 把 Candidate 行投影为 API 响应体。 */
function projectCandidate(candidate: {
  id: string;
  candidateState: string;
  resolvedMemoryEntryId: string | null;
  decisionReasonCodesJson: string[] | null;
  proposedScopeType: string;
  proposedScopeRef: string | null;
  proposedAt: Date;
  resolvedAt: Date | null;
}): {
  candidate_id: string;
  candidate_state: string;
  memory_entry_id: string | null;
  decision_reason_codes: string[] | null;
  proposed_scope: { type: string; ref: string | null };
  proposed_at: string;
  resolved_at: string | null;
} {
  return {
    candidate_id: candidate.id,
    candidate_state: candidate.candidateState,
    memory_entry_id: candidate.resolvedMemoryEntryId,
    decision_reason_codes: candidate.decisionReasonCodesJson,
    proposed_scope: {
      type: candidate.proposedScopeType,
      ref: candidate.proposedScopeRef,
    },
    proposed_at: candidate.proposedAt.toISOString(),
    resolved_at: candidate.resolvedAt ? candidate.resolvedAt.toISOString() : null,
  };
}

/** POST /admin/api/v1/memory-candidates/{candidate_id}:resolve handler。 */
export async function memoryCandidateResolvePOST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 admin 身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? v11Error("AUTHENTICATION_REQUIRED", "身份解析失败", { requestId });
  }

  // 2. 校验 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 提取 candidate_id
  const candidateId = extractCandidateId(request.url);
  if (!candidateId) {
    return v11SchemaInvalid(requestId, "路径缺少 candidate_id");
  }

  // 4. 解析请求体
  const body = await request.json().catch(() => null);
  const [valid, errorMessage, parsed] = validateBody(body);
  if (!valid || !parsed) {
    return v11SchemaInvalid(requestId, errorMessage);
  }

  // 5. 查询 Candidate（跨租户隔离）
  const tenantId = principal.tenantId;
  const candidate = await getMemoryCandidateById(tenantId, candidateId);
  if (!candidate) {
    return v11NotFound(requestId, "Memory Candidate 不存在或无权访问");
  }

  // 6. 校验 proposedScopeType 可复核（workspace/agent/organization）
  if (!isReviewableScopeType(candidate.proposedScopeType as MemoryScopeType)) {
    return v11Error(
      "ACTION_SCOPE_DENIED",
      `Candidate 的 proposed_scope_type=${candidate.proposedScopeType} 不支持管理员复核`,
      { requestId },
    );
  }

  // 7. 校验 admin action scope: memory.review + resource { type, id }
  const resourceType = candidate.proposedScopeType as "workspace" | "agent" | "organization";
  // organization scope 的 ref 可能为 null，使用 tenantId 作为 resource id。
  // workspace/agent 的 ref 必须非空（提交时校验）。
  const resourceId =
    candidate.proposedScopeRef ?? (resourceType === "organization" ? tenantId : candidate.id);

  const scopeResult = await requireAdminActionScope(
    principal,
    "memory.review",
    { type: resourceType, id: resourceId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 8. 校验 scope 收窄方向（accept 时）
  let resolvedScopeType: MemoryScopeType | null = null;
  let resolvedScopeRef: string | null = null;
  if (parsed.decision === "accept" && parsed.scope?.type) {
    resolvedScopeType = parsed.scope.type as MemoryScopeType;
    resolvedScopeRef = parsed.scope.ref ?? null;
    if (!isScopeNarrowingValid(candidate.proposedScopeType as MemoryScopeType, resolvedScopeType)) {
      return v11SchemaInvalid(
        requestId,
        `scope 收窄方向非法：proposed=${candidate.proposedScopeType} → resolved=${resolvedScopeType}（只能缩小，不能扩大）`,
      );
    }
  }

  // 9. 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `memory.candidate.resolve:${candidateId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 10. 幂等重放 / 冲突处理
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

  // 11. 执行业务：复核 Candidate
  try {
    const result = await resolveMemoryCandidate({
      tenantId,
      candidateId,
      decision: parsed.decision as "accept" | "reject",
      resolvedScopeType,
      resolvedScopeRef,
      reasonCodes: parsed.reason_codes ?? null,
      reviewerNotes: parsed.notes ?? null,
    });

    // 12. completeRecord + 返回 200
    const responseBody = projectCandidate(result.candidate);
    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRef: result.candidate.id,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof MemoryCandidateAlreadyResolvedError) {
      return v11Error(
        "MEMORY_CANDIDATE_ALREADY_RESOLVED",
        `Memory Candidate 已被复核（currentState=${err.currentState}）`,
        { requestId },
      );
    }
    throw err;
  }
}
