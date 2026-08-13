/**
 * Workload Token 撤销仓储（S12-W05）。
 *
 * 事实源：docs/architecture/security.md §5、
 * docs/architecture/api-and-events.md 。
 *
 * 职责：
 * - revokeWorkloadToken：撤销 Token（写撤销表 + 审计）；幂等保护。
 * - isTokenRevoked：查询 jti 是否已撤销（route handler 身份解析时调用）。
 * - deleteExpiredRevocations：清理过期撤销记录（expiresAt < now）。
 *
 * 撤销后：
 * - resolveRuntimePrincipal / resolveGatewayPrincipal 调用 isTokenRevoked，
 * 命中则抛 WorkloadTokenError(token_revoked) → 401 AUTHENTICATION_REQUIRED。
 * - 新请求立即拒绝；进行中 Invocation 由安全策略决定 cancel 或继续。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import {
 type WorkloadTokenRevocation,
 workloadTokenRevocationTable,
} from "@/lib/persistence/schema/workload-token-revocation";
import { and, eq, lt } from "drizzle-orm";

/** 撤销记录不存在时返回 null；存在时返回记录。 */
export async function getRevocationByJti(
 tenantId: string,
 jti: string,
): Promise<WorkloadTokenRevocation | null> {
 const [row] = await db
 .select()
 .from(workloadTokenRevocationTable)
 .where(
 and(
 eq(workloadTokenRevocationTable.tenantId, tenantId),
 eq(workloadTokenRevocationTable.jti, jti),
 ),
 )
 .limit(1);
 return row ?? null;
}

/** 查询 jti 是否已撤销。 */
export async function isTokenRevoked(tenantId: string, jti: string): Promise<boolean> {
 const record = await getRevocationByJti(tenantId, jti);
 return record !== null;
}

/** 撤销 Token（幂等：已撤销返回原记录）。 */
export async function revokeWorkloadToken(params: {
 tenantId: string;
 jti: string;
 tokenType: "runtime" | "gateway" | "service";
 revokedBy: string;
 reason: string;
 expiresAt: Date;
 actor: AuditActor;
 requestId?: string;
}): Promise<WorkloadTokenRevocation> {
 // 幂等保护：已撤销返回原记录
 const existing = await getRevocationByJti(params.tenantId, params.jti);
 if (existing) {
 return existing;
 }

 const id = randomUUID();
 await db.insert(workloadTokenRevocationTable).values({
 id,
 tenantId: params.tenantId,
 jti: params.jti,
 tokenType: params.tokenType,
 revokedBy: params.revokedBy,
 reason: params.reason,
 expiresAt: params.expiresAt,
 });

 const [row] = await db
 .select()
 .from(workloadTokenRevocationTable)
 .where(eq(workloadTokenRevocationTable.id, id))
 .limit(1);
 if (!row) {
 throw new Error(`revokeWorkloadToken: 行未找到（id=${id}）`);
 }

 // 写审计
 await recordAuditEvent({
 actor: params.actor,
 actionType: "workload.token.revoked",
 targetType: "workload_token",
 targetId: params.jti,
 after: {
 jti: params.jti,
 token_type: params.tokenType,
 revoked_by: params.revokedBy,
 reason: params.reason,
 expires_at: params.expiresAt.toISOString(),
 },
 reason: params.reason,
 requestId: params.requestId,
 });

 return row;
}

/** 清理过期撤销记录（expiresAt < now）。返回删除行数。 */
export async function deleteExpiredRevocations(now: Date = new Date()): Promise<number> {
 const result = await db
 .delete(workloadTokenRevocationTable)
 .where(lt(workloadTokenRevocationTable.expiresAt, now));
 // MySQL 返回 affected rows
 return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}
