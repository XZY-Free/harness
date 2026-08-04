/**
 * 稳定 Agent Schema — 正式控制面职责命名。
 *
 * 数据库物理表名在历史迁移兼容期继续保留 V11 前缀。
 * 正式模块只使用本文件导出的职责命名，不 Import lib/v11/schema。
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
  V11Agent as AgentRow,
  V11AgentRevision as AgentRevisionRow,
  NewV11Agent as NewAgentRow,
  NewV11AgentRevision as NewAgentRevisionRow,
} from "@/lib/v11/schema/agent";
