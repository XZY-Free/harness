/**
 * 用户操作请求 schema：UserActionRequest（阶段 8 S08-C04）。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.8（user_action_request 与 grant）、§5.5。
 * - ../v11-agentkit-platform/09-unified-domain-model.md §5.5（PermissionDecision 与 UserActionRequest 关系）。
 * - ../v11-agentkit-platform/11-api-and-event-boundaries.md §3.18（resolve 接口约束）、
 *   §3.19（auth callback）、§10（block 不可被绕过）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W04。
 *
 * 关键不变量：
 * - 四种 request_type 共用一张表：confirmation / auth / grant / input。
 * - ThreadItem.user_action_request 类型 Item 只是该请求的员工可见投影（不能成为第二份事实源）。
 * - 请求只能解析一次；resolution、scope 和 input_schema 均由服务端验证。
 * - auth 类型成功只能来自可信 callback，:resolve 接口仅接受 cancel。
 * - state/nonce 一次性消费，hash 后存储（不存原值）。
 * - expires_at 超时后进入 expired 终态，不可再 resolve。
 * - block 决策不创建本表记录（§10 验收：无可解析 approve 请求）。
 * - resolve 与 resume command 同事务写入（在仓储层 createUserActionRequest 时关联）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── RequestType ─────────────────────────────────────────

/**
 * UserActionRequest 类型（§5.5）。
 * - confirmation：副作用确认（approve/deny）。
 * - auth：外部系统登录（OAuth/OIDC，只能由可信 callback 完成）。
 * - grant：用户授权（approve/deny，成功后写 Grant）。
 * - input：补充信息（submit/cancel，按 input_schema 校验 response）。
 */
export const USER_ACTION_REQUEST_TYPES = ["confirmation", "auth", "grant", "input"] as const;
export type UserActionRequestType = (typeof USER_ACTION_REQUEST_TYPES)[number];

// ─── RequestState ────────────────────────────────────────

/**
 * UserActionRequest 状态机。
 * - pending：等待用户操作或 callback。
 * - resolved：已解析（approve/deny/submit/cancel/auth_success）。
 * - expired：超时未解析（扫描任务批量更新）。
 *
 * pending → resolved 或 expired 单向终态，不可恢复。
 */
export const USER_ACTION_REQUEST_STATES = ["pending", "resolved", "expired"] as const;
export type UserActionRequestState = (typeof USER_ACTION_REQUEST_STATES)[number];

export const USER_ACTION_REQUEST_TERMINAL_STATES: readonly UserActionRequestState[] = [
  "resolved",
  "expired",
];

// ─── Resolution ──────────────────────────────────────────

/**
 * 解析结果（§3.18）。
 * - approve：confirmation/grant 用户同意。
 * - deny：confirmation/grant 用户拒绝。
 * - submit：input 用户提交（按 input_schema 校验后的 response）。
 * - cancel：input/auth 用户取消（auth 的 :resolve 接口仅接受 cancel）。
 *
 * auth 类型的成功（隐含 approve）只能由可信 callback 写入。
 */
export const USER_ACTION_RESOLUTIONS = ["approve", "deny", "submit", "cancel"] as const;
export type UserActionResolution = (typeof USER_ACTION_RESOLUTIONS)[number];

/**
 * 各 request_type 允许的 resolution 集合（§3.18）。
 * - auth 在 :resolve 接口仅接受 cancel；approve 只能由可信 callback 写入。
 */
export const ALLOWED_RESOLUTIONS_BY_TYPE: Record<
  UserActionRequestType,
  readonly UserActionResolution[]
> = {
  confirmation: ["approve", "deny"],
  auth: ["cancel"], // :resolve 接口仅接受 cancel；approve 由 callback 隐式写入
  grant: ["approve", "deny"],
  input: ["submit", "cancel"],
};

// ─── UserActionRequest 表 ────────────────────────────────

/**
 * UserActionRequest 表：四种用户操作请求的统一持久化事实源（§6.8）。
 *
 * 关键约束：
 * - tenantId 冗余字段（与 thread_id 一致性由应用层校验）。
 * - thread_id / turn_id / invocation_id 逻辑外键，必须一致。
 * - tool_call_id 可空（非 ToolCall 引发的请求，如 Workflow 主动 handoff）；非空时必须属于该 Invocation。
 * - item_id 可空但唯一（员工可见 ThreadItem 投影的外键）。
 * - auth_state_hash / nonce_hash：sha256 前缀 + 64 hex；auth 类型必填。
 * - input_schema_json：input 类型必填（JSON Schema）。
 * - resolution / resolved_by / resolved_at / response_redacted_json：解析后填写。
 * - grant_id：grant 类型 approve 后指向 Grant.id。
 * - 只能从 pending 解析一次（应用层原子更新 + 乐观锁）。
 */
export const userActionRequestTable = mysqlTable(
  "UserActionRequest",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 所属 Thread（逻辑外键 → Thread.id）。 */
    threadId: varchar("threadId", { length: 36 }).notNull(),
    /** 所属 Turn（逻辑外键 → Turn.id）。 */
    turnId: varchar("turnId", { length: 36 }).notNull(),
    /** 所属 Invocation，必须为 Turn Invocation（逻辑外键 → Invocation.id）。 */
    invocationId: varchar("invocationId", { length: 36 }).notNull(),
    /** 引发请求的 ToolCall（可空；逻辑外键 → ToolCall.id）。 */
    toolCallId: varchar("toolCallId", { length: 36 }),
    /** 员工可见 ThreadItem 投影外键（可空但唯一；逻辑外键 → ThreadItem.id）。 */
    itemId: varchar("itemId", { length: 36 }),
    /** 请求类型。 */
    requestType: mysqlEnum("requestType", USER_ACTION_REQUEST_TYPES).notNull(),
    /** 业务意图标识（如 handoff / tool_confirm / credential_login）。 */
    purpose: varchar("purpose", { length: 64 }),
    /** 请求状态。 */
    requestState: mysqlEnum("requestState", USER_ACTION_REQUEST_STATES)
      .notNull()
      .default("pending"),
    /** 员工可理解的提示（JSON：{ title, impact, ... }，脱敏）。 */
    promptJson: json("promptJson").notNull(),
    /** input 类型的响应 schema（JSON Schema）；其他类型为 null。 */
    inputSchemaJson: json("inputSchemaJson"),
    /** auth 类型的 OAuth state hash（sha256: 前缀 + 64 hex）；其他类型为 null。 */
    authStateHash: varchar("authStateHash", { length: 128 }),
    /** auth 类型的 OIDC nonce hash（sha256: 前缀 + 64 hex）；其他类型为 null。 */
    nonceHash: varchar("nonceHash", { length: 128 }),
    /** 过期时间；null 表示永不过期。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    /** 解析结果（approve/deny/submit/cancel）；pending/expired 时为 null。 */
    resolution: mysqlEnum("resolution", USER_ACTION_RESOLUTIONS),
    /** 解析人 userId（逻辑外键 → UserIdentity.id）；pending/expired 时为 null。 */
    resolvedBy: varchar("resolvedBy", { length: 36 }),
    /** 解析时间；pending/expired 时为 null。 */
    resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
    /** 脱敏后的用户响应（如 input 类型的 submit 内容）；不含敏感原值。 */
    responseRedactedJson: json("responseRedactedJson"),
    /** grant 类型 approve 后指向 Grant.id（逻辑外键）。 */
    grantId: varchar("grantId", { length: 36 }),
    /** 乐观并发版本号。 */
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    itemIdUq: uniqueIndex("UserActionRequest_item_id_uq").on(t.itemId),
    tenantInvocationStateIdx: index("UserActionRequest_tenant_invocation_state_idx").on(
      t.tenantId,
      t.invocationId,
      t.requestState,
    ),
    tenantToolCallIdx: index("UserActionRequest_tenant_toolCall_idx").on(t.tenantId, t.toolCallId),
    tenantStateExpiresIdx: index("UserActionRequest_tenant_state_expires_idx").on(
      t.tenantId,
      t.requestState,
      t.expiresAt,
    ),
    authStateHashIdx: index("UserActionRequest_auth_state_hash_idx").on(t.authStateHash),
  }),
);

export type UserActionRequest = InferSelectModel<typeof userActionRequestTable>;
export type NewUserActionRequest = InferInsertModel<typeof userActionRequestTable>;
