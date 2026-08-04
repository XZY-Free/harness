/**
 * 稳定控制面 Schema 映射。
 *
 * 数据库物理表名在历史迁移兼容期继续保留 V11 前缀；正式模块只使用本文件导出的
 * 职责命名，避免方案版本进入领域和持久化实现。
 */
export {
  AGENT_LIFECYCLE_STATES,
  AGENT_REVISION_SOURCE_TYPES,
  AGENT_REVISION_STATES,
  v11Agent as agentTable,
  v11AgentRevision as agentRevisionTable,
} from "@/lib/v11/schema/agent";
export type {
  AgentLifecycleState,
  AgentRevisionSourceType,
  AgentRevisionState,
  NewV11Agent as NewAgentRow,
  NewV11AgentRevision as NewAgentRevisionRow,
  V11Agent as AgentRow,
  V11AgentRevision as AgentRevisionRow,
} from "@/lib/v11/schema/agent";
export {
  AUDIT_ACTION_TYPES,
  AUDIT_ACTOR_TYPES,
  auditEvent,
} from "@/lib/v11/schema/audit";
export type {
  AuditActionType,
  AuditActorType,
  AuditEvent,
  NewAuditEvent,
} from "@/lib/v11/schema/audit";
export { v11DeploymentRoute as deploymentRouteTable } from "@/lib/v11/schema/deployment-route";
export { v11DeploymentRouteSet as deploymentRouteSetTable } from "@/lib/v11/schema/deployment-route";
export type {
  RouteState,
  V11DeploymentRoute as DeploymentRouteRow,
  V11DeploymentRouteInsert as NewDeploymentRouteRow,
  V11DeploymentRouteSet as DeploymentRouteSetRow,
  V11DeploymentRouteSetInsert as NewDeploymentRouteSetRow,
} from "@/lib/v11/schema/deployment-route";
export { idempotencyRecord } from "@/lib/v11/schema/idempotency";
export { tenant as tenantTable } from "@/lib/v11/schema/identity";
export { v11PolicyRevision as policyRevisionTable } from "@/lib/v11/schema/permission";
export {
  RUNTIME_KINDS,
  RUNTIME_LIFECYCLE_STATES,
  RUNTIME_REVISION_STATES,
  v11ExecutionBinding as executionBindingTable,
  v11Invocation as invocationTable,
  v11Runtime as runtimeTable,
  v11RuntimeConformanceResult as runtimeConformanceResultTable,
  v11RuntimeRevision as runtimeRevisionTable,
} from "@/lib/v11/schema/runtime";
export type {
  NewV11Runtime as NewRuntimeRow,
  NewV11RuntimeRevision as NewRuntimeRevisionRow,
  RuntimeKind,
  RuntimeLifecycleState,
  RuntimeRevisionState,
  V11ExecutionBinding as ExecutionBindingRow,
  V11Runtime as RuntimeRow,
  V11RuntimeConformanceResult as RuntimeConformanceResultRow,
  V11RuntimeRevision as RuntimeRevisionRow,
} from "@/lib/v11/schema/runtime";
