import { ACTION_RESOURCE_TYPES, type ActionCode } from "@/lib/identity/action-codes";
import { type ResourceScope, serializeResourceScope } from "@/lib/identity/resource-scope";

export type RoleTemplateKey = "admin" | "member" | "builder" | "auditor";

/** 模板内单条 grant：action_code + 类型化 resource_scope。 */
export interface RoleTemplateGrant {
  actionCode: ActionCode;
  resourceScope: ResourceScope;
}

/** 角色模板：一组 grants 的命名集合。 */
export interface RoleTemplate {
  key: RoleTemplateKey;
  name: string;
  isSystem: true;
  grants: RoleTemplateGrant[];
}

const tenant = (): ResourceScope => ({ type: "tenant", wildcard: true });
const self = (): ResourceScope => ({ type: "self", wildcard: true });

/** 内置角色与初始化管理员共用这一份定义。业务数据访问不随管理员身份放开。 */
// 新动作需显式评审后加入，不能因为动作目录或导航扩充而自动获得权限。
const ADMIN_ACTIONS: readonly ActionCode[] = [
  "agent.contract.register",
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
  "admin.export.read",
  "admin.operations.read",
  "workload.token.revoke",
  "recovery.drill",
  "security.incident.create",
  "security.incident.isolate",
  "security.incident.resolve",
  "studio.access",
  "skill.read",
  "skill.write",
  "policy.read",
  "policy.write",
  "user.manage",
  "agent.read",
  "workspace.read",
  "workspace.write",
  "analytics.read",
  "audit.read",
  "brand.manage",
];
const ADMIN_GRANTS: RoleTemplateGrant[] = ADMIN_ACTIONS.flatMap((actionCode) =>
  ACTION_RESOURCE_TYPES[actionCode].map((type) => ({
    actionCode,
    resourceScope: { type, wildcard: true },
  })),
);
const MEMBER_GRANTS: RoleTemplateGrant[] = [
  { actionCode: "thread.read", resourceScope: self() },
  { actionCode: "thread.write", resourceScope: self() },
];
const BUILDER_GRANTS: RoleTemplateGrant[] = [
  { actionCode: "studio.access", resourceScope: tenant() },
  { actionCode: "agent.read", resourceScope: tenant() },
  { actionCode: "agent.contract.register", resourceScope: { type: "agent", wildcard: true } },
  { actionCode: "skill.create", resourceScope: tenant() },
];
const AUDITOR_GRANTS: RoleTemplateGrant[] = [
  { actionCode: "studio.access", resourceScope: tenant() },
  { actionCode: "audit.read", resourceScope: tenant() },
];
export const ROLE_TEMPLATES: RoleTemplate[] = [
  { key: "admin", name: "平台管理员", isSystem: true, grants: ADMIN_GRANTS },
  { key: "member", name: "普通员工", isSystem: true, grants: MEMBER_GRANTS },
  { key: "builder", name: "资产维护者", isSystem: true, grants: BUILDER_GRANTS },
  { key: "auditor", name: "审计查看者", isSystem: true, grants: AUDITOR_GRANTS },
];

const TEMPLATE_KEYS: ReadonlySet<string> = new Set(ROLE_TEMPLATES.map((t) => t.key));

/** 判断 key 是否为已知角色模板。 */
export function isRoleTemplateKey(key: string): key is RoleTemplateKey {
  return TEMPLATE_KEYS.has(key);
}

/** 取模板（未知 key → undefined）。 */
export function getRoleTemplate(key: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.key === key);
}

/** 一组模板 key → 并集 grant（去重：同 actionCode+scope 只保留一份）。 */
export function grantsForTemplates(keys: readonly string[]): RoleTemplateGrant[] {
  const seen = new Set<string>();
  const out: RoleTemplateGrant[] = [];
  for (const key of keys) {
    const tpl = getRoleTemplate(key);
    if (!tpl) continue;
    for (const g of tpl.grants) {
      const sig = grantSignature(g.actionCode, g.resourceScope);
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(g);
    }
  }
  return out;
}

/** 模板的去重 action 码列表（client 只读展示用）。 */
export function templateActions(tpl: RoleTemplate): ActionCode[] {
  const seen = new Set<string>();
  const out: ActionCode[] = [];
  for (const g of tpl.grants) {
    if (seen.has(g.actionCode)) continue;
    seen.add(g.actionCode);
    out.push(g.actionCode);
  }
  return out;
}

/** 单条 grant 的稳定签名（actionCode + 序列化 scope），用于与用户既有 grant 匹配。 */
export function grantSignature(actionCode: string, scope: ResourceScope): string {
  return `${actionCode}|${serializeResourceScope(scope)}`;
}

export type { ActionCode, ResourceScope };
