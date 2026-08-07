/**
 * GET /admin/api/v1/workload-tokens:revoked — 查询已撤销的 Workload Token 列表（S12-W05）。
 *
 * 事实源：../v11-agentkit-platform/14-production-operations-security-and-retention.md §5。
 *
 * 行为：
 * - 解析 admin 主体（安全管理员）。
 * - 校验 action scope: workload.token.revoke + resource { type: "tenant", id: tenantId }。
 * - 支持 query 参数：limit / token_type / cursor（按 revokedAt 降序分页）。
 *
 * 错误映射：
 * - 缺少身份 → 401 AUTHENTICATION_REQUIRED
 * - 缺少 action scope → 403 ACTION_SCOPE_DENIED
 */
import { db } from "@/lib/db/client";
import { REQUEST_ID_HEADER, apiSuccess, getRequestId } from "@/lib/http";
import { workloadTokenRevocationTable } from "@/lib/persistence/schema/workload-token-revocation";
import {
  type AdminPrincipal,
  adminAuthErrorResponse,
  requireAdminActionScope,
  resolveAdminPrincipalAsync,
  schemaInvalidTable,
} from "@/lib/admin/route-helpers";
import { and, desc, eq, lt } from "drizzle-orm";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const VALID_TOKEN_TYPES = new Set(["runtime", "gateway", "service"]);

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

  // action scope 校验：按 tenant 维度授权
  const scopeResult = await requireAdminActionScope(
    principal,
    "workload.token.revoke",
    { type: "tenant", id: principal.tenantId },
    requestId,
  );
  if (!scopeResult.ok) return scopeResult.response;

  // 解析 query 参数
  const url = new URL(request.url);
  const limitStr = url.searchParams.get("limit");
  const limit = limitStr ? Number.parseInt(limitStr, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0 || limit > MAX_LIMIT) {
    return schemaInvalidTable(requestId, `limit 必须为 1-${MAX_LIMIT} 之间的整数`);
  }

  const tokenType = url.searchParams.get("token_type");
  if (tokenType && !VALID_TOKEN_TYPES.has(tokenType)) {
    return schemaInvalidTable(requestId, "token_type 必须为 runtime/gateway/service");
  }

  const cursorRevokedAt = url.searchParams.get("cursor");
  let cursorDate: Date | null = null;
  if (cursorRevokedAt) {
    cursorDate = new Date(cursorRevokedAt);
    if (Number.isNaN(cursorDate.getTime())) {
      return schemaInvalidTable(requestId, "cursor 非合法 RFC 3339 时间");
    }
  }

  // 构造查询条件（drizzle and() 组合多条件 WHERE）
  const conditions = [eq(workloadTokenRevocationTable.tenantId, principal.tenantId)];
  if (tokenType) {
    conditions.push(eq(workloadTokenRevocationTable.tokenType, tokenType));
  }
  if (cursorDate) {
    conditions.push(lt(workloadTokenRevocationTable.revokedAt, cursorDate));
  }

  const rows = await db
    .select({
      id: workloadTokenRevocationTable.id,
      jti: workloadTokenRevocationTable.jti,
      token_type: workloadTokenRevocationTable.tokenType,
      revoked_by: workloadTokenRevocationTable.revokedBy,
      reason: workloadTokenRevocationTable.reason,
      expires_at: workloadTokenRevocationTable.expiresAt,
      revoked_at: workloadTokenRevocationTable.revokedAt,
    })
    .from(workloadTokenRevocationTable)
    .where(and(...conditions))
    .orderBy(desc(workloadTokenRevocationTable.revokedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];
  const nextCursor = hasMore && lastRow ? lastRow.revoked_at.toISOString() : null;

  return apiSuccess(
    {
      items: page.map((row) => ({
        id: row.id,
        jti: row.jti,
        token_type: row.token_type,
        revoked_by: row.revoked_by,
        reason: row.reason,
        expires_at: row.expires_at.toISOString(),
        revoked_at: row.revoked_at.toISOString(),
      })),
      next_cursor: nextCursor,
    },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
