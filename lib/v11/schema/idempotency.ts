/**
 * V11 公共账本 schema：幂等账本 idempotency_record。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §2.2、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §2.3。
 *
 * 所有创建和命令 POST 共用平台幂等账本，不能只依赖 ThreadEvent：
 * - caller/audience/command_scope/idempotency_key/request_hash 与首个业务写入同事务落库。
 * - 同 key 同 request_hash 重放返回原状态码与原资源引用。
 * - 同 key 不同 request_hash 返回稳定 409 IDEMPOTENCY_CONFLICT。
 * - processing 超时可诊断，不允许简单再执行可能产生副作用的命令。
 * - Tool 的业务 operation_id 由 ToolCall 单独负责，不是同一字段。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
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

/** 四类 API audience（与 lib/http.ts V11Audience 对齐）。 */
export const IDEMPOTENCY_AUDIENCES = ["employee", "runtime", "gateway", "admin"] as const;
export type IdempotencyAudience = (typeof IDEMPOTENCY_AUDIENCES)[number];

/** 调用方类型（与 WorkloadCallerType 对齐）。 */
export const IDEMPOTENCY_CALLER_TYPES = ["user", "device", "workload", "service"] as const;
export type IdempotencyCallerType = (typeof IDEMPOTENCY_CALLER_TYPES)[number];

/** 幂等记录生命周期状态。 */
export const IDEMPOTENCY_PROCESSING_STATES = ["processing", "completed", "failed"] as const;
export type IdempotencyProcessingState = (typeof IDEMPOTENCY_PROCESSING_STATES)[number];

export const idempotencyRecord = mysqlTable(
  "IdempotencyRecord",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    audience: mysqlEnum("audience", IDEMPOTENCY_AUDIENCES).notNull(),
    callerType: mysqlEnum("callerType", IDEMPOTENCY_CALLER_TYPES).notNull(),
    /** 稳定调用方 id：userIdentityId / deviceId / serviceId / workload token jti。 */
    callerId: varchar("callerId", { length: 128 }).notNull(),
    /**
     * 规范化接口名 + 资源 Scope，如 `turn.create:thr_x`、`agent.publish:`。
     * 同一调用方在不同 command_scope 下可重用 idempotency_key。
     */
    commandScope: varchar("commandScope", { length: 128 }).notNull(),
    /** 调用方提供的幂等键（Idempotency-Key 头）。 */
    idempotencyKey: varchar("idempotencyKey", { length: 256 }).notNull(),
    /** 规范化请求 sha256 hex（method + path + 排序后 body）。 */
    requestHash: varchar("requestHash", { length: 64 }).notNull(),
    processingState: mysqlEnum("processingState", IDEMPOTENCY_PROCESSING_STATES)
      .notNull()
      .default("processing"),
    /** 完成后回填的 HTTP 状态码。processing 时为 null。 */
    httpStatus: int("httpStatus"),
    /** 完成后回填的资源引用（如 threadId / invocationId），用于重放时定位资源。 */
    responseRef: varchar("responseRef", { length: 128 }),
    /** 可安全重放的小响应 JSON（脱敏后）。大响应只存摘要，避免账本膨胀。 */
    responseRedactedJson: text("responseRedactedJson"),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    /** processing→completed/failed 时回填。 */
    completedAt: datetime("completedAt", { mode: "date", fsp: 3 }),
    /** 过期时间；过期后可被清理（数据生命周期阶段处理）。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }).notNull(),
  },
  (t) => ({
    // 同一调用方在同一 command_scope 下 idempotency_key 唯一。
    tenantAudienceCallerScopeKeyUq: uniqueIndex(
      "IdempotencyRecord_tenant_audience_caller_scope_key_uq",
    ).on(t.tenantId, t.audience, t.callerType, t.callerId, t.commandScope, t.idempotencyKey),
    tenantExpiresIdx: index("IdempotencyRecord_tenant_expires_idx").on(t.tenantId, t.expiresAt),
  }),
);

export type IdempotencyRecord = InferSelectModel<typeof idempotencyRecord>;
export type NewIdempotencyRecord = InferInsertModel<typeof idempotencyRecord>;
