/** Physical workspace writer fencing state. */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { workspaceBinding } from "@/lib/persistence/schema/workspace";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  foreignKey,
  index,
  json,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const WORKSPACE_WRITE_LOCK_STATES = [
  "released",
  "reserved",
  "active",
  "releasing",
  "quarantined",
] as const;
export type WorkspaceWriteLockState = (typeof WORKSPACE_WRITE_LOCK_STATES)[number];

export const workspaceWriteLock = mysqlTable(
  "WorkspaceWriteLock",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    storageScopeDigest: varchar("storageScopeDigest", { length: 71 }).notNull(),
    writerGeneration: bigint("writerGeneration", { mode: "number", unsigned: true })
      .notNull()
      .default(0),
    lockState: varchar("lockState", { length: 32 })
      .$type<WorkspaceWriteLockState>()
      .notNull()
      .default("released"),
    holderInvocationId: varchar("holderInvocationId", { length: 36 }),
    holderAttemptId: varchar("holderAttemptId", { length: 36 }),
    holderOwnershipId: varchar("holderOwnershipId", { length: 36 }),
    workspaceBindingId: varchar("workspaceBindingId", { length: 36 }),
    backendGrantRef: varchar("backendGrantRef", { length: 512 }),
    backendEvidence: json("backendEvidence"),
    /**
     * 稳定 Backend operationId：同一逻辑激活重试必须复用同一个 operation，
     * DB 确认失败时靠它查回已存在的回执，而不是再杀一次或新建一个 generation。
     */
    backendOperationId: varchar("backendOperationId", { length: 255 }),
    /** Backend 实际回执（含真实旧 Writer 停止/排空证据）。 */
    backendReceipt: json("backendReceipt"),
    leaseExpiresAt: datetime("leaseExpiresAt", { mode: "date", fsp: 6 }),
    releaseReasonCode: varchar("releaseReasonCode", { length: 64 }),
    versionNo: bigint("versionNo", { mode: "number", unsigned: true }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 6 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 6 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(6)`),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("WorkspaceWriteLock_tenant_id_uq").on(t.tenantId, t.id),
    scopeUq: uniqueIndex("WorkspaceWriteLock_tenant_scope_uq").on(t.tenantId, t.storageScopeDigest),
    holderIdx: index("WorkspaceWriteLock_tenant_holder_idx").on(t.tenantId, t.holderInvocationId),
    stateIdx: index("WorkspaceWriteLock_state_expiry_idx").on(t.lockState, t.leaseExpiresAt),
    stateAllowed: check(
      "WorkspaceWriteLock_state_allowed",
      sql`\`lockState\` IN ('released', 'reserved', 'active', 'releasing', 'quarantined')`,
    ),
    generationNonNegative: check(
      "WorkspaceWriteLock_generation_non_negative",
      sql`\`writerGeneration\` >= 0`,
    ),
    bindingFk: foreignKey({
      name: "WorkspaceWriteLock_tenant_binding_fk",
      columns: [t.tenantId, t.workspaceBindingId],
      foreignColumns: [workspaceBinding.tenantId, workspaceBinding.id],
    }),
    releasedShape: check(
      "WorkspaceWriteLock_released_shape",
      sql`\`lockState\` <> 'released' OR (\`holderInvocationId\` IS NULL AND \`holderAttemptId\` IS NULL AND \`holderOwnershipId\` IS NULL AND \`workspaceBindingId\` IS NULL AND \`backendGrantRef\` IS NULL AND \`backendEvidence\` IS NULL AND \`backendOperationId\` IS NULL AND \`backendReceipt\` IS NULL AND \`leaseExpiresAt\` IS NULL)`,
    ),
    activeEvidenceShape: check(
      "WorkspaceWriteLock_active_evidence_shape",
      sql`\`lockState\` <> 'active' OR (\`holderInvocationId\` IS NOT NULL AND \`holderAttemptId\` IS NOT NULL AND \`holderOwnershipId\` IS NOT NULL AND \`workspaceBindingId\` IS NOT NULL AND \`backendGrantRef\` IS NOT NULL AND \`backendEvidence\` IS NOT NULL AND JSON_UNQUOTE(JSON_EXTRACT(\`backendEvidence\`, '$.scopeDigest')) = \`storageScopeDigest\` AND JSON_EXTRACT(\`backendEvidence\`, '$.writerGeneration') IS NOT NULL)`,
    ),
  }),
);

export type WorkspaceWriteLock = InferSelectModel<typeof workspaceWriteLock>;
export type WorkspaceWriteLockInsert = InferInsertModel<typeof workspaceWriteLock>;
