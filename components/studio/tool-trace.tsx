import { TOOL_ICON } from "@/components/icons";
import type { ToolRun } from "@/lib/db/schema";

/**
 * Phase 4-4 Stage D：tool 执行 trace（只读）。
 * 渲染 tool_runs 序列（工具名 / 状态 / 耗时 / 错误摘要），按 startedAt 升序。
 */

function statusTone(status: string): string {
  if (status === "succeeded") return "text-[var(--ok)]";
  if (status === "failed") return "text-[var(--danger)]";
  return "text-[var(--primary)]";
}

function durationMs(run: ToolRun): number | null {
  if (!run.finishedAt) return null;
  return run.finishedAt.getTime() - run.startedAt.getTime();
}

function fmtDur(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolTrace({ toolRuns }: { toolRuns: ToolRun[] }) {
  if (toolRuns.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">无工具执行记录。</div>;
  }
  return (
    <ol className="flex flex-col gap-1.5">
      {toolRuns.map((r) => {
        const Icon = TOOL_ICON[r.toolName];
        const err =
          typeof r.error === "string" && r.error.length > 0 ? r.error.slice(0, 120) : null;
        return (
          <li
            key={r.id}
            className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px]"
          >
            <span className="shrink-0 text-[var(--fg-subtle)]">
              {Icon ? <Icon size={15} /> : null}
            </span>
            <span className="w-28 shrink-0 font-medium text-[var(--fg)]">{r.toolName}</span>
            <span className={`w-20 shrink-0 ${statusTone(r.status)}`}>{r.status}</span>
            <span className="w-20 shrink-0 text-[var(--fg-subtle)]">{fmtDur(durationMs(r))}</span>
            <span className="flex-1 text-[var(--fg-muted)]">{err ?? "—"}</span>
          </li>
        );
      })}
    </ol>
  );
}
