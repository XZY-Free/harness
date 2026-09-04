import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import {
  connectionTable,
  credentialRefTable,
  toolProviderTable,
} from "@/lib/persistence/schema/tool";
import { toolCallTable } from "@/lib/persistence/schema/tool-call";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const TOOL_EXECUTION_ATTEMPT_STATES = [
  "claimed",
  "dispatched",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type ToolExecutionAttemptState = (typeof TOOL_EXECUTION_ATTEMPT_STATES)[number];

export const toolExecutionBindingTable = mysqlTable(
  "ToolExecutionBinding",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    toolCallId: varchar("toolCallId", { length: 36 })
      .notNull()
      .references(() => toolCallTable.id),
    toolProviderId: varchar("toolProviderId", { length: 36 })
      .notNull()
      .references(() => toolProviderTable.id),
    providerType: varchar("providerType", { length: 32 }).notNull(),
    connectionId: varchar("connectionId", { length: 36 }).references(() => connectionTable.id),
    authMethod: varchar("authMethod", { length: 32 }).notNull(),
    endpointRef: varchar("endpointRef", { length: 512 }),
    endpointFingerprint: varchar("endpointFingerprint", { length: 71 }),
    credentialRefId: varchar("credentialRefId", { length: 36 }).references(
      () => credentialRefTable.id,
    ),
    executorKind: varchar("executorKind", { length: 64 }).notNull(),
    executionContractDigest: varchar("executionContractDigest", { length: 71 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    toolCallUq: uniqueIndex("ToolExecutionBinding_toolCall_uq").on(table.toolCallId),
    tenantProviderIdx: index("ToolExecutionBinding_tenant_provider_idx").on(
      table.tenantId,
      table.toolProviderId,
    ),
  }),
);

export const toolExecutionAttemptTable = mysqlTable(
  "ToolExecutionAttempt",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    toolCallId: varchar("toolCallId", { length: 36 })
      .notNull()
      .references(() => toolCallTable.id),
    attemptNo: int("attemptNo").notNull(),
    attemptState: mysqlEnum("attemptState", TOOL_EXECUTION_ATTEMPT_STATES).notNull(),
    requestDigest: varchar("requestDigest", { length: 71 }).notNull(),
    externalIdempotencyKey: varchar("externalIdempotencyKey", { length: 128 }),
    providerRequestRef: varchar("providerRequestRef", { length: 512 }),
    retryClass: varchar("retryClass", { length: 32 }).notNull(),
    claimedBy: varchar("claimedBy", { length: 128 }).notNull(),
    claimExpiresAt: datetime("claimExpiresAt", { mode: "date", fsp: 3 }).notNull(),
    startedAt: datetime("startedAt", { mode: "date", fsp: 3 }).notNull(),
    finishedAt: datetime("finishedAt", { mode: "date", fsp: 3 }),
    errorCode: varchar("errorCode", { length: 128 }),
    errorSummary: text("errorSummary"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    toolCallAttemptUq: uniqueIndex("ToolExecutionAttempt_toolCall_attemptNo_uq").on(
      table.toolCallId,
      table.attemptNo,
    ),
    tenantStateLeaseIdx: index("ToolExecutionAttempt_tenant_state_lease_idx").on(
      table.tenantId,
      table.attemptState,
      table.claimExpiresAt,
    ),
  }),
);

export type ToolExecutionBinding = InferSelectModel<typeof toolExecutionBindingTable>;
export type NewToolExecutionBinding = InferInsertModel<typeof toolExecutionBindingTable>;
export type ToolExecutionAttempt = InferSelectModel<typeof toolExecutionAttemptTable>;
export type NewToolExecutionAttempt = InferInsertModel<typeof toolExecutionAttemptTable>;
