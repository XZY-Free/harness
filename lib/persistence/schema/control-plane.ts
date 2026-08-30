/**
 * 稳定控制面 Schema 映射。
 *
 * 本文件只是跨控制面基础表的 import convenience；不定义第二套物理 Schema Authority。
 *
 * 生产代码应优先从独立 schema 文件导入：
 * agents.ts, runtimes.ts, routes.ts, executions.ts, artifacts.ts, publications.ts
 * 本文件仅保留 audit / idempotency / tenant / policy 的 re-export。
 */

// ─── Agent ────────────────────────────────────────────────────────
export {
  AGENT_LIFECYCLE_STATES,
  AGENT_REVISION_STATES,
  agentTable,
  agentRevisionTable,
} from "@/lib/persistence/schema/agents";
export type {
  AgentLifecycleState,
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

// ─── Governance Config ────────────────────────────────────────────
export {
  governanceConfigRevisionTable,
  governanceConfigSetTable,
} from "@/lib/persistence/schema/governance-config";

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
