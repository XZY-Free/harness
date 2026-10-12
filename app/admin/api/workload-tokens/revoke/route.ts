import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
/**
 * POST /admin/api/workload-tokens/revoke — 撤销 Workload Token（S12-W05）。
 *
 * 事实源：docs/architecture/security.md §5
 *         （Workload Token 撤销机制：jti + WorkloadTokenRevocation 表）。
 *
 * 行为：
 * - 解析 admin 主体（安全管理员）。
 * - 校验 action scope: workload.token.revoke + resource { type: "invocation", id: jti }。
 *   （jti 关联到 Invocation；按 Invocation 维度授权）
 * - 必填字段：jti / token_type / reason。
 * - 调用 revokeWorkloadToken：写撤销表 + 审计（workload.token.revoked）。
 * - 撤销后 resolveRuntimePrincipal / resolveGatewayPrincipal 调用 isTokenRevoked，
 *   命中则抛 WorkloadTokenError(token_revoked) → 401 AUTHENTICATION_REQUIRED。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 * - 缺少必填字段 → 400 REQUEST_SCHEMA_INVALID
 * - 幂等：重复撤销返回原记录（不报错）
 */
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/identity/audit";
import { revokeWorkloadToken } from "@/lib/identity/workload-token-revocation-queries";

export const dynamic = "force-dynamic";

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

export async function POST(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 解析请求体
  const body = (await request.json().catch(() => null)) as {
    jti?: string;
    invocation_id?: string;
    reason_code?: string;
    token_expires_at?: string;
  } | null;

  const jti = body?.jti?.trim();
  if (!jti) {
    return schemaInvalidTable(requestId, "缺少必填字段 jti");
  }

  const invocationId = body?.invocation_id?.trim();
  if (!invocationId) {
    return schemaInvalidTable(requestId, "缺少必填字段 invocation_id");
  }

  const reasonCode = body?.reason_code?.trim();
  if (!reasonCode) {
    return schemaInvalidTable(requestId, "缺少必填字段 reason_code");
  }

  // token_expires_at 必须使用原 Token 的过期时间，避免撤销记录无限期保留。
  let tokenExpiresAt: Date;
  if (body?.token_expires_at) {
    const parsed = new Date(body.token_expires_at);
    if (Number.isNaN(parsed.getTime())) {
      return schemaInvalidTable(requestId, "token_expires_at 非合法 RFC 3339 时间");
    }
    tokenExpiresAt = parsed;
  } else {
    return schemaInvalidTable(requestId, "缺少必填字段 token_expires_at");
  }

  // action scope 校验：按 invocation 维度授权（jti 关联 Invocation）
  const scopeResult = await requireAdminActionScope(
    principal,
    "workload.token.revoke",
    { type: "invocation", id: invocationId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 执行撤销（幂等：已撤销返回原记录）
  const revoked = await revokeWorkloadToken({
    tenantId: principal.tenantId,
    invocationId,
    jti,
    revokedBy:
      "userIdentityId" in principal ? principal.userIdentityId : (principal.serviceId ?? "unknown"),
    reasonCode,
    tokenExpiresAt,
    actor: actorFromAdminPrincipal(principal),
    requestId,
  });

  return apiSuccess(
    {
      id: revoked.id,
      jti: revoked.jti,
      invocation_id: revoked.invocationId,
      revoked_by: revoked.revokedBy,
      reason_code: revoked.reasonCode,
      token_expires_at: revoked.tokenExpiresAt.toISOString(),
      revoked_at: revoked.revokedAt.toISOString(),
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
