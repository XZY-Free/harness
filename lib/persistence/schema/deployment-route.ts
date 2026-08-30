/**
 * 控制面 schema：DeploymentRouteSet 与 DeploymentRoute。
 *
 * 事实源：
 * - docs/architecture/persistence.md
 * - docs/architecture/api-and-events.md
 * - docs/architecture/agent-control-plane.md
 *
 * RouteSet 按“显式 target + scope”聚合所有 DeploymentRoute，使用 ETag（versionNo）做乐观并发。
 * DeploymentRoute 是 runtime | agent 判别联合，承载灰度权重。
 *
 * 关键约束：
 * - UNIQUE(tenantId, targetKind, targetIdentity, routeScopeKey)：一组路由共用 ETag 和聚合锁。
 * - UNIQUE(routeSetId, routeKey)：routeKey 在同一 RouteSet 内唯一，作为 Route 稳定身份。
 * - route_state 仅 enabled/disabled；不物理删除路由行（回滚依赖历史行）。
 * - traffic_weight 为 0–10000 基点（1% = 100 基点）。
 * - 路由更新只影响新 Invocation，不改写已存在的 ExecutionBinding。
 * - 回滚创建新 RouteSet 版本（versionNo 递增），不回退版本号。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/persistence/schema/identity";
import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import {
  bigint,
  check,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Route State ───────────────────────────────────────────

/**
 * DeploymentRoute 状态。
 * - enabled：有效，参与流量分配。
 * - disabled：禁用，不参与流量分配（不物理删除，回滚依赖历史行）。
 */
export const ROUTE_STATES = ["enabled", "disabled"] as const;
export type RouteState = (typeof ROUTE_STATES)[number];

// ─── Route Target ──────────────────────────────────────────

/**
 * Route 目标类型 — 显式判别，禁止再用 agentId null/non-null 隐式猜测目标。
 * - runtime：SnowHarness Harness Runtime Route（顶层执行目标）。
 * - agent：Agent 能力 Route（Harness 调用外部 Agent 能力）。
 * 仍只有一套 Route 体系，targetKind 只区分目标，不建立第二套路由 Authority。
 */
export const ROUTE_TARGET_KINDS = ["runtime", "agent"] as const;
export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number];

// ─── DeploymentRouteSet ─────────────────────────────────

/**
 * 路由集合：同一“Agent 能力 + scope”或“基础 Harness + scope”下所有路由的聚合更新单元。
 *
 * - versionNo 是 ETag 来源，每次聚合更新递增（含回滚）。
 * - routeScopeKey 如 "prod"、"canary"；routeScopeJson 携带结构化范围描述。
 * - targetKind 显式声明目标类型；runtime 时 agentId 必须为 NULL，agent 时 agentId 必须非空。
 */
export const deploymentRouteSetTable = mysqlTable(
  "DeploymentRouteSet",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    /**
     * 目标类型。
     * - runtime：基础 Harness RouteSet，targetIdentity=runtime，agentId 必须 NULL。
     * - agent：Agent 能力 RouteSet，targetIdentity=agentId，agentId 必须非空。
     * 无隐式默认：调用方必须显式给出 target 判别。
     */
    targetKind: mysqlEnum("targetKind", ROUTE_TARGET_KINDS).notNull(),
    /**
     * 目标唯一身份（非空、非空串）：
     * - runtime：固定 "runtime"。
     * - agent：= agentId。
     * 与 targetKind/agentId 一起被 CHECK 约束强制一致，并参与唯一性。
     */
    targetIdentity: varchar("targetIdentity", { length: 36 }).notNull(),
    /**
     * 归属 Agent ID（仅 targetKind=agent 时非空）。
     * runtime 时必为 null。targetKind/targetIdentity/agentId 一致性由 CHECK 保证。
     */
    agentId: varchar("agentId", { length: 36 }),
    routeScopeKey: varchar("routeScopeKey", { length: 128 }).notNull(),
    routeScopeJson: json("routeScopeJson").notNull(),
    versionNo: bigint("versionNo", { mode: "number", unsigned: true }).notNull().default(1),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // 唯一身份 = tenantId + targetKind + targetIdentity + routeScopeKey（全部 NOT NULL，
    // 杜绝 runtime agentId=NULL 绕过唯一性）。
    tenantTargetScopeUq: uniqueIndex("DeploymentRouteSet_tenant_target_scope_uq").on(
      t.tenantId,
      t.targetKind,
      t.targetIdentity,
      t.routeScopeKey,
    ),
    tenantTargetScopeIdx: index("DeploymentRouteSet_tenant_target_scope_idx").on(
      t.tenantId,
      t.targetKind,
      t.targetIdentity,
      t.routeScopeKey,
    ),
    // targetIdentity 非空；runtime/agent 与 targetIdentity/agentId 一致性（判别联合）。
    targetIdentityCheck: check(
      "DeploymentRouteSet_target_identity_check",
      sql`TRIM(\`targetIdentity\`) <> ''`,
    ),
    targetConsistencyCheck: check(
      "DeploymentRouteSet_target_consistency_check",
      sql`(
        (\`targetKind\` = 'runtime' AND \`targetIdentity\` = 'runtime' AND \`agentId\` IS NULL)
        OR
        (\`targetKind\` = 'agent' AND \`targetIdentity\` = \`agentId\`
          AND \`agentId\` IS NOT NULL AND TRIM(\`agentId\`) <> '')
      )`,
    ),
  }),
);
export type DeploymentRouteSet = InferSelectModel<typeof deploymentRouteSetTable>;
export type DeploymentRouteSetInsert = InferInsertModel<typeof deploymentRouteSetTable>;

// ─── DeploymentRoute ────────────────────────────────────

/**
 * 部署路由：固定 runtime | agent 之一，承载灰度权重。
 *
 * - 引用的 Revision 必须为 published 状态（withdrawn 只阻止新路由，不删除历史引用）。
 * - traffic_weight 为 0–10000 基点。
 * - 不物理删除；禁用设为 disabled。
 */
export const deploymentRouteTable = mysqlTable(
  "DeploymentRoute",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    routeSetId: varchar("routeSetId", { length: 36 })
      .notNull()
      .references(() => deploymentRouteSetTable.id),
    /** Route 稳定身份键 — 调用方显式指定，在同一 RouteSet 内唯一。 */
    routeKey: varchar("routeKey", { length: 128 }).notNull(),
    /**
     * 绑定的 AgentRevision ID。
     * null = 基础 Harness Route（无 Agent 资产约束）；有值 = Agent Route。
     */
    agentRevisionId: varchar("agentRevisionId", { length: 36 }),
    /** 目标判别：runtime 时非空、agent 时为空。与 agentRevisionId 恰好一个非空（CHECK）。 */
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }),
    trafficWeight: int("trafficWeight").notNull(),
    priorityNo: int("priorityNo").notNull().default(0),
    routeState: mysqlEnum("routeState", ROUTE_STATES).notNull().default("enabled"),
    effectiveFrom: datetime("effectiveFrom", { mode: "date", fsp: 3 }),
    effectiveUntil: datetime("effectiveUntil", { mode: "date", fsp: 3 }),
    /** 当前权威 RouteRevision；旧列仅作调度投影保留。 */
    activeRouteRevisionId: varchar("activeRouteRevisionId", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // Route 稳定身份 — 同一 RouteSet 内 routeKey 唯一
    setRouteKeyUq: uniqueIndex("DeploymentRoute_set_routeKey_uq").on(t.routeSetId, t.routeKey),
    setStateIdx: index("DeploymentRoute_set_state_idx").on(t.routeSetId, t.routeState),
    agentRevisionIdx: index("DeploymentRoute_agentRevision_idx").on(t.agentRevisionId),
    runtimeRevisionIdx: index("DeploymentRoute_runtimeRevision_idx").on(t.runtimeRevisionId),
    activeRouteRevisionIdx: index("DeploymentRoute_activeRouteRevision_idx").on(
      t.activeRouteRevisionId,
    ),
    // 恰好一个目标 revision 非空（判别联合）。
    exactOneTargetCheck: check(
      "DeploymentRoute_exact_one_target_check",
      sql`(
        (\`runtimeRevisionId\` IS NOT NULL AND \`agentRevisionId\` IS NULL)
        OR
        (\`runtimeRevisionId\` IS NULL AND \`agentRevisionId\` IS NOT NULL)
      )`,
    ),
  }),
);
export type DeploymentRoute = InferSelectModel<typeof deploymentRouteTable>;
export type DeploymentRouteInsert = InferInsertModel<typeof deploymentRouteTable>;
