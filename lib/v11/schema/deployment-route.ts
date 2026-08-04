/**
 * V11 控制面 schema：DeploymentRouteSet 与 DeploymentRoute（S03-C04）。
 *
 * 事实源：../v11-agentkit-platform/10-core-data-model.md §4.3、§6.4、
 *         ../v11-agentkit-platform/11-api-and-event-boundaries.md §6.3、
 *         ../v11-agentkit-platform-development-plan/03-agent-runtime-and-release-control-plane.md S03-W03。
 *
 * RouteSet 聚合同一 Agent + Scope 下的所有 DeploymentRoute，使用 ETag（versionNo）做乐观并发。
 * DeploymentRoute 固定一个 AgentRevision + 一个 RuntimeRevision 组合，承载灰度权重。
 *
 * 关键约束：
 * - UNIQUE(tenantId, agentId, routeScopeKey)：一组路由共用 ETag 和聚合锁。
 * - UNIQUE(routeSetId, agentRevisionId, runtimeRevisionId)：同一 RouteSet 内组合唯一。
 * - route_state 仅 enabled/disabled；不物理删除路由行（回滚依赖历史行）。
 * - traffic_weight 为 0–10000 基点（1% = 100 基点）。
 * - 路由更新只影响新 Invocation，不改写已存在的 ExecutionBinding。
 * - 回滚创建新 RouteSet 版本（versionNo 递增），不回退版本号。
 */
import { randomUUID } from "node:crypto";
import { tenant } from "@/lib/v11/schema/identity";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
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

// ─── V11DeploymentRouteSet ─────────────────────────────────

/**
 * 路由集合：同一 Agent + Scope 下所有路由的聚合更新单元。
 *
 * - versionNo 是 ETag 来源，每次聚合更新递增（含回滚）。
 * - routeScopeKey 如 "prod"、"canary"；routeScopeJson 携带结构化范围描述。
 */
export const v11DeploymentRouteSet = mysqlTable(
  "V11DeploymentRouteSet",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    tenantId: varchar("tenantId", { length: 36 })
      .notNull()
      .references(() => tenant.id),
    agentId: varchar("agentId", { length: 36 }).notNull(),
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
    // 一组路由共用 ETag 和聚合锁
    tenantAgentScopeUq: uniqueIndex("V11DeploymentRouteSet_tenant_agent_scope_uq").on(
      t.tenantId,
      t.agentId,
      t.routeScopeKey,
    ),
    tenantAgentScopeIdx: index("V11DeploymentRouteSet_tenant_agent_scope_idx").on(
      t.tenantId,
      t.agentId,
      t.routeScopeKey,
    ),
  }),
);
export type V11DeploymentRouteSet = InferSelectModel<typeof v11DeploymentRouteSet>;
export type V11DeploymentRouteSetInsert = InferInsertModel<typeof v11DeploymentRouteSet>;

// ─── V11DeploymentRoute ────────────────────────────────────

/**
 * 部署路由：固定一个 AgentRevision + 一个 RuntimeRevision 组合，承载灰度权重。
 *
 * - 引用的 Revision 必须为 published 状态（withdrawn 只阻止新路由，不删除历史引用）。
 * - traffic_weight 为 0–10000 基点。
 * - 不物理删除；禁用设为 disabled。
 */
export const v11DeploymentRoute = mysqlTable(
  "V11DeploymentRoute",
  {
    id: varchar("id", { length: 36 })
      .primaryKey()
      .notNull()
      .$defaultFn(() => randomUUID()),
    routeSetId: varchar("routeSetId", { length: 36 })
      .notNull()
      .references(() => v11DeploymentRouteSet.id),
    /** §2.2: Route 稳定身份键 — 调用方显式指定，不再由 agentRevisionId+runtimeRevisionId 隐式推导。 */
    routeKey: varchar("routeKey", { length: 128 }).notNull(),
    agentRevisionId: varchar("agentRevisionId", { length: 36 }).notNull(),
    runtimeRevisionId: varchar("runtimeRevisionId", { length: 36 }).notNull(),
    trafficWeight: int("trafficWeight").notNull(),
    priorityNo: int("priorityNo").notNull().default(0),
    routeState: mysqlEnum("routeState", ROUTE_STATES).notNull().default("enabled"),
    effectiveFrom: datetime("effectiveFrom", { mode: "date", fsp: 3 }),
    effectiveUntil: datetime("effectiveUntil", { mode: "date", fsp: 3 }),
    /** 当前权威 RouteRevision；旧列仅作为调度兼容投影继续保留。 */
    activeRouteRevisionId: varchar("activeRouteRevisionId", { length: 36 }),
    createdAt: datetime("createdAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: datetime("updatedAt", { mode: "date", fsp: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    // §2.2: Route 稳定身份 — 同一 RouteSet 内 routeKey 唯一
    setRouteKeyUq: uniqueIndex("V11DeploymentRoute_set_routeKey_uq").on(
      t.routeSetId,
      t.routeKey,
    ),
    setStateIdx: index("V11DeploymentRoute_set_state_idx").on(t.routeSetId, t.routeState),
    agentRevisionIdx: index("V11DeploymentRoute_agentRevision_idx").on(t.agentRevisionId),
    runtimeRevisionIdx: index("V11DeploymentRoute_runtimeRevision_idx").on(t.runtimeRevisionId),
    activeRouteRevisionIdx: index("V11DeploymentRoute_activeRouteRevision_idx").on(
      t.activeRouteRevisionId,
    ),
  }),
);
export type V11DeploymentRoute = InferSelectModel<typeof v11DeploymentRoute>;
export type V11DeploymentRouteInsert = InferInsertModel<typeof v11DeploymentRoute>;
