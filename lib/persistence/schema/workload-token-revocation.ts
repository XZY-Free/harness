/**
 * schema：Workload Token 撤销表（S12-W05）。
 *
 * 事实源：docs/architecture/security.md §5、
 * docs/architecture/api-and-events.md 。
 *
 * 用途：记录已撤销的 Workload Token jti。route handler 在身份解析时查询此表，
 * 命中则拒绝（401 AUTHENTICATION_REQUIRED）。
 *
 * 语义：
 * - jti 在 Token 颁发时生成（randomUUID），decodeWorkloadToken 校验 jti 必填。
 * - 撤销是幂等的：重复撤销同一 jti 返回原记录。
 * - 过期的撤销记录可由清理任务删除（expiresAt < now）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const workloadTokenRevocationTable = mysqlTable(
  "WorkloadTokenRevocation",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** Token jti（UUID），撤销后所有使用此 jti 的 Token 立即失效。 */
    jti: varchar("jti", { length: 64 }).notNull(),
    /** Token 类型（runtime/gateway/service），用于审计与过滤。 */
    tokenType: varchar("tokenType", { length: 16 }).notNull(),
    /** 撤销操作者（userIdentityId / serviceId / admin）。 */
    revokedBy: varchar("revokedBy", { length: 128 }).notNull(),
    /** 撤销原因。 */
    reason: text("reason").notNull(),
    /** Token 原始过期时间；过期的撤销记录可由清理任务删除。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }).notNull(),
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantJtiUq: uniqueIndex("WorkloadTokenRevocation_tenant_jti_uq").on(t.tenantId, t.jti),
    tenantRevokedIdx: index("WorkloadTokenRevocation_tenant_revoked_idx").on(
      t.tenantId,
      t.revokedAt,
    ),
    expiresIdx: index("WorkloadTokenRevocation_expires_idx").on(t.expiresAt),
  }),
);

export type WorkloadTokenRevocation = InferSelectModel<typeof workloadTokenRevocationTable>;
export type NewWorkloadTokenRevocation = InferInsertModel<typeof workloadTokenRevocationTable>;
