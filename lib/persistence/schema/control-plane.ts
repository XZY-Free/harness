/**
 * 稳定控制面 Schema 映射。
 *
 * 数据库物理表名在历史迁移兼容期继续保留 前缀；正式模块只使用本文件导出的
 * 职责命名，避免方案版本进入领域和持久化实现。
 *
 * 生产代码应优先从独立 schema 文件导入：
 * agents.ts, runtimes.ts, routes.ts, executions.ts, artifacts.ts, publications.ts
 * 本文件仅保留 audit / idempotency / tenant / policy 的 re-export。
 */

// ─── Agent ────────────────────────────────────────────────────────
export {
  AGENT_LIFECYCLE_STATES,
  AGENT_REVISION_SOURCE_TYPES,
  AGENT_REVISION_STATES,
  agentTable,
  agentRevisionTable,
} from "@/lib/persistence/schema/agents";
export type {
  AgentLifecycleState,
  AgentRevisionSourceType,
  AgentRevisionState,
  AgentRow,
  AgentRevisionRow,
  NewAgentRow,
  NewAgentRevisionRow,
} from "@/lib/persistence/schema/agents";

// ─── Audit ────────────────────────────────────────────────────────
export {
  AUDIT_ACTION_TYPES,
  AUDIT_ACTOR_TYPES,
  auditEvent,
} from "@/lib/persistence/schema/audit";
export type {
  AuditActionType,
  AuditActorType,
  AuditEvent,
  NewAuditEvent,
} from "@/lib/persistence/schema/audit";

// ─── Routes ───────────────────────────────────────────────────────
export {
  deploymentRouteTable,
  deploymentRouteSetTable,
} from "@/lib/persistence/schema/routes";
export type {
  RouteState,
  DeploymentRouteRow,
  NewDeploymentRouteRow,
  DeploymentRouteSetRow,
  NewDeploymentRouteSetRow,
} from "@/lib/persistence/schema/routes";

// ─── Idempotency ──────────────────────────────────────────────────
export { idempotencyRecord } from "@/lib/persistence/schema/idempotency";

// ─── Tenant ───────────────────────────────────────────────────────
export { tenant as tenantTable } from "@/lib/persistence/schema/identity";

// ─── Policy ───────────────────────────────────────────────────────
export { policyRevisionTable, policySetTable } from "@/lib/persistence/schema/permission";

// ─── Runtime + Execution ──────────────────────────────────────────
export {
  RUNTIME_KINDS,
  RUNTIME_LIFECYCLE_STATES,
  RUNTIME_REVISION_STATES,
  runtimeTable,
  runtimeRevisionTable,
} from "@/lib/persistence/schema/runtimes";
export type {
  NewRuntimeRow,
  NewRuntimeRevisionRow,
  RuntimeKind,
  RuntimeLifecycleState,
  RuntimeRevisionState,
  RuntimeRow,
  RuntimeRevisionRow,
} from "@/lib/persistence/schema/runtimes";

export {
  executionBindingTable,
  invocationTable,
} from "@/lib/persistence/schema/executions";
export type { ExecutionBindingRow } from "@/lib/persistence/schema/executions";
