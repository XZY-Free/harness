/** AgentCall Authority 迁移前的数据画像；字段名与证据文档保持一致。 */
export interface AgentCallAuthorityMigrationProfile {
  totalCalls: number;
  missingSourceActionCount: number;
  emptyLogicalCallKeyCount: number;
  duplicateLogicalSemanticsCount?: number;
  taskAuthorityConflictCount: number;
  ambiguousTaskAttemptCount: number;
  duplicateTaskMappingCount: number;
  duplicateContextMappingCount: number;
  duplicateBindingCount: number;
  attemptSequenceConflictCount: number;
  nonTerminalOrphanCount: number;
}

export class AgentCallAuthorityMigrationConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super(`AgentCall Authority 迁移被阻断：${conflicts.join(", ")}`);
    this.name = "AgentCallAuthorityMigrationConflictError";
  }
}

/** 禁止迁移层自行选择“最新”或静默覆盖；任一歧义都会阻断。 */
export function assertAgentCallAuthorityMigrationProfile(
  profile: AgentCallAuthorityMigrationProfile,
): void {
  const checks: Array<[keyof AgentCallAuthorityMigrationProfile, string]> = [
    ["missingSourceActionCount", "missing_source_action"],
    ["duplicateLogicalSemanticsCount", "duplicate_logical_semantics"],
    ["taskAuthorityConflictCount", "task_authority_conflict"],
    ["ambiguousTaskAttemptCount", "ambiguous_task_attempt"],
    ["duplicateTaskMappingCount", "duplicate_task_mapping"],
    ["duplicateContextMappingCount", "duplicate_context_mapping"],
    ["duplicateBindingCount", "duplicate_binding"],
    ["attemptSequenceConflictCount", "attempt_sequence_conflict"],
    ["nonTerminalOrphanCount", "non_terminal_orphan"],
  ];
  const conflicts = checks
    .filter(([field]) => (profile[field] ?? 0) > 0)
    .map(([field, label]) => `${label}=${profile[field] ?? 0}`);
  if (conflicts.length > 0) throw new AgentCallAuthorityMigrationConflictError(conflicts);
}
