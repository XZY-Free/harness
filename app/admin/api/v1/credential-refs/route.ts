/**
 * GET /admin/api/v1/credential-refs — 列出租户 CredentialRef 摘要（07 §7）。
 *
 * 用途：Studio External Runtime 登记面板 bearer 模式只能从已有 CredentialRef 中选择。
 * 只读、无 secret：返回 id/provider/fingerprint/lifecycle_state/expires_at；
 * 不返回 vaultRef、凭据值或 scope 明细。
 *
 * 错误映射：缺少身份 → 401 AUTHENTICATION_REQUIRED。
 */
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  resolveAdminPrincipalAsync,
} from "@/lib/admin/route-helpers";
import { db } from "@/lib/db/client";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { credentialRefTable } from "@/lib/persistence/schema/tool";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const requestId = getRequestId(request);

  let principal: AdminPrincipal;
  try {
    principal = await resolveAdminPrincipalAsync(request.headers);
  } catch (err) {
    const authResp = adminAuthErrorResponse(err, requestId);
    return authResp ?? apiSuccess({ items: [], total: 0 });
  }

  const rows = await db
    .select({
      id: credentialRefTable.id,
      provider: credentialRefTable.provider,
      fingerprint: credentialRefTable.fingerprint,
      lifecycle_state: credentialRefTable.lifecycleState,
      expires_at: credentialRefTable.expiresAt,
    })
    .from(credentialRefTable)
    .where(eq(credentialRefTable.tenantId, principal.tenantId));

  const items = rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    fingerprint: row.fingerprint,
    lifecycle_state: row.lifecycle_state,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  }));

  return apiSuccess(
    { items, total: items.length },
    {
      headers: { [REQUEST_ID_HEADER]: requestId },
    },
  );
}
