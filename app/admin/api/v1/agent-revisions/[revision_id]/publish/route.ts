import {
  AGENT_REVISION_ETAG_PREFIX,
  type AdminPrincipal,
  adminAuthErrorResponse,
  etagMismatchTable,
  parseAgentRevisionEtag,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { createPublishAgentRevision } from "@/lib/agents/application/publish-agent-revision";
import {
  AgentPublicationDescriptorSnapshotMissingError,
  AgentPublicationPrerequisiteError,
  AgentPublicationVersionConflictError,
  AgentRevisionPublicationNotFoundError,
  AgentRevisionPublicationStateError,
} from "@/lib/agents/domain/agent-revision-publication-policy";
/**
 * POST /admin/api/v1/agent-revisions/{revision_id}/publish — 发布 AgentRevision（S03-C05）。
 *
 * 事实源：docs/contracts/openapi.json（post_admin_api_v1_agent_revisions_by_revision_id_publish）、
 *         docs/architecture/api-and-events.md §6、
 *         docs/architecture/agent-control-plane.md S03-W05。
 *
 * 行为：
 * - 解析 admin 主体（SSO 管理员；CI/CD Service Identity 不允许发布）。
 * - 校验 action scope: agent.publish + resource { type: "agent", id: revision.agentId }。
 * - 校验 Idempotency-Key（必填）+ If-Match（Revision ETag，必填）。
 * - 校验 Revision 存在且属于当前租户（跨租户隐藏为 404）。
 * - 校验 If-Match ETag 与 Revision 当前的 agent-revision-{revisionNo} 一致（412 ETAG_MISMATCH）。
 * - 读取 Agent 当前 versionNo（用于乐观锁）。
 * - 调用 publishAgentRevision Application Service 完成发布事务。
 * - Idempotency 完成与发布事实同事务提交，Route 只返回原有 200 投影。
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
import { getAgentById } from "@/lib/agents/persistence/agent-queries";
import {
  AgentVersionConflictError,
  RevisionStateError,
  getRevisionById,
} from "@/lib/agents/persistence/agent-revision-queries";
import { mysqlAgentPublicationStore } from "@/lib/agents/persistence/mysql-agent-publication-store";
import { ArtifactNotVerifiedError } from "@/lib/artifacts/domain/artifact-attestation";
import {
  IDEMPOTENCY_KEY_HEADER,
  REQUEST_ID_HEADER,
  apiError,
  apiSuccess,
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

export const dynamic = "force-dynamic";

/**
 * 路径参数上下文（Next.js App Router 原生动态段）。
 * 命令作为资源子路径（`/{id}/command`），动态参数直接从 params 解构。
 */
interface RouteContext {
  params: Promise<Record<string, string | string[]>>;
}

/** 请求体 schema。 */
interface PublishBody {
  release_notes: string;
  evidence_refs?: unknown[];
  /** 可选 source Attestation id（Batch 2 不再强制；发布权威是 AgentDescriptorSnapshot 证据）。 */
  artifact_attestation_id?: string | null;
}

/** 校验请求体。 */
function validateBody(body: unknown): body is PublishBody {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.release_notes !== "string") return false;
  if (b.evidence_refs !== undefined && !Array.isArray(b.evidence_refs)) return false;
  if (
    b.artifact_attestation_id !== undefined &&
    b.artifact_attestation_id !== null &&
    (typeof b.artifact_attestation_id !== "string" || b.artifact_attestation_id.length === 0)
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

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const params = await context.params;
  const revisionId = typeof params.revision_id === "string" ? params.revision_id : "";

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
    return schemaInvalidTable(requestId, "缺少必填头 Idempotency-Key");
  }

  // 3. 解析 If-Match（必填）→ Revision ETag
  const ifMatch = parseIfMatch(request);
  if (!ifMatch) {
    return schemaInvalidTable(requestId, "缺少必填头 If-Match");
  }
  // 校验 If-Match ETag 格式（agent-revision-{revisionNo}）
  try {
    parseAgentRevisionEtag(ifMatch);
  } catch (err) {
    return schemaInvalidTable(
      requestId,
      err instanceof Error ? err.message : "If-Match ETag 格式非法",
    );
  }

  // 4. 校验 Revision 存在（跨租户隐藏为 404）
  const revision = await getRevisionById(revisionId);
  if (!revision) {
    return resourceNotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
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
  //    AgentRevision schema 无 tenantId 字段，通过 Agent 归属校验。
  const agent = await getAgentById(principal.tenantId, revision.agentId);
  if (!agent) {
    return resourceNotFound(requestId, `AgentRevision 不存在或无权访问: ${revisionId}`);
  }

  // 7. 校验 If-Match ETag 与 Revision 当前 revisionNo 一致
  const currentEtag = `${AGENT_REVISION_ETAG_PREFIX}${revision.revisionNo}`;
  if (ifMatch !== currentEtag) {
    return etagMismatchTable(requestId, `If-Match ${ifMatch} 与当前 ETag ${currentEtag} 不匹配`);
  }

  // 8. 解析请求体
  const body = await request.json().catch(() => null);
  if (!validateBody(body)) {
    return schemaInvalidTable(requestId, "请求体非法：缺少必填字段或字段类型错误");
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
  const publishAgentRevision = createPublishAgentRevision({
    store: mysqlAgentPublicationStore,
  });

  try {
    const publishResult = await publishAgentRevision({
      tenantId: principal.tenantId,
      revisionId,
      agentExpectedVersionNo: agent.versionNo,
      attestationId: body.artifact_attestation_id ?? null,
      actor: actorFromAdminPrincipal(principal),
      requestId,
      idempotencyKey,
      idempotency: {
        recordId,
        httpStatus: 200,
        responseRef: revisionId,
        serializeResponse: (published) =>
          JSON.stringify({
            id: published.revision.id,
            revision_state: published.revision.revisionState,
            published_at: published.revision.publishedAt?.toISOString() ?? null,
            audit_event_id: published.auditEventId,
          }),
      },
    });

    const responseBody = {
      id: publishResult.revision.id,
      revision_state: publishResult.revision.revisionState,
      published_at: publishResult.revision.publishedAt?.toISOString() ?? null,
      audit_event_id: publishResult.auditEventId,
    };

    return apiSuccess(responseBody, {
      status: 200,
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    await failRecord(recordId);

    if (err instanceof AgentPublicationDescriptorSnapshotMissingError) {
      return apiError("AGENT_DESCRIPTOR_SNAPSHOT_MISSING", err.message, { requestId });
    }
    if (err instanceof AgentPublicationPrerequisiteError) {
      return apiError("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (err instanceof ArtifactNotVerifiedError) {
      return apiError("ARTIFACT_NOT_VERIFIED", err.message, { requestId });
    }
    if (
      err instanceof AgentPublicationVersionConflictError ||
      err instanceof AgentVersionConflictError
    ) {
      const agentId =
        err instanceof AgentPublicationVersionConflictError ? err.agentId : err.agentId;
      const expectedVersionNo =
        err instanceof AgentPublicationVersionConflictError
          ? err.expectedVersionNo
          : err.expectedVersionNo;
      return etagMismatchTable(
        requestId,
        `Agent ${agentId} versionNo 不匹配（期望 ${expectedVersionNo}），并发冲突`,
      );
    }
    if (err instanceof AgentRevisionPublicationStateError) {
      return etagMismatchTable(requestId, `AgentRevision ${err.revisionId} 状态已并发变化`);
    }
    if (err instanceof RevisionStateError) {
      return etagMismatchTable(requestId, `AgentRevision ${err.revisionId} 状态已并发变化`);
    }
    throw err;
  }
}
