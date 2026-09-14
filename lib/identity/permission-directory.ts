import { ACTION_CODES, ACTION_RESOURCE_TYPES, type ActionCode } from "./action-codes";
import { assertActionResourceTypeMatch } from "./action-codes";
import { type ResourceScope, validateResourceScope } from "./resource-scope";

export interface PermissionGrant {
  actionCode: ActionCode;
  resourceScope: ResourceScope;
  validFrom?: string;
  validUntil?: string;
}
const domains: Record<string, string> = {
  agent: "智能体",
  skill: "技能",
  studio: "后台",
  user: "成员与权限",
  thread: "会话",
  policy: "工具策略",
  audit: "审计",
  workspace: "工作区",
  knowledge: "知识",
  runtime: "运行时",
  tool: "工具",
  connection: "连接",
  credential: "凭证",
  brand: "品牌",
  analytics: "数据分析",
  route: "路由",
  governance: "治理",
  admin: "管理",
  memory: "记忆",
  job: "任务",
};
const verbs: Record<string, string> = {
  access: "访问",
  read: "查看",
  write: "编辑",
  create: "创建",
  update: "编辑",
  publish: "发布",
  retract: "撤回",
  invoke: "使用",
  manage: "管理",
  export: "导出",
  delete: "删除",
  cancel: "取消",
  retry: "重试",
  register: "注册",
  bind: "绑定",
  revoke: "撤销",
  review: "审核",
  download: "下载",
};
const actionLabels: Partial<Record<ActionCode, string>> = {
  "agent.contract.register": "注册智能体",
  "agent.revision.create": "创建智能体版本",
  "tool.schema.publish": "发布工具结构",
  "tool.provider.create": "创建工具提供方",
  "tool.provider.update": "编辑工具提供方",
  "tool.create": "创建工具",
  "tool.update": "编辑工具",
  "skill.version.create": "创建技能版本",
  "skill.write": "管理技能内容",
  "knowledge.base.create": "创建知识库",
  "knowledge.base.update": "编辑知识库",
  "knowledge.base.archive": "归档知识库",
  "knowledge.document.create": "创建知识文档",
  "knowledge.document.publish": "发布知识文档",
  "knowledge.document.retract": "撤回知识文档",
  "admin.export.create": "创建导出任务",
  "admin.export.read": "查看导出任务",
  "admin.export.download": "下载导出文件",
  "admin.operations.read": "查看平台运营",
  "event.quarantine.resolve": "处理隔离事件",
  "artifact.attestation.verify": "核验制品证明",
  "artifact.attestation.revoke": "撤销制品证明",
  "legal_hold.manage": "管理法律保留",
  "deletion.request": "提交数据删除请求",
  "capability.review": "审核能力",
  "workload.token.revoke": "撤销运行凭据",
  "recovery.drill": "执行恢复演练",
  "security.incident.create": "创建安全事件",
  "security.incident.isolate": "隔离安全事件",
  "security.incident.resolve": "处理安全事件",
};
export const PERMISSION_DIRECTORY = ACTION_CODES.filter(
  (code) =>
    !["admin.export.requested", "admin.export.completed", "admin.export.failed"].includes(code),
).map((code) => ({
  code,
  domain: domains[code.split(".")[0] ?? ""] ?? "平台运行",
  label:
    actionLabels[code] ??
    `${domains[(code.split(".")[0] ?? "")] ?? code.split(".")[0]} · ${verbs[(code.split(".").at(-1) ?? "")] ?? code.split(".").slice(1).join(" / ")}`,
  scopeTypes: ACTION_RESOURCE_TYPES[code],
}));
export function parsePermissionGrants(value: unknown): PermissionGrant[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("权限列表无效");
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      !PERMISSION_DIRECTORY.some((p) => p.code === item.actionCode)
    )
      throw new Error("未知权限动作");
    const resourceScope = validateResourceScope(item.resourceScope);
    assertActionResourceTypeMatch(item.actionCode, resourceScope.type);
    for (const key of ["validFrom", "validUntil"]) {
      if (
        item[key] !== undefined &&
        (typeof item[key] !== "string" || !Number.isFinite(Date.parse(item[key])))
      )
        throw new Error("权限有效期无效");
    }
    return {
      actionCode: item.actionCode,
      resourceScope,
      ...(item.validFrom ? { validFrom: new Date(item.validFrom).toISOString() } : {}),
      ...(item.validUntil ? { validUntil: new Date(item.validUntil).toISOString() } : {}),
    };
  });
}

export function isPermissionGrantActive(grant: PermissionGrant, now = new Date()): boolean {
  return (
    (!grant.validFrom || Date.parse(grant.validFrom) <= now.getTime()) &&
    (!grant.validUntil || Date.parse(grant.validUntil) > now.getTime())
  );
}
