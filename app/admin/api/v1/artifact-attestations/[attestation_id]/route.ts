import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { projectArtifactAttestation } from "@/lib/artifacts/application/artifact-admin-projection";
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

  const projected = projectArtifactAttestation(attestation);

  return apiSuccess(projected, {
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
