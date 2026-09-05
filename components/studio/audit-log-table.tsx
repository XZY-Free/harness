import { Badge } from "@/components/ui/badge";
import type { AuditActionType } from "@/lib/persistence/schema/audit";
import type { StudioAuditRow } from "@/lib/studio/admin-audit";
import { CheckCircle2, CircleMinus, CircleX, ScrollText } from "lucide-react";

type Props = { logs: StudioAuditRow[] };

/** 审计动作只展示面向管理员的中文名称，未知动作不回显内部常量。 */
const ACTION_LABEL: Record<AuditActionType, string> = {
  "agent.contract.register": "智能体合同登记",
  "agent.revision.create": "智能体版本创建",
  "agent.publish": "智能体发布",
  "agent.retract": "智能体撤回",
  "route.update": "路由更新",
  "route.revision.create": "路由版本创建",
  "runtime.publish": "运行服务发布",
  "runtime.retract": "运行服务撤回",
  "tool.schema.publish": "工具定义发布",
  "policy.publish": "策略发布",
  "governance.config.publish": "治理配置发布",
  "credential.bind": "凭证绑定",
  "credential.revoke": "凭证撤销",
  "memory.review": "记忆审核",
  "job.cancel": "任务取消",
  "job.retry": "任务重试",
  "event.quarantine.resolve": "隔离事件处理",
  "artifact.attestation.verify": "产物证明校验",
  "artifact.attestation.revoke": "产物证明撤销",
  "legal_hold.manage": "法务保留管理",
  "deletion.request": "删除请求",
  "audit.export": "操作记录导出",
  "admin.export.requested": "数据导出申请",
  "admin.export.completed": "数据导出完成",
  "admin.export.failed": "数据导出失败",
  "admin.export.downloaded": "数据导出下载",
  "diagnostic.view": "诊断信息查看",
  "audit.read": "操作记录查看",
  "workload.token.revoked": "运行凭证撤销",
  "recovery.drill": "恢复演练",
  "security.incident": "安全事件处理",
  "settings.user_roles.updated": "用户角色更新",
  "policies.updated": "策略更新",
  "skills.published": "技能发布",
  "skills.rolled_back": "技能回滚",
  "skills.created": "技能创建",
  "skills.updated": "技能更新",
  "skills.deleted": "技能删除",
  "skills.matched": "技能匹配",
  "skills.synced": "技能同步",
  "skills.unsynced": "技能取消同步",
  "workspace.file.written": "工作区文件写入",
  "workspace.file.deleted": "工作区文件删除",
  "tool.high_risk.executed": "高风险工具执行",
  "permission_rule.created": "权限规则创建",
  "permission_rule.updated": "权限规则更新",
  "permission_rule.deleted": "权限规则删除",
  "thread.purged": "会话清理",
  "approval.resolved": "审批处理",
  "enterprise.user_profile.created": "企业用户资料建立",
  "enterprise.user_profile.changed": "企业用户资料变更",
  "enterprise.user_profile.sync_failed": "企业用户资料同步失败",
  "enterprise.user_profile.fresh": "企业用户资料恢复新鲜",
  "enterprise.user.disabled": "企业用户停用",
  "capability.action.execute": "运行能力调用",
  "invocation.continuation.dead_letter": "执行续跑转人工处理",
};

function actionLabel(actionType: string): string {
  if (!Object.hasOwn(ACTION_LABEL, actionType)) return "其他操作";
  return ACTION_LABEL[actionType as AuditActionType];
}

const TARGET_TYPE_LABEL: Record<string, string> = {
  agent: "智能体",
  agent_call: "智能体调用",
  agent_revision: "智能体版本",
  approval: "审批",
  artifact: "产物",
  artifact_attestation: "产物证明",
  credential: "凭证",
  deletion_request: "删除请求",
  deployment_route: "部署路由",
  event: "事件",
  governance: "治理配置",
  governance_config: "治理配置",
  job: "后台任务",
  legal_hold: "法务保留",
  memory: "记忆",
  permission_rule: "权限规则",
  user: "用户",
  user_identity: "用户身份",
  policy: "策略",
  skill: "技能",
  projection: "事件投影",
  recovery_drill: "恢复演练",
  retention_policy: "保留策略",
  route: "路由",
  runtime: "运行服务",
  runtime_conformance_run: "运行服务验证",
  runtime_revision: "运行服务版本",
  security_incident: "安全事件",
  tenant: "租户",
  thread: "会话",
  tool: "工具",
  workload_token: "运行凭证",
  workspace: "工作区",
};

const ACTOR_TYPE_LABEL: Record<StudioAuditRow["actorType"], string> = {
  user: "用户",
  service: "服务账号",
  workload: "运行实例",
  system: "系统",
};

const CHANGE_FIELD_LABEL: Record<string, string> = {
  roleIds: "角色权限",
  protectedPaths: "受保护路径",
  name: "名称",
  versionId: "当前版本",
  lifecycleState: "启用状态",
};

const REASON_LABEL: Record<string, string> = {
  manual_update: "手动更新",
  version_not_found: "版本不存在",
  invalid_roles: "角色配置无效",
  self_lockout: "不能移除自己的管理权限",
  last_manager: "必须保留至少一名管理员",
  audit_failed: "操作记录写入失败",
};

const ROLE_LABEL: Record<string, string> = {
  admin: "管理员",
  member: "成员",
  auditor: "审计员",
};

const NUMBER_FORMATTER = new Intl.NumberFormat("zh-CN");
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function fmtTime(value: Date): { dateTime: string; label: string } {
  const date = value instanceof Date ? value : new Date(value);
  const dateTime = date.toISOString();
  return {
    dateTime,
    label: TIME_FORMATTER.format(date),
  };
}

function shortIdentifier(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 9)}…${value.slice(-4)}`;
}

function translatedList(
  value: unknown,
  labels: Record<string, string>,
  unknownLabel: string,
): string {
  const values = Array.isArray(value) ? value : [value];
  const translated = values.map((item) =>
    typeof item === "string" ? (labels[item] ?? unknownLabel) : unknownLabel,
  );
  return Array.from(new Set(translated)).join("、") || "无";
}

function safeNumber(value: unknown, suffix = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${NUMBER_FORMATTER.format(value)}${suffix}`
    : "已记录";
}

function safeVersion(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `第 ${NUMBER_FORMATTER.format(value)} 版`;
  }
  if (typeof value === "string" && /^\d+(?:\.\d+)*$/.test(value)) return `第 ${value} 版`;
  return "已记录";
}

const METADATA_FORMATTERS: Record<string, { label: string; format: (value: unknown) => string }> = {
  changedKeys: {
    label: "变更项",
    format: (value) => translatedList(value, CHANGE_FIELD_LABEL, "其他变更"),
  },
  keys: {
    label: "涉及项",
    format: (value) => translatedList(value, CHANGE_FIELD_LABEL, "其他信息"),
  },
  reasonCode: {
    label: "原因",
    format: (value) => (typeof value === "string" ? (REASON_LABEL[value] ?? "其他原因") : "已记录"),
  },
  roleIds: {
    label: "角色",
    format: (value) => translatedList(value, ROLE_LABEL, "其他角色"),
  },
  roleIdsBefore: {
    label: "原角色",
    format: (value) => translatedList(value, ROLE_LABEL, "其他角色"),
  },
  roleIdsAfter: {
    label: "新角色",
    format: (value) => translatedList(value, ROLE_LABEL, "其他角色"),
  },
  bytes: { label: "文件大小", format: (value) => safeNumber(value, " 字节") },
  count: { label: "数量", format: (value) => safeNumber(value) },
  imported: { label: "新增", format: (value) => safeNumber(value) },
  updated: { label: "更新", format: (value) => safeNumber(value) },
  uptodate: { label: "无需更新", format: (value) => safeNumber(value) },
  conflict: { label: "冲突", format: (value) => safeNumber(value) },
  blocked: { label: "已阻止", format: (value) => safeNumber(value) },
  failed: { label: "失败", format: (value) => safeNumber(value) },
  missing: { label: "缺失", format: (value) => safeNumber(value) },
  revision: { label: "版本", format: safeVersion },
  version: { label: "版本", format: safeVersion },
  path: { label: "文件位置", format: () => "已记录" },
  name: { label: "名称", format: () => "已记录" },
  targetEmail: { label: "目标用户", format: () => "已记录" },
  versionId: { label: "版本标识", format: () => "已记录" },
  commitSha: { label: "提交版本", format: () => "已记录" },
  remoteAssetId: { label: "来源资源", format: () => "已记录" },
  error: { label: "错误信息", format: () => "已记录" },
};

function metadataChips(metadata: unknown): Array<{ key: string; label: string; value: string }> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const chips: Array<{ key: string; label: string; value: string }> = [];
  let hasUnknown = false;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    const formatter = METADATA_FORMATTERS[key];
    if (!formatter) {
      hasUnknown = true;
      continue;
    }
    chips.push({ key, label: formatter.label, value: formatter.format(value) });
  }
  if (!hasUnknown) return chips.slice(0, 5);
  return [...chips.slice(0, 4), { key: "other", label: "其他信息", value: "已记录" }];
}

function OutcomeBadge({ outcome }: { outcome: StudioAuditRow["outcome"] }) {
  if (outcome === "succeeded") {
    return (
      <Badge variant="outline" className="border-success/20 bg-success/10 text-success">
        <CheckCircle2 data-icon="inline-start" aria-hidden="true" />
        成功
      </Badge>
    );
  }
  if (outcome === "failed") {
    return (
      <Badge variant="outline" className="border-destructive/20 bg-destructive/10 text-destructive">
        <CircleX data-icon="inline-start" aria-hidden="true" />
        失败
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="bg-muted text-muted-foreground">
      <CircleMinus data-icon="inline-start" aria-hidden="true" />
      未记录
    </Badge>
  );
}

/** 只读审计投影。没有编辑、删除或重放入口，写语义仍由服务端审计账本掌管。 */
export function AuditLogTable({ logs }: Props) {
  if (logs.length === 0) {
    return (
      <div
        // biome-ignore lint/a11y/useSemanticElements: 空状态需要容纳块级布局并作为实时状态播报。
        role="status"
        className="rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center"
      >
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <ScrollText className="size-4" aria-hidden="true" />
        </span>
        <p className="mt-4 text-sm font-medium text-foreground">暂无操作记录</p>
        <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
          新的后台敏感操作会显示在这里。所有记录均为只读，不能在此修改或删除。
        </p>
      </div>
    );
  }

  return (
    <section
      data-slot="audit-log-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向审计表必须能由键盘聚焦并滚动。
      tabIndex={0}
      aria-label="审计表格，可横向滚动"
      className="overflow-x-auto overscroll-x-contain rounded-2xl border border-border bg-card shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <table aria-label="审计操作记录" className="min-w-4xl w-full border-collapse text-sm">
        <caption className="sr-only">最近的后台审计操作，记录只读。</caption>
        <thead className="bg-muted/70 text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-44 px-4 py-3 text-left font-medium">
              发生时间
            </th>
            <th scope="col" className="w-48 px-4 py-3 text-left font-medium">
              操作者
            </th>
            <th scope="col" className="w-44 px-4 py-3 text-left font-medium">
              操作
            </th>
            <th scope="col" className="w-48 px-4 py-3 text-left font-medium">
              操作对象
            </th>
            <th scope="col" className="w-28 px-4 py-3 text-left font-medium">
              执行结果
            </th>
            <th scope="col" className="min-w-72 px-4 py-3 text-left font-medium">
              变更摘要
            </th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const time = fmtTime(log.occurredAt);
            const chips = metadataChips(log.metadataRedacted);
            const targetLabel = TARGET_TYPE_LABEL[log.targetType] ?? "其他资源";
            const actorLabel =
              log.actorName ?? log.actorEmail ?? ACTOR_TYPE_LABEL[log.actorType] ?? "未知操作者";
            const actorDetail = log.actorName && log.actorEmail ? log.actorEmail : null;

            return (
              <tr
                key={log.id}
                className="border-t border-border align-top transition-colors hover:bg-muted/30"
              >
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  <time dateTime={time.dateTime} className="whitespace-nowrap tabular-nums">
                    {time.label}
                  </time>
                </td>
                <td className="px-4 py-3">
                  <span className="block font-medium text-foreground">{actorLabel}</span>
                  {actorDetail && (
                    <span className="mt-0.5 block max-w-44 truncate text-xs text-muted-foreground">
                      {actorDetail}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 font-medium text-foreground">
                  {actionLabel(log.actionType)}
                </td>
                <td className="px-4 py-3">
                  <span className="block text-foreground">{targetLabel}</span>
                  {log.targetId && (
                    <span className="mt-0.5 block max-w-44 truncate text-xs text-muted-foreground">
                      编号 {shortIdentifier(log.targetId)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <OutcomeBadge outcome={log.outcome} />
                </td>
                <td className="px-4 py-3">
                  {chips.length === 0 ? (
                    <span className="text-sm text-muted-foreground">无补充信息</span>
                  ) : (
                    <div className="flex max-w-xl flex-wrap gap-1.5">
                      {chips.map((chip) => (
                        <span
                          key={chip.key}
                          className="inline-flex max-w-64 items-center gap-1.5 rounded-lg bg-muted px-2 py-1 text-xs"
                        >
                          <span className="shrink-0 text-muted-foreground">{chip.label}</span>
                          <span className="truncate text-foreground">{chip.value}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
