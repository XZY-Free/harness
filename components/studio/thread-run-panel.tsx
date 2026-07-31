import type { ThreadRun, ThreadRunSkill } from "@/lib/db/schema";

/**
 * V7 S4-2：ThreadRun 详情面板。
 * 展示单次执行的完整信息：状态、模型、token 用量、时间、错误等。
 * V8 阶段 7：新增 run 级 selected SkillVersions 展示（替代旧 run.skillId 单字段）。
 */

function statusTone(status: string): string {
  if (status === "completed") return "text-[var(--ok)]";
  if (status === "failed" || status === "cancelled" || status === "stale")
    return "text-[var(--danger)]";
  if (status === "running" || status === "awaiting_approval") return "text-[var(--primary)]";
  return "text-[var(--fg-muted)]";
}

function durationMs(run: ThreadRun): number | null {
  if (!run.finishedAt || !run.startedAt) return null;
  return run.finishedAt.getTime() - run.startedAt.getTime();
}

function fmtDur(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ThreadRunPanel({
  run,
  runSkills = [],
}: {
  run: ThreadRun;
  /** V8 阶段 7：run 级 selected SkillVersions（来自 getRunDetail.runSkills）。 */
  runSkills?: ThreadRunSkill[];
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 text-[13px]">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-medium text-[var(--fg)]">执行详情</h2>
        <span className={`font-medium ${statusTone(run.status)}`}>{run.status}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[var(--fg-muted)]">
        <div>
          <span className="text-[var(--fg-subtle)]">Run ID:</span>{" "}
          <span className="font-mono text-[12px]">{run.id.slice(0, 8)}</span>
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">模型:</span> {run.model}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">触发:</span> {run.triggerType}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">耗时:</span> {fmtDur(durationMs(run))}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">输入 token:</span> {run.promptTokens}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">输出 token:</span> {run.completionTokens}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">总 token:</span> {run.totalTokens}
        </div>
        <div>
          <span className="text-[var(--fg-subtle)]">创建:</span>{" "}
          {new Date(run.createdAt).toLocaleString()}
        </div>
        {run.startedAt && (
          <div>
            <span className="text-[var(--fg-subtle)]">开始:</span>{" "}
            {new Date(run.startedAt).toLocaleString()}
          </div>
        )}
        {run.finishedAt && (
          <div>
            <span className="text-[var(--fg-subtle)]">结束:</span>{" "}
            {new Date(run.finishedAt).toLocaleString()}
          </div>
        )}
        {run.lastSeenAt && (
          <div>
            <span className="text-[var(--fg-subtle)]">心跳:</span>{" "}
            {new Date(run.lastSeenAt).toLocaleString()}
          </div>
        )}
        {/* V8 阶段 7：展示 run 级 selected SkillVersions（替代旧 run.skillId 单字段） */}
        <div className="col-span-2">
          <span className="text-[var(--fg-subtle)]">Skill:</span>{" "}
          {runSkills.length === 0 ? (
            <span className="text-[var(--fg-subtle)]">基础 agent（未使用 Skill）</span>
          ) : (
            <div className="mt-1 flex flex-col gap-1">
              {runSkills.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-[12px]">
                  <span className="font-mono text-[var(--fg-muted)]">{s.skillId.slice(0, 8)}</span>
                  <span className="text-[var(--fg-subtle)]">v{s.skillVersionId.slice(0, 8)}</span>
                  <span className="rounded-[var(--radius-sm)] bg-[var(--surface-alt)] px-1.5 py-0.5 text-[11px] text-[var(--fg-subtle)]">
                    {s.role}
                  </span>
                  <span className="text-[var(--fg-subtle)]">({s.source})</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {run.runtimeType && (
          <div>
            <span className="text-[var(--fg-subtle)]">运行时:</span> {run.runtimeType}
          </div>
        )}
      </div>

      {run.error && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3">
          <div className="text-[12px] font-medium text-[var(--danger)]">错误</div>
          <pre className="mt-1 overflow-auto text-[12px] text-[var(--fg-muted)]">{run.error}</pre>
        </div>
      )}

      {run.cancelReason && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--primary)] bg-[var(--accent-soft)] p-3">
          <div className="text-[12px] font-medium text-[var(--primary)]">取消原因</div>
          <pre className="mt-1 overflow-auto text-[12px] text-[var(--fg-muted)]">
            {run.cancelReason}
          </pre>
        </div>
      )}

      {run.metadata != null && (
        <details className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
          <summary className="cursor-pointer text-[12px] font-medium text-[var(--fg-subtle)]">
            元数据
          </summary>
          <pre className="mt-2 overflow-auto text-[12px] text-[var(--fg-muted)]">
            {JSON.stringify(run.metadata as Record<string, unknown>, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
