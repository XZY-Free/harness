import {
  AttestationAlreadyRevokedError,
  AttestationNotFoundError,
  getAttestationById,
  revokeAttestation,
} from "@/lib/artifacts/persistence/artifact-attestation-queries";
/**
 * POST /admin/api/v1/artifact-attestations/{attestation_id}:revoke — 撤销制品证明（S12-W04）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1
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
import { REQUEST_ID_HEADER, getRequestId, v11Error, v11NotFound, v11Ok } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";

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
    return v11NotFound(requestId, `attestation 不存在或跨租户: ${attestationId}`);
  }

  // action scope 校验
  const scopeResult = await requireAdminActionScope(
    principal,
    "artifact.attestation.revoke",
    { type: "artifact_type", id: existing.artifactType },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析请求体
  const body = (await request.json().catch(() => null)) as { reason?: string } | null;
  const reason = body?.reason?.trim();
  if (!reason) {
    return v11SchemaInvalid(requestId, "缺少必填字段 reason");
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

    return v11Ok(
      {
        id: updated.id,
        artifact_type: updated.artifactType,
        artifact_revision_id: updated.artifactRevisionId,
        artifact_digest: updated.artifactDigest,
        verification_state: updated.verificationState,
        revoked_at: updated.revokedAt?.toISOString() ?? null,
        revoked_by: updated.revokedBy,
        revocation_reason: updated.revocationReason,
      },
      { headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  } catch (err) {
    if (err instanceof AttestationNotFoundError) {
      return v11NotFound(requestId, err.message);
    }
    if (err instanceof AttestationAlreadyRevokedError) {
      return v11Error("ATTESTATION_ALREADY_REVOKED", err.message, { requestId });
    }
    throw err;
  }
}
