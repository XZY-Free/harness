/**
 * EnvironmentChangeRequest —— 仅对后续 Invocation 生效的环境选择请求。
 *
 * schema-design §5.2.20 的物理定义。独立成文件的原因：该表必须持有
 * `(tenantId, requestedRevisionId) → EnvironmentDefinitionRevision(tenantId, id)`
 * 的同租户复合外键，而 environment.ts 与 environment-definition-revision.ts 之间
 * 已存在单向导入（后者取 EnvironmentDefinition 建 FK）。把本表放在两表之外，
 * 避免用模块循环依赖去换一条数据库约束。
 */
import { randomUUID } from "node:crypto";
import { threadTable } from "@/lib/persistence/schema/conversation";
import { environmentDefinitionRevisionTable } from "@/lib/persistence/schema/environment-definition-revision";
import { invocationTable } from "@/lib/persistence/schema/executions";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  foreignKey,
  index,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

export const ENVIRONMENT_CHANGE_REQUEST_STATES = [
  "pending",
  "accepted_for_next_invocation",
  "applied",
  "rejected",
  "expired",
] as const;
export type EnvironmentChangeRequestState = (typeof ENVIRONMENT_CHANGE_REQUEST_STATES)[number];

const ascii = (name: string, length: number) => varchar(name, { length }).$type<string>();
const timestamp = (name: string) => datetime(name, { mode: "date", fsp: 6 });
const unsignedBigint = (name: string) => bigint(name, { mode: "number", unsigned: true });
const currentTimestamp = () => sql`CURRENT_TIMESTAMP(6)`;

export const environmentChangeRequestTable = mysqlTable(
  "EnvironmentChangeRequest",
  {
    id: ascii("id", 36)
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: ascii("tenantId", 36)
      .notNull()
      .references(() => tenant.id),
    threadId: ascii("threadId", 36)
      .notNull()
      .references(() => threadTable.id),
    selectionSequence: unsignedBigint("selectionSequence").notNull(),
    requestedRevisionId: ascii("requestedRevisionId", 36).notNull(),
    requestState: ascii("requestState", 32).notNull().default("pending"),
    requestedBy: ascii("requestedBy", 128).notNull(),
    reasonCode: ascii("reasonCode", 64),
    firstAppliedInvocationId: ascii("firstAppliedInvocationId", 36),
    expiresAt: timestamp("expiresAt"),
    versionNo: unsignedBigint("versionNo").notNull().default(1),
    createdAt: timestamp("createdAt").notNull().default(currentTimestamp()),
    updatedAt: timestamp("updatedAt").notNull().default(currentTimestamp()),
  },
  (t) => ({
    tenantIdUq: uniqueIndex("EnvironmentChangeRequest_tenant_id_uq").on(t.tenantId, t.id),
    selectionUq: uniqueIndex("EnvironmentChangeRequest_tenant_thread_sequence_uq").on(
      t.tenantId,
      t.threadId,
      t.selectionSequence,
    ),
    stateIdx: index("EnvironmentChangeRequest_tenant_thread_state_idx").on(
      t.tenantId,
      t.threadId,
      t.requestState,
      t.selectionSequence,
    ),
    stateAllowed: check(
      "EnvironmentChangeRequest_state_allowed",
      sql`\`requestState\` IN ('pending', 'accepted_for_next_invocation', 'applied', 'rejected', 'expired')`,
    ),
    appliedShape: check(
      "EnvironmentChangeRequest_applied_shape",
      sql`\`requestState\` <> 'applied' OR \`firstAppliedInvocationId\` IS NOT NULL`,
    ),
    threadFk: foreignKey({
      name: "EnvironmentChangeRequest_tenant_thread_fk",
      columns: [t.tenantId, t.threadId],
      foreignColumns: [threadTable.tenantId, threadTable.id],
    }),
    requestedRevisionFk: foreignKey({
      name: "EnvironmentChangeRequest_tenant_revision_fk",
      columns: [t.tenantId, t.requestedRevisionId],
      foreignColumns: [
        environmentDefinitionRevisionTable.tenantId,
        environmentDefinitionRevisionTable.id,
      ],
    }),
    appliedInvocationFk: foreignKey({
      name: "EnvironmentChangeRequest_tenant_invocation_fk",
      columns: [t.tenantId, t.firstAppliedInvocationId],
      foreignColumns: [invocationTable.tenantId, invocationTable.id],
    }),
  }),
);

export type EnvironmentChangeRequest = InferSelectModel<typeof environmentChangeRequestTable>;
export type EnvironmentChangeRequestInsert = InferInsertModel<typeof environmentChangeRequestTable>;
