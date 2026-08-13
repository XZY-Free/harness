/**
 * GET /gateway/v1/memory-candidates/{candidate_id} — 查询 Memory Candidate（阶段 7 S07-C03）。
 *
 * 事实源：
 * - docs/architecture/memory-and-job-api.md §2（Memory Candidate API）。
 * - docs/architecture/api-and-events.md §3（Gateway API）。
 *
 * 行为：
 * - 解析 Bearer Token（Workload Token，audience=gateway，绑定 invocation）。
 * - 从路径提取 candidate_id。
 * - 按 (tenantId, candidateId, invocationId) 查询 Candidate（Token invocationId 必须匹配）。
 * - 不存在 / 跨租户 / 跨 Invocation → 404 RESOURCE_NOT_FOUND（隐藏式，不暴露存在性）。
 * - 返回 200 + candidate 投影。
 *
 * 边界：
 * - rejected candidate 不回显正文内容。
 * - Gateway Token 的 invocationId 必须与 candidate 的 invocationId 一致。
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import { getMemoryCandidateByIdAndInvocation } from "@/lib/context/memory-queries";
import {
  type GatewayPrincipal,
  gatewayAuthErrorResponse,
  resolveGatewayPrincipal,
} from "@/lib/gateway/route-helpers";

export const dynamic = "force-dynamic";

/** 从 URL 路径提取 candidate_id。 */
function extractCandidateId(url: string): string | null {
  // 路径形如 /gateway/v1/memory-candidates/{candidate_id}
  const match = url.match(/\/gateway\/v1\/memory-candidates\/([^/?#]+)/);
  const id = match?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** 把 Candidate 行投影为 API 响应体（snake_case；rejected 不回显内容）。 */
function projectCandidate(candidate: {
  id: string;
  invocationId: string;
  candidateState: string;
  resolvedMemoryEntryId: string | null;
  decisionReasonCodesJson: string[] | null;
  proposedScopeType: string;
  proposedScopeRef: string | null;
  memoryType: string;
  contentRef: string | null;
  contentHash: string;
  sensitivityClass: string;
  proposedAt: Date;
  resolvedAt: Date | null;
}): {
  candidate_id: string;
  invocation_id: string;
  candidate_state: string;
  memory_entry_id: string | null;
  decision_reason_codes: string[] | null;
  proposed_scope: { type: string; ref: string | null };
  memory_type: string;
  content_ref: string | null;
  content_hash: string;
  sensitivity_class: string;
  proposed_at: string;
  resolved_at: string | null;
} {
  return {
    candidate_id: candidate.id,
    invocation_id: candidate.invocationId,
    candidate_state: candidate.candidateState,
    memory_entry_id: candidate.resolvedMemoryEntryId,
    decision_reason_codes: candidate.decisionReasonCodesJson,
    proposed_scope: {
      type: candidate.proposedScopeType,
      ref: candidate.proposedScopeRef,
    },
    memory_type: candidate.memoryType,
    // rejected candidate 的 contentRef 已在写入时销毁（null），此处直接投影。
    content_ref: candidate.contentRef,
    content_hash: candidate.contentHash,
    sensitivity_class: candidate.sensitivityClass,
    proposed_at: candidate.proposedAt.toISOString(),
    resolved_at: candidate.resolvedAt ? candidate.resolvedAt.toISOString() : null,
  };
}

/** GET /gateway/v1/memory-candidates/{candidate_id} handler。 */
export async function memoryCandidateGET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  // 1. 解析 Gateway 身份
  let principal: GatewayPrincipal;
  try {
    principal = await resolveGatewayPrincipal(request.headers);
  } catch (error) {
    const authResponse = gatewayAuthErrorResponse(error, requestId);
    return authResponse ?? resourceNotFound(requestId, "身份解析失败");
  }

  // 2. 提取 candidate_id
  const candidateId = extractCandidateId(request.url);
  if (!candidateId) {
    return resourceNotFound(requestId, "candidate_id 缺失");
  }

  // 3. 按 (tenantId, candidateId, invocationId) 查询
  const candidate = await getMemoryCandidateByIdAndInvocation(
    principal.tenantId,
    candidateId,
    principal.invocationId,
  );

  if (!candidate) {
    // 不存在 / 跨租户 / 跨 Invocation → 隐藏式 404
    return resourceNotFound(requestId, "Memory Candidate 不存在或无权访问");
  }

  // 4. 返回 200 + 投影
  const responseBody = projectCandidate(candidate);
  return apiSuccess(responseBody, {
    status: 200,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
