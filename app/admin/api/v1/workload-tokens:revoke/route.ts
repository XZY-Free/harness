/**
 * POST /admin/api/v1/workload-tokens:revoke — 撤销 Workload Token（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5
 *         （Workload Token 撤销机制：jti + V11WorkloadTokenRevocation 表）。
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
import { REQUEST_ID_HEADER, getRequestId, v11Ok } from "@/lib/http";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  v11SchemaInvalid,
} from "@/lib/v11/admin/route-helpers";
import {
  type AuditActor,
  actorFromPrincipal,
  actorFromWorkloadPrincipal,
} from "@/lib/v11/identity/audit";
import { revokeWorkloadToken } from "@/lib/v11/identity/workload-token-revocation-queries";

export const dynamic = "force-dynamic";

function actorFromAdminPrincipal(principal: AdminPrincipal): AuditActor {
  if ("userIdentityId" in principal) {
    return actorFromPrincipal(principal);
  }
  return actorFromWorkloadPrincipal(principal);
}

const VALID_TOKEN_TYPES = new Set(["runtime", "gateway", "service"]);

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
    token_type?: string;
    reason?: string;
    expires_at?: string;
  } | null;

  const jti = body?.jti?.trim();
  if (!jti) {
    return v11SchemaInvalid(requestId, "缺少必填字段 jti");
  }

  const tokenType = body?.token_type?.trim();
  if (!tokenType || !VALID_TOKEN_TYPES.has(tokenType)) {
    return v11SchemaInvalid(requestId, "缺少或非法 token_type（期望 runtime/gateway/service）");
  }

  const reason = body?.reason?.trim();
  if (!reason) {
    return v11SchemaInvalid(requestId, "缺少必填字段 reason");
  }

  // expires_at 可选；缺省使用当前时间 + 1 小时（保证撤销记录有 TTL）
  let expiresAt: Date;
  if (body?.expires_at) {
    const parsed = new Date(body.expires_at);
    if (Number.isNaN(parsed.getTime())) {
      return v11SchemaInvalid(requestId, "expires_at 非合法 RFC 3339 时间");
    }
    expiresAt = parsed;
  } else {
    expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  }

  // action scope 校验：按 invocation 维度授权（jti 关联 Invocation）
  const scopeResult = await requireAdminActionScope(
    principal,
    "workload.token.revoke",
    { type: "invocation", id: jti },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 执行撤销（幂等：已撤销返回原记录）
  const revoked = await revokeWorkloadToken({
    tenantId: principal.tenantId,
    jti,
    tokenType: tokenType as "runtime" | "gateway" | "service",
    revokedBy:
      "userIdentityId" in principal ? principal.userIdentityId : (principal.serviceId ?? "unknown"),
    reason,
    expiresAt,
    actor: actorFromAdminPrincipal(principal),
    requestId,
  });

  return v11Ok(
    {
      id: revoked.id,
      jti: revoked.jti,
      token_type: revoked.tokenType,
      revoked_by: revoked.revokedBy,
      reason: revoked.reason,
      expires_at: revoked.expiresAt.toISOString(),
      revoked_at: revoked.revokedAt.toISOString(),
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
