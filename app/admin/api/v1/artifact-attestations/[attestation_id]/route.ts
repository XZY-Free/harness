import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
/**
 * GET /admin/api/v1/artifact-attestations/{attestation_id} — 按 id 查询制品证明（S12-W04）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W04。
 *
 * 行为：
 * - 解析 admin 主体。
 * - 校验 action scope: artifact.attestation.verify + resource { type: "artifact_type", id: artifact_type }。
 * - 跨租户隔离：不存在返回 404。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 不存在或跨租户 → 404 NOT_FOUND
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId, resourceNotFound } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/v11/admin/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attestation_id: string }> },
): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  const { attestation_id: attestationId } = await params;

  const attestation = await getAttestationById(principal.tenantId, attestationId);
  if (!attestation) {
    return resourceNotFound(requestId, `attestation 不存在或跨租户: ${attestationId}`);
  }

  // action scope 校验（按 attestation 的 artifact_type 资源校验）
  const scopeResult = await requireAdminActionScope(
    principal,
    "artifact.attestation.verify",
    { type: "artifact_type", id: attestation.artifactType },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const projected = {
    id: attestation.id,
    tenant_id: attestation.tenantId,
    artifact_type: attestation.artifactType,
    artifact_revision_id: attestation.artifactRevisionId,
    artifact_digest: attestation.artifactDigest,
    signature_bundle_ref: attestation.signatureBundleRef,
    sbom_ref: attestation.sbomRef,
    provenance_ref: attestation.provenanceRef,
    builder_identity: attestation.builderIdentity,
    verification_state: attestation.verificationState,
    policy_revision_id: attestation.policyRevisionId,
    source_revision: attestation.sourceRevision,
    build_pipeline: attestation.buildPipeline,
    dependency_lock_file_hash: attestation.dependencyLockFileHash,
    build_time: attestation.buildTime?.toISOString() ?? null,
    scan_summary: attestation.scanSummaryJson,
    failure_code: attestation.failureCode,
    verified_at: attestation.verifiedAt?.toISOString() ?? null,
    revoked_at: attestation.revokedAt?.toISOString() ?? null,
    revoked_by: attestation.revokedBy,
    revocation_reason: attestation.revocationReason,
    created_at: attestation.createdAt.toISOString(),
  };

  return apiSuccess(projected, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
