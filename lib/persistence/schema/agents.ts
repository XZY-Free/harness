/**
 * 稳定 Agent Schema — 正式控制面职责命名。
 *
 * 数据库物理表名在历史迁移兼容期继续保留 前缀。
 * 正式模块只使用本文件导出的职责命名，不 Import lib/persistence/schema。
 */

export {
  AGENT_LIFECYCLE_STATES,
  AGENT_REVISION_SOURCE_TYPES,
  AGENT_REVISION_STATES,
  agentTable,
  agentRevisionTable,
} from "@/lib/persistence/schema/agent";

export type {
  AgentLifecycleState,
  AgentRevisionSourceType,
  AgentRevisionState,
  Agent as AgentRow,
  AgentRevision as AgentRevisionRow,
  NewAgent as NewAgentRow,
  NewAgentRevision as NewAgentRevisionRow,
} from "@/lib/persistence/schema/agent";
