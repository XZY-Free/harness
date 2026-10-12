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
import { type DbOrTx, db } from "@/lib/db/client";
import { type AuditActor, recordAuditEvent } from "@/lib/identity/audit";
import { invocationTable } from "@/lib/persistence/schema/executions";
import {
  type WorkloadTokenRevocation,
  workloadTokenRevocationTable,
} from "@/lib/persistence/schema/workload-token-revocation";
import { and, eq, lt } from "drizzle-orm";

/** 撤销记录不存在时返回 null；存在时返回记录。 */
export async function getRevocationByJti(
  tenantId: string,
  jti: string,
  executor: DbOrTx = db,
): Promise<WorkloadTokenRevocation | null> {
  const [row] = await executor
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
export async function isTokenRevoked(
  tenantId: string,
  jti: string,
  executor: DbOrTx = db,
): Promise<boolean> {
  const record = await getRevocationByJti(tenantId, jti, executor);
  return record !== null;
}

export interface RevokeWorkloadTokenParams {
  tenantId: string;
  jti: string;
  invocationId: string;
  revokedBy: string;
  reasonCode: string;
  tokenExpiresAt: Date;
  actor: AuditActor;
  requestId?: string;
}

/** 撤销写入与 Event Ingress 共用 Invocation 根锁；调用方负责提交事务。 */
export async function revokeWorkloadTokenInTransaction(
  tx: DbOrTx,
  params: RevokeWorkloadTokenParams,
): Promise<{ row: WorkloadTokenRevocation; created: boolean }> {
  // 与 Runtime Event Ingress 使用同一 Invocation 根锁，确定撤销与接纳的提交顺序。
  // 历史 Token 可指向已删除的 Invocation；此时没有 Event 可接纳，仍允许撤销 JTI。
  await tx
    .select({ id: invocationTable.id })
    .from(invocationTable)
    .where(
      and(
        eq(invocationTable.tenantId, params.tenantId),
        eq(invocationTable.id, params.invocationId),
      ),
    )
    .for("update")
    .limit(1);
  const existing = await getRevocationByJti(params.tenantId, params.jti, tx);
  if (existing) return { row: existing, created: false };

  const id = randomUUID();
  await tx.insert(workloadTokenRevocationTable).values({
    id,
    tenantId: params.tenantId,
    jti: params.jti,
    invocationId: params.invocationId,
    revokedBy: params.revokedBy,
    reasonCode: params.reasonCode,
    revokedAt: new Date(),
    tokenExpiresAt: params.tokenExpiresAt,
  });
  const [inserted] = await tx
    .select()
    .from(workloadTokenRevocationTable)
    .where(eq(workloadTokenRevocationTable.id, id))
    .limit(1);
  if (!inserted) throw new Error(`revokeWorkloadToken: 行未找到（id=${id}）`);
  return { row: inserted, created: true };
}

/** 撤销 Token（幂等：已撤销返回原记录）。 */
export async function revokeWorkloadToken(
  params: RevokeWorkloadTokenParams,
): Promise<WorkloadTokenRevocation> {
  const { row, created } = await db.transaction((tx) =>
    revokeWorkloadTokenInTransaction(tx, params),
  );
  if (!created) return row;

  // 写审计
  await recordAuditEvent({
    actor: params.actor,
    actionType: "workload.token.revoked",
    targetType: "workload_token",
    targetId: params.jti,
    after: {
      jti: params.jti,
      invocation_id: params.invocationId,
      revoked_by: params.revokedBy,
      reason_code: params.reasonCode,
      token_expires_at: params.tokenExpiresAt.toISOString(),
    },
    reason: params.reasonCode,
    requestId: params.requestId,
  });

  return row;
}

/** 清理过期撤销记录（tokenExpiresAt < now）。返回删除行数。 */
export async function deleteExpiredRevocations(now: Date = new Date()): Promise<number> {
  const result = await db
    .delete(workloadTokenRevocationTable)
    .where(lt(workloadTokenRevocationTable.tokenExpiresAt, now));
  // MySQL 返回 affected rows
  return (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
}
