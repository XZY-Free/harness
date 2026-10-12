/** Workload credential revocation; this table does not grant execution authority. */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { datetime, index, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

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
    jti: varchar("jti", { length: 36 }).notNull(),
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    reasonCode: varchar("reasonCode", { length: 64 }).notNull(),
    revokedBy: varchar("revokedBy", { length: 128 }).notNull(),
    revokedAt: datetime("revokedAt", { mode: "date", fsp: 6 }).notNull(),
    tokenExpiresAt: datetime("tokenExpiresAt", { mode: "date", fsp: 6 }).notNull(),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("WorkloadTokenRevocation_tenant_id_uq").on(t.tenantId, t.id),
    jtiUq: uniqueIndex("WorkloadTokenRevocation_tenant_jti_uq").on(t.tenantId, t.jti),
    invocationIdx: index("WorkloadTokenRevocation_tenant_invocation_idx").on(
      t.tenantId,
      t.invocationId,
    ),
    expiryIdx: index("WorkloadTokenRevocation_expiry_idx").on(t.tokenExpiresAt),
  }),
);

export type WorkloadTokenRevocation = InferSelectModel<typeof workloadTokenRevocationTable>;
export type NewWorkloadTokenRevocation = InferInsertModel<typeof workloadTokenRevocationTable>;
