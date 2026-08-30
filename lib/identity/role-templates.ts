/**
 * 角色模板（grant 化的角色语义）。
 *
 * 关口02 02-2c：把旧 RBAC 的 MEMBER_PERMISSIONS / ADMIN_PERMISSIONS（lib/rbac.ts）
 * 映射为「角色模板 = 动作码集」的常量。正式身份模型没有「角色表」——用户权限 =
 * 直接挂在 principalBinding 上的 roleActionBinding（grant）。写入时把所选模板的
 * grant 集并集物化为 roleActionBinding；读回时按「模板 grant 全集是否被用户 grant
 * 覆盖」推导用户所属模板（见 lib/identity/settings-queries.ts 的 deriveTemplateKeys）。
 *
 * 旧权限字符串 → 正式 Action Code + Resource Scope 解码：
 * - `.all`（thread.read.all / analytics.read.global 等）→ (tenant, wildcard)。
 * - `.self`（thread.write.self / analytics.read.self）→ (self, wildcard)。
 * - ADMIN = Studio 动作码全量；其中 thread.read/thread.write 给 tenant + self
 *   双态（默认用户要能过 requireStudioAction(…, {type:"self"}) 门禁，而 tenant grant
 *   不覆盖 self 请求资源——scopeCovers 要求 type 相同）。
 * - MEMBER 仅基础动作，thread.read/thread.write 仅 self 态（member 只能操作自己的 thread）。
 */
import type { ActionCode } from "@/lib/identity/action-codes";
import { type ResourceScope, serializeResourceScope } from "@/lib/identity/resource-scope";

export type RoleTemplateKey = "admin" | "member";

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

/** ADMIN：Studio 动作码全量；thread 双态（tenant + self）。 */
const ADMIN_GRANTS: RoleTemplateGrant[] = [
  { actionCode: "studio.access", resourceScope: tenant() },
  { actionCode: "skill.read", resourceScope: tenant() },
  { actionCode: "skill.write", resourceScope: tenant() },
  { actionCode: "thread.read", resourceScope: tenant() },
  { actionCode: "thread.read", resourceScope: self() },
  { actionCode: "thread.write", resourceScope: tenant() },
  { actionCode: "thread.write", resourceScope: self() },
  { actionCode: "policy.read", resourceScope: tenant() },
  { actionCode: "policy.write", resourceScope: tenant() },
  { actionCode: "user.manage", resourceScope: tenant() },
  { actionCode: "agent.read", resourceScope: tenant() },
  { actionCode: "agent.invoke", resourceScope: tenant() },
  { actionCode: "workspace.read", resourceScope: tenant() },
  { actionCode: "workspace.write", resourceScope: tenant() },
  { actionCode: "analytics.read", resourceScope: tenant() },
  { actionCode: "audit.read", resourceScope: tenant() },
];

/** MEMBER：基础动作；thread 仅 self 态。 */
const MEMBER_GRANTS: RoleTemplateGrant[] = [
  { actionCode: "studio.access", resourceScope: tenant() },
  { actionCode: "skill.read", resourceScope: tenant() },
  { actionCode: "thread.read", resourceScope: self() },
  { actionCode: "thread.write", resourceScope: self() },
  { actionCode: "policy.read", resourceScope: tenant() },
  { actionCode: "agent.read", resourceScope: tenant() },
  { actionCode: "agent.invoke", resourceScope: tenant() },
  { actionCode: "workspace.read", resourceScope: tenant() },
  { actionCode: "analytics.read", resourceScope: tenant() },
];

/** 系统角色模板集合（顺序即展示顺序）。 */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  { key: "admin", name: "Admin", isSystem: true, grants: ADMIN_GRANTS },
  { key: "member", name: "Member", isSystem: true, grants: MEMBER_GRANTS },
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
