/**
 * GET /admin/api/v1/artifact-attestations — 列出租户内制品证明（S12-W04）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §4.1-4.2、
 *         ../v11-agentkit-platform-development-plan/12-production-operations-security-and-data-lifecycle.md S12-W04。
 *
 * 行为：
 * - 解析 admin 主体。
 * - 校验 action scope: artifact.attestation.verify + resource { type: "artifact_type", id: artifact_type }（按 artifact_type 过滤时）。
 *   未指定 artifact_type 时使用 artifact.attestation.revoke scope（安全管理员）或 admin.operations.read。
 * - 支持查询参数 artifact_type、artifact_revision_id、artifact_digest、verification_state、revoked、limit、cursor。
 * - cursor 为不透明 base64url(JSON{ created_at, id })。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 参数非法 → 400 REQUEST_SCHEMA_INVALID
 */
import { REQUEST_ID_HEADER, getRequestId, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import { listAttestations } from "@/lib/v11/control-plane/artifact-attestation-queries";
import { ARTIFACT_TYPES, VERIFICATION_STATES } from "@/lib/v11/schema/artifact";

export const dynamic = "force-dynamic";

const VALID_ARTIFACT_TYPES = new Set<string>(ARTIFACT_TYPES);
const VALID_VERIFICATION_STATES = new Set<string>(VERIFICATION_STATES);

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

  const url = new URL(request.url);
  const artifactTypeParam = url.searchParams.get("artifact_type");
  const artifactRevisionId = url.searchParams.get("artifact_revision_id");
  const artifactDigest = url.searchParams.get("artifact_digest");
  const verificationStateParam = url.searchParams.get("verification_state");
  const revokedParam = url.searchParams.get("revoked");
  const limitParam = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");

  let artifactType: string | undefined;
  if (artifactTypeParam) {
    if (!VALID_ARTIFACT_TYPES.has(artifactTypeParam)) {
      return v11SchemaInvalid(requestId, `artifact_type 非法: ${artifactTypeParam}`);
    }
    artifactType = artifactTypeParam;
  }

  let verificationState: "verified" | "failed" | undefined;
  if (verificationStateParam) {
    if (!VALID_VERIFICATION_STATES.has(verificationStateParam)) {
      return v11SchemaInvalid(requestId, `verification_state 非法: ${verificationStateParam}`);
    }
    verificationState = verificationStateParam as "verified" | "failed";
  }

  let revoked: boolean | undefined;
  if (revokedParam !== null) {
    if (revokedParam !== "true" && revokedParam !== "false") {
      return v11SchemaInvalid(requestId, `revoked 必须为 true/false: ${revokedParam}`);
    }
    revoked = revokedParam === "true";
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return v11SchemaInvalid(requestId, "limit 必须是正整数");
  }

  // action scope 校验（artifact_type 过滤时按 artifact_type 资源校验，否则按 tenant）
  const scopeResult = await requireAdminActionScope(
    principal,
    "artifact.attestation.verify",
    artifactType ? { type: "artifact_type", id: artifactType } : { type: "artifact_type", id: "*" },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  const { items, nextCursor } = await listAttestations(principal.tenantId, {
    artifactType,
    artifactRevisionId: artifactRevisionId ?? undefined,
    artifactDigest: artifactDigest ?? undefined,
    verificationState,
    revoked,
    limit,
    ...(cursor ? {} : {}),
  });

  const projected = items.map((a) => ({
    id: a.id,
    tenant_id: a.tenantId,
    artifact_type: a.artifactType,
    artifact_revision_id: a.artifactRevisionId,
    artifact_digest: a.artifactDigest,
    signature_bundle_ref: a.signatureBundleRef,
    sbom_ref: a.sbomRef,
    provenance_ref: a.provenanceRef,
    builder_identity: a.builderIdentity,
    verification_state: a.verificationState,
    policy_revision_id: a.policyRevisionId,
    source_revision: a.sourceRevision,
    build_pipeline: a.buildPipeline,
    dependency_lock_file_hash: a.dependencyLockFileHash,
    build_time: a.buildTime?.toISOString() ?? null,
    scan_summary: a.scanSummaryJson,
    failure_code: a.failureCode,
    verified_at: a.verifiedAt?.toISOString() ?? null,
    revoked_at: a.revokedAt?.toISOString() ?? null,
    revoked_by: a.revokedBy,
    revocation_reason: a.revocationReason,
    created_at: a.createdAt.toISOString(),
  }));

  return v11Ok(
    {
      items: projected,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: projected.length,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
