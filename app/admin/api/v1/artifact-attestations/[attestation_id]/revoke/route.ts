import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { projectArtifactAttestation } from "@/lib/artifacts/application/artifact-admin-projection";
import {
  AttestationAlreadyRevokedError,
  AttestationNotFoundError,
} from "@/lib/artifacts/application/revoke-artifact-attestation";
import { getAttestationById } from "@/lib/artifacts/persistence/artifact-attestation-reader";
import { revokeAttestation } from "@/lib/artifacts/persistence/artifact-attestation-writer";
/**
 * POST /admin/api/v1/artifact-attestations/{attestation_id}/revoke — 撤销制品证明（S12-W04）。
 *
 * 事实源：docs/architecture/security.md §4.1
 *         （撤销签名后阻止新 Invocation；已开始 Invocation 保留原绑定并由安全策略决定 cancel 或继续）。
 *
 * 行为：
 * - 解析 admin 主体（安全管理员）。
 * - 校验 action scope: artifact.attestation.revoke + resource { type: "artifact_type", id: artifact_type }。
 *   先查 attestation 获取 artifact_type，再校验 scope。
 * - 必填 reason（撤销原因）。
 * - 调用 revokeAttestation：追加独立撤销事实，并写审计与 Outbox。
 * - 撤销后 getVerifiedAttestationForRevision 不再返回此 attestation；
 *   assertAttestationGate 拒绝已撤销 attestation；新 Invocation/发布/路由被阻止。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 不存在或跨租户 → 404 NOT_FOUND
 * - 已撤销 → 409 ATTESTATION_ALREADY_REVOKED
 * - 缺少 reason → 400 REQUEST_SCHEMA_INVALID
 */
import {
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

export const dynamic = "force-dynamic";

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(
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

  // 先查 attestation 获取 artifact_type（用于 scope 校验）
  const existing = await getAttestationById(principal.tenantId, attestationId);
  if (!existing) {
    return resourceNotFound(requestId, `attestation 不存在或跨租户: ${attestationId}`);
  }

  // action scope 校验
  const scopeResult = await requireAdminActionScope(
    principal,
    "artifact.attestation.revoke",
    { type: "artifact_type", id: existing.attestation.artifactType },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析请求体
  const body = (await request.json().catch(() => null)) as { reason?: string } | null;
  const reason = body?.reason?.trim();
  if (!reason) {
    return schemaInvalidTable(requestId, "缺少必填字段 reason");
  }

  // 执行撤销
  try {
    const updated = await revokeAttestation(
      principal.tenantId,
      attestationId,
      actorFromAdminPrincipal(principal),
      reason,
      requestId,
    );

    return apiSuccess(projectArtifactAttestation(updated), {
      headers: { [REQUEST_ID_HEADER]: requestId },
    });
  } catch (err) {
    if (err instanceof AttestationNotFoundError) {
      return resourceNotFound(requestId, err.message);
    }
    if (err instanceof AttestationAlreadyRevokedError) {
      return apiError("ATTESTATION_ALREADY_REVOKED", err.message, { requestId });
    }
    throw err;
  }
}
