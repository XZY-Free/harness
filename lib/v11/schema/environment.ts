/**
 * V11 执行环境 schema：EnvironmentDefinition / EnvironmentLease /
 * EnvironmentChangeRequest。
 *
 * 事实源：
 * - ../v11-agentkit-platform/10-core-data-model.md §6.13（execution_ownership 与
 *   environment_change_request）、§7.2（environment_definition 与 environment_lease）。
 * - ../v11-agentkit-platform/02-agent-thread-and-runtime.md §11（Execution Environment）。
 * - ../v11-agentkit-platform-development-plan/08-workspace-desktop-tool-execution-and-effects.md S08-W02。
 *
 * 关键不变量：
 * - EnvironmentDefinition.tenantId + environmentKey UNIQUE；environmentType 四态
 *   （desktop/cloud/remote/sandbox）。
 * - EnvironmentLease 表示某次 Attempt 的实际实例：UNIQUE(invocationId, attemptId)。
 *   Desktop binding 与 Lease 必须共享同一 deviceId（应用层校验）。
 * - Lease 失联进入恢复判断，不删除 Thread 或 Workspace。
 * - EnvironmentChangeRequest 状态机：pending → accepted_for_next_invocation/
 *   runtime_acknowledged/rejected/expired；当前 Invocation 热迁移必须 Runtime capability
 *   支持并 ack，否则只影响下一 Invocation。
 * - ExecutionOwnership 已在 runtime.ts 中定义（leaseEpoch 单调递增，
 *   UNIQUE(invocationId, leaseEpoch)）。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import { v11Invocation } from "@/lib/v11/schema/runtime";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Environment Type ─────────────────────────────────────

/**
 * 环境类型（与 WorkspaceBindingType 一致）。
 * - desktop：本机执行。
 * - cloud：云端 Workspace。
 * - remote：远程 Runtime。
 * - sandbox：不可信代码沙箱。
 */
export const ENVIRONMENT_TYPES = ["desktop", "cloud", "remote", "sandbox"] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

// ─── Environment Definition Lifecycle ─────────────────────

/**
 * EnvironmentDefinition 生命周期。
 * - active：可用。
 * - archived：归档，不允许新 Lease。
 * - deleted：软删除（终态）。
 */
export const ENVIRONMENT_DEFINITION_LIFECYCLE_STATES = ["active", "archived", "deleted"] as const;
export type EnvironmentDefinitionLifecycleState =
  (typeof ENVIRONMENT_DEFINITION_LIFECYCLE_STATES)[number];

// ─── Environment Lease State ──────────────────────────────

/**
 * EnvironmentLease 状态。
 * - allocated：已分配，尚未激活。
 * - active：Runtime 正在使用此 Lease。
 * - releasing：平台正在释放（运行中 ToolCall 完成后回收）。
 * - released：主动释放（终态）。
 * - expired：超时未心跳（终态）。
 * - lost：Runtime 主动报告丢失或心跳超时被标记（终态）。
 */
export const ENVIRONMENT_LEASE_STATES = [
  "allocated",
  "active",
  "releasing",
  "released",
  "expired",
  "lost",
] as const;
export type EnvironmentLeaseState = (typeof ENVIRONMENT_LEASE_STATES)[number];

/** Lease 终态集合（不可恢复）。 */
export const ENVIRONMENT_LEASE_TERMINAL_STATES: readonly EnvironmentLeaseState[] = [
  "released",
  "expired",
  "lost",
];

// ─── Environment Change Request State ─────────────────────

/**
 * EnvironmentChangeRequest 状态机（§6.13）。
 * - pending：员工已请求，等待平台决策。
 * - accepted_for_next_invocation：Runtime 不支持热迁移，标记下一 Invocation 生效。
 * - runtime_acknowledged：Runtime 支持热迁移并 ack，当前 Invocation 已切换。
 * - rejected：平台或策略拒绝（终态）。
 * - expired：未在窗口内 ack 或下一 Invocation 接纳（终态）。
 */
export const ENVIRONMENT_CHANGE_REQUEST_STATES = [
  "pending",
  "accepted_for_next_invocation",
  "runtime_acknowledged",
  "rejected",
  "expired",
] as const;
export type EnvironmentChangeRequestState = (typeof ENVIRONMENT_CHANGE_REQUEST_STATES)[number];

/** EnvironmentChangeRequest 终态集合。 */
export const ENVIRONMENT_CHANGE_REQUEST_TERMINAL_STATES: readonly EnvironmentChangeRequestState[] =
  ["rejected", "expired"];

// ─── EnvironmentDefinition ────────────────────────────────

/**
 * V11EnvironmentDefinition 表：固定文件、网络、资源、Secret 策略的环境定义（§7.2）。
 *
 * 关键约束：
 * - UNIQUE(tenantId, environmentKey)：租户内稳定 key 唯一。
 * - lifecycleState 三态（active/archived/deleted），deleted 为终态。
 * - archived 不允许新 Lease 引用，但不删除历史 Lease。
 * - versionNo 乐观并发控制（ bigint 单调递增）。
 * - filesystem/network/resource/secret policy JSON 由平台固定 Schema，本表只持久化。
 */
export const v11EnvironmentDefinition = mysqlTable(
  "V11EnvironmentDefinition",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /** 租户内稳定唯一 key（slug），如 "desktop-default"。 */
    environmentKey: varchar("environmentKey", { length: 128 }).notNull(),
    displayName: varchar("displayName", { length: 256 }).notNull(),
    description: text("description"),
    /** 环境类型（desktop/cloud/remote/sandbox）。 */
    environmentType: mysqlEnum("environmentType", ENVIRONMENT_TYPES).notNull(),
    /** 文件系统策略（路径白名单/黑名单、读写权限）。 */
    filesystemPolicyJson: json("filesystemPolicyJson").notNull(),
    /** 网络策略（出站域名/IP 白名单）。 */
    networkPolicyJson: json("networkPolicyJson").notNull(),
    /** 资源限制（CPU、内存、时长、并发）。 */
    resourceLimitsJson: json("resourceLimitsJson").notNull(),
    /** Secret 注入策略（哪些 CredentialRef 可注入、注入方式）。 */
    secretPolicyJson: json("secretPolicyJson").notNull(),
    lifecycleState: mysqlEnum("lifecycleState", ENVIRONMENT_DEFINITION_LIFECYCLE_STATES)
      .notNull()
      .default("active"),
    /** 乐观并发版本号（单调递增）。 */
    versionNo: bigint("versionNo", { mode: "number" }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    deletedAt: datetime("deletedAt", { mode: "date" }),
  },
  (t) => ({
    tenantKeyUq: uniqueIndex("V11EnvironmentDefinition_tenant_key_uq").on(
      t.tenantId,
      t.environmentKey,
    ),
    tenantLifecycleUpdatedIdx: index("V11EnvironmentDefinition_tenant_lifecycle_updated_idx").on(
      t.tenantId,
      t.lifecycleState,
      t.updatedAt,
    ),
    tenantTypeIdx: index("V11EnvironmentDefinition_tenant_type_idx").on(
      t.tenantId,
      t.environmentType,
    ),
  }),
);

export type V11EnvironmentDefinition = InferSelectModel<typeof v11EnvironmentDefinition>;
export type V11EnvironmentDefinitionInsert = InferInsertModel<typeof v11EnvironmentDefinition>;

// ─── EnvironmentLease ─────────────────────────────────────

/**
 * V11EnvironmentLease 表：某次 Attempt 的实际执行环境实例（§7.2）。
 *
 * 关键约束：
 * - UNIQUE(invocationId, attemptId)：同一 Invocation 同一 Attempt 只能有一个 Lease。
 * - environmentDefinitionId 引用 EnvironmentDefinition（FK RESTRICT，不允许删除有 Lease 引用的 Definition）。
 * - invocationId 引用 V11Invocation（FK CASCADE，Invocation 删除时 Lease 一并删除）。
 * - Desktop Lease 必含 deviceId；Cloud/Remote/Sandbox 可空。
 * - leaseState 状态机：allocated → active → releasing → released/expired/lost。
 * - 终态后不可恢复。
 * - capabilitiesJson 由 Runtime 探测填入，包括热迁移能力。
 */
export const v11EnvironmentLease = mysqlTable(
  "V11EnvironmentLease",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    environmentDefinitionId: varchar("environmentDefinitionId", { length: 36 })
      .notNull()
      .references(() => v11EnvironmentDefinition.id),
    /** 引用 V11Invocation.id（FK CASCADE）。 */
    invocationId: varchar("invocationId", { length: 36 })
      .notNull()
      .references(() => v11Invocation.id),
    /** 引用 V11InvocationAttempt.id（逻辑外键，应用层校验）。 */
    attemptId: varchar("attemptId", { length: 36 }).notNull(),
    /** Desktop Lease 必填；Cloud/Remote/Sandbox 可空。 */
    deviceId: varchar("deviceId", { length: 36 }),
    /** Runtime 内部 worker 引用。 */
    workerRef: varchar("workerRef", { length: 256 }),
    leaseState: mysqlEnum("leaseState", ENVIRONMENT_LEASE_STATES).notNull().default("allocated"),
    /** Runtime 探测的真实能力（包括热迁移支持）。 */
    capabilitiesJson: json("capabilitiesJson"),
    allocatedAt: datetime("allocatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    lastHeartbeatAt: datetime("lastHeartbeatAt", { mode: "date", fsp: 3 }),
    releasedAt: datetime("releasedAt", { mode: "date", fsp: 3 }),
    /** Lease 过期时间；超过且无心跳 → expired。 */
    expiresAt: datetime("expiresAt", { mode: "date", fsp: 3 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    invocationAttemptUq: uniqueIndex("V11EnvironmentLease_invocation_attempt_uq").on(
      t.invocationId,
      t.attemptId,
    ),
    tenantStateIdx: index("V11EnvironmentLease_tenant_state_idx").on(t.tenantId, t.leaseState),
    definitionIdx: index("V11EnvironmentLease_definition_idx").on(t.environmentDefinitionId),
    deviceIdx: index("V11EnvironmentLease_device_idx").on(t.deviceId),
  }),
);

export type V11EnvironmentLease = InferSelectModel<typeof v11EnvironmentLease>;
export type V11EnvironmentLeaseInsert = InferInsertModel<typeof v11EnvironmentLease>;

// ─── EnvironmentChangeRequest ─────────────────────────────

/**
 * V11EnvironmentChangeRequest 表：员工请求切换执行环境（§6.13）。
 *
 * 关键约束：
 * - threadId + invocationId 必须同租户（应用层校验）。
 * - requestState 状态机：pending → accepted_for_next_invocation/runtime_acknowledged/
 *   rejected/expired。
 * - 当前 Invocation 热迁移必须 Runtime capability 支持且无 unknown_effect，
 *   否则只影响下一 Invocation（accepted_for_next_invocation）。
 * - runtime_acknowledged 表示当前 Invocation 已切换 Lease。
 * - 终态后不可恢复。
 */
export const v11EnvironmentChangeRequest = mysqlTable(
  "V11EnvironmentChangeRequest",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    threadId: varchar("threadId", { length: 36 }).notNull(),
    /** 当前 Invocation id；可空表示下一 Invocation 生效。 */
    invocationId: varchar("invocationId", { length: 36 }),
    fromEnvironmentDefinitionId: varchar("fromEnvironmentDefinitionId", { length: 36 })
      .notNull()
      .references(() => v11EnvironmentDefinition.id),
    requestedEnvironmentDefinitionId: varchar("requestedEnvironmentDefinitionId", { length: 36 })
      .notNull()
      .references(() => v11EnvironmentDefinition.id),
    /** 切换到指定设备（仅 Desktop 必填）。 */
    requestedDeviceId: varchar("requestedDeviceId", { length: 36 }),
    requestState: mysqlEnum("requestState", ENVIRONMENT_CHANGE_REQUEST_STATES)
      .notNull()
      .default("pending"),
    /** 员工请求原因 / Runtime 拒绝原因。 */
    reasonCode: varchar("reasonCode", { length: 128 }),
    /** 请求发起者 userIdentityId 或 serviceId。 */
    requestedBy: varchar("requestedBy", { length: 128 }).notNull(),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: datetime("resolvedAt", { mode: "date", fsp: 3 }),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    tenantThreadStateIdx: index("V11EnvironmentChangeRequest_tenant_thread_state_idx").on(
      t.tenantId,
      t.threadId,
      t.requestState,
    ),
    tenantInvocationIdx: index("V11EnvironmentChangeRequest_tenant_invocation_idx").on(
      t.tenantId,
      t.invocationId,
    ),
    fromDefinitionIdx: index("V11EnvironmentChangeRequest_from_definition_idx").on(
      t.fromEnvironmentDefinitionId,
    ),
    requestedDefinitionIdx: index("V11EnvironmentChangeRequest_requested_definition_idx").on(
      t.requestedEnvironmentDefinitionId,
    ),
  }),
);

export type V11EnvironmentChangeRequest = InferSelectModel<typeof v11EnvironmentChangeRequest>;
export type V11EnvironmentChangeRequestInsert = InferInsertModel<
  typeof v11EnvironmentChangeRequest
>;
