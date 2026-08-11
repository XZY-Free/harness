import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { projectArtifactAttestation } from "@/lib/artifacts/application/artifact-admin-projection";
import { listAttestations } from "@/lib/artifacts/persistence/artifact-attestation-reader";
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
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { ARTIFACT_TYPES, VERIFICATION_STATES } from "@/lib/persistence/schema/artifact";

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
      return schemaInvalidTable(requestId, `artifact_type 非法: ${artifactTypeParam}`);
    }
    artifactType = artifactTypeParam;
  }

  let verificationState: "verified" | "failed" | undefined;
  if (verificationStateParam) {
    if (!VALID_VERIFICATION_STATES.has(verificationStateParam)) {
      return schemaInvalidTable(requestId, `verification_state 非法: ${verificationStateParam}`);
    }
    verificationState = verificationStateParam as "verified" | "failed";
  }

  let revoked: boolean | undefined;
  if (revokedParam !== null) {
    if (revokedParam !== "true" && revokedParam !== "false") {
      return schemaInvalidTable(requestId, `revoked 必须为 true/false: ${revokedParam}`);
    }
    revoked = revokedParam === "true";
  }

  const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
  if (!Number.isFinite(limit) || limit <= 0) {
    return schemaInvalidTable(requestId, "limit 必须是正整数");
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

  const projected = items.map(projectArtifactAttestation);

  return apiSuccess(
    {
      items: projected,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
      total: projected.length,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
