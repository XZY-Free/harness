import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  getRequestId,
  parseIfMatch,
  v11Error,
  v11NotFound,
  v11Ok,
} from "@/lib/http";
import {
  AGENT_REVISION_ETAG_PREFIX,
  type AdminPrincipal,
  adminAuthErrorResponse,
  parseAgentRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11EtagMismatch,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
/**
 * POST /admin/api/v1/agent-revisions/{revision_id}:publish — 发布 AgentRevision（S03-C05）。
 *
 * 事实源：../v11-agentkit-platform/contracts/v11.openapi.json（post_admin_api_v1_agent_revisions_by_revision_id_publish）、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W05。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员；CI/CD Service Identity 不允许发布）。
 * - 校验 action scope: agent.publish + resource { type: "agent", id: revision.agentId }。
 * - 校验 Idempotency-Key（必填）+ If-Match（Revision ETag，必填）。
 * - 校验 Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 If-Match ETag 与 Revision 当前的 agent-revision-{revisionNo} 一致（412 ETAG_MISMATCH）。
 * - 读取 Agent 当前 versionNo（用于 publishAgentRevisionWithAttestation 乐观锁）。
 * - 调用 publishAgentRevisionWithAttestation：attestation 门禁 + publish + agent.publish 审计。
 * - completeRecord + 返回 200 + published 投影。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - Service Identity 发布 → 403 ACTION_SCOPE_DENIED（cicd 不在 agent.publish 白名单）
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - Idempotency 冲突 → 409 IDEMPOTENCY_CONFLICT
 * - Revision 不存在/跨租户 → 404 RESOURCE_NOT_FOUND
 * - If-Match 不匹配 → 412 ETAG_MISMATCH
 * - attestation 未验证 → 409 ARTIFACT_NOT_VERIFIED
 * - Agent 乐观锁冲突 → 412 ETAG_MISMATCH
 * - 请求体非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { getAgentById } from "@/lib/v11/control-plane/agent-queries";
import {
  AgentVersionConflictError,
  getRevisionById,
} from "@/lib/v11/control-plane/agent-revision-queries";
import {
  ArtifactNotVerifiedError,
  publishAgentRevisionWithAttestation,
} from "@/lib/v11/control-plane/artifact-attestation-queries";
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
  completeRecord,
  computeRequestHash,
  enforceIdempotency,
  failRecord,
  prepareRetryForFailedRecord,
} from "@/lib/v11/identity/idempotency";

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 动态段，含冒号 custom method）。
 *
 * Next.js 类型验证器不识别 `[revision_id]:publish` 为标准动态段（生成 Promise<{}>），
 * 故使用 Record 宽类型；运行时 params key 为 "revision_id:publish"。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface PublishBody {
  release_notes: string;
  evidence_refs?: unknown[];
  artifact_attestation_id: string;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is PublishBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.release_notes !== "string") return false;
  if (b.evidence_refs !== undefined && !Array.isArray(b.evidence_refs)) return false;
  if (typeof b.artifact_attestation_id !== "string" || b.artifact_attestation_id.length === 0)
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

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  // Next.js 把 [revision_id]:publish 段名作为 key；revision_id 是冒号前的部分。
  const rawValue = params["revision_id:publish"];
  const rawSegment = typeof rawValue === "string" ? rawValue : "";
  const revisionId = rawSegment.split(":")[0] ?? "";

  // 1. 解析身份
  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 解析 Idempotency-Key（必填）
  const idempotencyKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim();
  if (!idempotencyKey) {
    return v11SchemaInvalid(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析 If-Match（必填）→ Revision ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return v11SchemaInvalid(requestId, "缺少必填头 If-Match");
  }
  // 校验 If-Match ETag 格式（agent-revision-{revisionNo}）
  try {
    parseAgentRevisionEtag(ifMatch);
  } catch (err) {
    return v11SchemaInvalid(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 4. 校验 Revision 存在（跨租户隐藏为 404）
  const revision = await getRevisionById(revisionId);
  if (!revision) {
    return v11NotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }

  // 5. 校验 action scope（需要先读 Agent 拿 agentId 作为 resource id）
  //    resource type=agent，resource id=agentId（不是 revisionId）
  const scopeResult = await requireAdminActionScope(
    principal,
    "agent.publish",
    { type: "agent", id: revision.agentId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 6. 校验 Revision 属于当前租户的 Agent（跨租户隐藏为 404）
  //    V11AgentRevision schema 无 tenantId 字段，通过 Agent 归属校验。
  const agent = await getAgentById(principal.tenantId, revision.agentId);
  if (!agent) {
    return v11NotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }

  // 7. 校验 If-Match ETag 与 Revision 当前 revisionNo 一致
  const currentEtag = `${AGENT_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
  if (ifMatch !== currentEtag) {
    return v11EtagMismatch(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }

  // 8. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return v11SchemaInvalid(requestId, "请求体非法：缺少 release_notes 或 artifact_attestation_id");
  }

  // 9. 计算请求 hash + 幂等守卫
  const path = new URL(request.url).pathname;
  const requestHash = computeRequestHash("POST", path, body);
  const caller = callerFromAdminPrincipal(principal);
  const commandScope = `agent.publish:${revisionId}`;

  const outcome = await enforceIdempotency({
    caller,
    commandScope,
    idempotencyKey,
    requestHash,
  });

  // 10. 处理幂等结果
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

  // 11. 执行业务：attestation 门禁 + publish + agent.publish 审计
  try {
    const result = await publishAgentRevisionWithAttestation(
      principal.tenantId,
      revisionId,
      agent.versionNo,
      body.artifact_attestation_id,
      actorFromAdminPrincipal(principal),
      requestId,
    );

    const responseBody = {
      id: result.revision.id,
      revision_state: result.revision.revisionState,
      published_at: result.revision.publishedAt?.toISOString() ?? null,
      audit_event_id: result.auditEventId,
    };

    await completeRecord({
      recordId,
      httpStatus: 200,
      responseRedactedJson: JSON.stringify(responseBody),
    });

    return v11Ok(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof ArtifactNotVerifiedError) {
      return v11Error("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof AgentVersionConflictError) {
      return v11EtagMismatch(
        requestId,
        `Agent ${err.agentId} versionNo 不匹配（期望 ${err.expectedVersionNo}），并发冲突`,
      );
    }
    throw err;
  }
}
