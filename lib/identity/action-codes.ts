/**
 * 稳定 Action Code 目录。
 *
 * 事实源：
 * - docs/architecture/persistence.md （稳定管理动作列表）
 * - docs/architecture/security.md （动作目录与资源 Scope）
 *
 * 服务端只依赖 action_code + resource_scope 判断；UI 菜单权限不能代替服务端 action_code。
 * 空 allowlist、未知 action、无法解析 scope 全部拒绝。
 */
import { ResourceScopeError, type ResourceScopeType } from "@/lib/identity/resource-scope";

/** 稳定管理动作目录（方案 + 最低动作集）。 */
export const ACTION_CODES = [
  "agent.descriptor.create",
  "agent.revision.create",
  "agent.publish",
  "agent.retract",
  "route.update",
  "runtime.publish",
  "runtime.retract",
  "tool.schema.publish",
  "policy.publish",
  "governance.config.publish",
  "credential.bind",
  "credential.revoke",
  "memory.review",
  "job.cancel",
  "job.retry",
  "event.quarantine.resolve",
  "artifact.attestation.verify",
  "artifact.attestation.revoke",
  "legal_hold.manage",
  "deletion.request",
  "audit.export",
  "skill.create",
  "skill.update",
  "skill.publish",
  "skill.version.create",
  "tool.provider.create",
  "tool.provider.update",
  "tool.create",
  "tool.update",
  "connection.create",
  "connection.update",
  "capability.review",
  "knowledge.base.create",
  "knowledge.base.update",
  "knowledge.base.archive",
  "knowledge.document.create",
  "knowledge.document.publish",
  "knowledge.document.retract",
  "admin.export.create",
  "admin.export.read",
  "admin.export.download",
  "admin.export.requested",
  "admin.export.completed",
  "admin.export.failed",
  "admin.operations.read",
  // 运行时安全动作（S12-W05）：Workload Token 撤销
  "workload.token.revoke",
  // 备份恢复演练动作（S12-W08）：恢复演练发起与读取
  "recovery.drill",
  // 安全与事故处置动作（S12-W09）：安全事件创建、隔离止损、解决
  "security.incident.create",
  "security.incident.isolate",
  "security.incident.resolve",
  // ── Studio 访问动作（关口02 02-2 并入正式授权单一模型）─────────────
  // 解码旧 RBAC 把 scope 编进权限字符串的语义（thread.write.self / thread.read.all）：
  // Action Code = 动作，Resource Scope = 资源范围。以下为正式模型缺失的
  // Studio 长期业务动作；粗粒度租户内访问由 (tenant 资源) 表达，.self 由
  // (self 资源) 表达，细粒度资源级由既有 owner guard / resource scope 决定。
  "studio.access",
  "skill.read",
  "skill.write",
  "thread.read",
  "thread.write",
  "policy.read",
  "policy.write",
  "user.manage",
  "agent.read",
  "workspace.read",
  "workspace.write",
  "analytics.read",
  "audit.read",
] as const;

export type ActionCode = (typeof ACTION_CODES)[number];

const ACTION_CODE_SET: ReadonlySet<string> = new Set(ACTION_CODES);

/** 判断 action code 是否在稳定目录内。未知 action 一律拒绝。 */
export function isKnownActionCode(code: string): code is ActionCode {
  return ACTION_CODE_SET.has(code);
}

/** 每个 action code 允许的 resource scope types（方案 ）。 */
export const ACTION_RESOURCE_TYPES: Record<ActionCode, readonly ResourceScopeType[]> = {
  "agent.descriptor.create": ["agent", "team"],
  "agent.revision.create": ["agent", "team"],
  "agent.publish": ["agent", "environment"],
  "agent.retract": ["agent", "environment"],
  "route.update": ["agent", "environment"],
  "runtime.publish": ["environment", "runtime"],
  "runtime.retract": ["environment", "runtime"],
  "tool.schema.publish": ["tool"],
  "policy.publish": ["tenant", "policy"],
  "governance.config.publish": ["tenant"],
  "credential.bind": ["connection", "principal"],
  "credential.revoke": ["connection", "principal"],
  "memory.review": ["workspace", "agent", "organization"],
  "job.cancel": ["job_type", "owner"],
  "job.retry": ["job_type", "owner"],
  "event.quarantine.resolve": ["consumer", "tenant"],
  "artifact.attestation.verify": ["artifact_type", "project"],
  "artifact.attestation.revoke": ["artifact_type", "tenant"],
  "legal_hold.manage": ["tenant", "data_class"],
  "deletion.request": ["self", "tenant"],
  "audit.export": ["tenant", "time_range"],
  "skill.create": ["tenant", "team"],
  "skill.update": ["skill", "owner"],
  "skill.publish": ["skill"],
  "skill.version.create": ["skill"],
  "tool.provider.create": ["tenant", "provider"],
  "tool.provider.update": ["provider"],
  "tool.create": ["provider", "tool"],
  "tool.update": ["tool"],
  "connection.create": ["tenant"],
  "connection.update": ["connection"],
  "capability.review": ["tool", "skill", "tenant"],
  "knowledge.base.create": ["tenant", "team"],
  "knowledge.base.update": ["knowledge_base"],
  "knowledge.base.archive": ["knowledge_base"],
  "knowledge.document.create": ["knowledge_base"],
  "knowledge.document.publish": ["knowledge_document"],
  "knowledge.document.retract": ["knowledge_document"],
  "admin.export.create": ["tenant"],
  "admin.export.read": ["tenant"],
  "admin.export.download": ["tenant"],
  "admin.export.requested": ["tenant"],
  "admin.export.completed": ["tenant"],
  "admin.export.failed": ["tenant"],
  "admin.operations.read": ["tenant"],
  "workload.token.revoke": ["tenant", "invocation"],
  "recovery.drill": ["tenant"],
  "security.incident.create": ["tenant"],
  "security.incident.isolate": ["tenant"],
  "security.incident.resolve": ["tenant"],
  // Studio 访问动作资源范围：粗粒度租户访问用 (tenant)，.self 用 (self)，
  // 资源级（skill/workspace/policy/agent）允许带具体资源 scope。
  "studio.access": ["tenant"],
  "skill.read": ["tenant", "skill"],
  "skill.write": ["tenant", "skill"],
  "thread.read": ["tenant", "self"],
  "thread.write": ["tenant", "self"],
  "policy.read": ["tenant", "policy"],
  "policy.write": ["tenant", "policy"],
  "user.manage": ["tenant"],
  "agent.read": ["tenant", "agent"],
  "workspace.read": ["tenant", "workspace"],
  "workspace.write": ["tenant", "workspace"],
  "analytics.read": ["tenant"],
  "audit.read": ["tenant"],
};

// Re-export 供外部统一从 action-codes 引入（authorization 等模块）。
export type { ResourceScopeType } from "@/lib/identity/resource-scope";
export { ResourceScopeError } from "@/lib/identity/resource-scope";

/**
 * 校验 action_code 与 resource scope type 是否匹配方案目录。
 * @throws ResourceScopeError scope_type_mismatch
 */
export function assertActionResourceTypeMatch(
  actionCode: ActionCode,
  scopeType: ResourceScopeType,
): void {
  const allowed = ACTION_RESOURCE_TYPES[actionCode];
  if (!allowed.includes(scopeType)) {
    throw new ResourceScopeError(
      "scope_type_mismatch",
      `action ${actionCode} 不允许 resource scope type ${scopeType}`,
    );
  }
}
