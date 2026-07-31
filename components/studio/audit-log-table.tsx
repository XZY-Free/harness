import type { AuditLogRow } from "@/lib/db/queries";

/**
 * 审计日志密集表（Phase 4-4 切片 C）。
 *
 * server component 接收已加载的 AuditLogRow[]（含操作者名），渲染 time / actor / action /
 * target / outcome / metadata 摘要。metadata 用紧凑 key:value chips 展示，由 React 文本节点
 * 自动转义；不渲染原始大 JSON 块。审计只读 append-only，本组件不含任何写操作。
 */
type Props = { logs: AuditLogRow[] };

/** 动作常量 → 中文标签（未知 action 原样回退）。 */
const ACTION_LABEL: Record<string, string> = {
  "settings.user_roles.updated": "用户角色更新",
  "policies.updated": "策略更新",
  "skills.published": "技能发布",
  "skills.rolled_back": "技能回滚",
  "skills.created": "技能创建",
  "skills.updated": "技能更新",
  "skills.deleted": "技能删除",
  "workspace.file.written": "工作区文件写入",
  "workspace.file.deleted": "工作区文件删除",
};

/** 结果 → 中文标签。 */
const OUTCOME_LABEL: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
};

/** 目标资源类型 → 中文标签。 */
const TARGET_TYPE_LABEL: Record<string, string> = {
  user: "用户",
  policy: "策略",
  skill: "技能",
  workspace: "工作区",
};

function outcomeTone(outcome: AuditLogRow["outcome"]): string {
  return outcome === "succeeded" ? "text-[var(--ok)]" : "text-[var(--danger)]";
}

function fmtTime(d: Date): string {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().replace("T", " ").replace(/\..+/, "");
}

/** metadata 紧凑摘要：取前若干 key 渲染为 chip，超长截断。 */
function metadataChips(metadata: unknown): Array<{ k: string; v: string }> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const entries = Object.entries(metadata as Record<string, unknown>).slice(0, 6);
  return entries.map(([k, v]) => ({
    k,
    v: typeof v === "string" ? v : JSON.stringify(v),
  }));
}

export function AuditLogTable({ logs }: Props) {
  if (logs.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px] text-[var(--fg-muted)]">
        暂无审计记录。
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-[13px]">
        <thead className="bg-[var(--surface-2)] text-[var(--fg-subtle)]">
          <tr>
            <th className="px-3 py-2 text-left font-medium">时间</th>
            <th className="px-3 py-2 text-left font-medium">操作者</th>
            <th className="px-3 py-2 text-left font-medium">动作</th>
            <th className="px-3 py-2 text-left font-medium">目标</th>
            <th className="px-3 py-2 text-left font-medium">结果</th>
            <th className="px-3 py-2 text-left font-medium">摘要</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => {
            const chips = metadataChips(log.metadata);
            const targetLabel = TARGET_TYPE_LABEL[log.targetType] ?? log.targetType;
            return (
              <tr key={log.id} className="border-t border-[var(--border)] align-top">
                <td className="px-3 py-2 font-mono text-[12px] text-[var(--fg-muted)]">
                  {fmtTime(log.createdAt)}
                </td>
                <td className="px-3 py-2 text-[var(--fg-muted)]">
                  {log.actorName ?? log.actorEmail ?? (
                    <span className="font-mono text-[12px]">{log.actorUserId.slice(0, 8)}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[var(--fg)]">
                  {ACTION_LABEL[log.action] ?? log.action}
                </td>
                <td className="px-3 py-2 font-mono text-[12px] text-[var(--fg-muted)]">
                  {targetLabel}:{log.targetId}
                </td>
                <td className={`px-3 py-2 font-medium ${outcomeTone(log.outcome)}`}>
                  {OUTCOME_LABEL[log.outcome] ?? log.outcome}
                </td>
                <td className="px-3 py-2">
                  {chips.length === 0 ? (
                    <span className="text-[var(--fg-subtle)]">—</span>
                  ) : (
                    <div className="flex max-w-[420px] flex-wrap gap-1">
                      {chips.map((c) => (
                        <span
                          key={c.k}
                          className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--fg-muted)]"
                        >
                          <span className="text-[var(--fg-subtle)]">{c.k}</span>
                          <span className="max-w-[180px] truncate text-[var(--fg)]">{c.v}</span>
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
    </div>
  );
}
