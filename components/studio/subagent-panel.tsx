"use client";

import { useThreadEvents } from "@/components/hooks/use-thread-events";
import { subagentStatusLabel, t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

/**
 * V3.5 Stage E：Studio 子代理可观测面板（client，只读）。
 *
 * 列出当前 thread 的 SubagentRun（role/goal/status/resultSummary/transcriptPath/时间）。
 * 空状态「当前 thread 无子代理」。
 *
 * 12-P1-3：改为 SSE 事件驱动刷新——订阅 subagent.spawned/joined/failed 事件，
 * 收到事件后调 refresh() 拉最新数据。SSE 断线时 useThreadEvents 自动降级轮询。
 */

type Subagent = {
  id: string;
  definitionId: string;
  goal: string;
  status: string;
  writeScope: string[] | null;
  resultSummary: string | null;
  outputArtifactId: string | null;
  transcriptPath: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

const STATUS_TONE: Record<string, string> = {
  queued: "text-[var(--fg-muted)]",
  running: "text-[var(--ok)]",
  completed: "text-[var(--ok)]",
  failed: "text-[var(--danger)]",
  cancelled: "text-[var(--fg-muted)]",
  timed_out: "text-[var(--warn)]",
};

export function SubagentPanel({ threadId }: { threadId: string }) {
  const [subagents, setSubagents] = useState<Subagent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/subagents`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { subagents: Subagent[] } };
      setSubagents(body.data?.subagents ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 12-P1-3：SSE 事件驱动刷新——收到 subagent 相关事件或降级轮询通知时 refresh
  useThreadEvents({
    threadId,
    onEvent: (ev) => {
      if (
        ev.type === "subagent.spawned" ||
        ev.type === "subagent.joined" ||
        ev.type === "subagent.failed" ||
        ev.type === "__fallback__"
      ) {
        void refresh();
      }
    },
  });

  // S1（04-G15）：取消活跃子代理 run
  const cancel = useCallback(
    async (runId: string) => {
      setCancelling(runId);
      try {
        const res = await fetch(`/studio/api/threads/${threadId}/subagents/${runId}/cancel`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "取消失败");
      } finally {
        setCancelling(null);
      }
    },
    [threadId, refresh],
  );

  if (loading) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.subagent.loading")}</div>;
  }
  if (error) {
    return (
      <div className="text-[13px] text-[var(--danger)]">
        {t("studio.subagent.load_failed", { error })}
      </div>
    );
  }
  if (subagents.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.subagent.empty")}</div>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {subagents.map((s) => (
        <li
          key={s.id}
          className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px]"
        >
          <div className="flex items-center gap-2">
            <span className={`font-medium ${STATUS_TONE[s.status] ?? "text-[var(--fg)]"}`}>
              {subagentStatusLabel(s.status)}
            </span>
            <span className="text-[var(--fg-subtle)]">{s.id.slice(0, 8)}</span>
            {s.writeScope && s.writeScope.length > 0 && (
              <span className="text-[12px] text-[var(--warn)]">
                {t("studio.subagent.write_scope")}: {s.writeScope.join(",")}
              </span>
            )}
          </div>
          <div className="mt-1 text-[var(--fg-muted)]">
            {t("studio.subagent.goal")}: {s.goal}
          </div>
          {s.resultSummary && (
            <div className="mt-1 text-[var(--fg)]">
              {t("studio.subagent.result")}: {s.resultSummary}
            </div>
          )}
          {s.errorMessage && (
            <div className="mt-1 text-[var(--danger)]">
              {t("studio.subagent.error")}: {s.errorMessage}
            </div>
          )}
          {(s.status === "queued" || s.status === "running") && (
            <button
              type="button"
              onClick={() => void cancel(s.id)}
              disabled={cancelling === s.id}
              className="mt-2 rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-0.5 text-[12px] text-[var(--danger)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
            >
              {cancelling === s.id ? t("studio.subagent.cancelling") : t("studio.subagent.cancel")}
            </button>
          )}
          {s.transcriptPath && (
            <div className="mt-1 text-[12px] text-[var(--fg-subtle)]">
              {t("studio.subagent.transcript")}: {s.transcriptPath}
            </div>
          )}
          <div className="mt-1 text-[12px] text-[var(--fg-subtle)]">
            {t("studio.subagent.created")}: {new Date(s.createdAt).toLocaleString()}
            {s.finishedAt &&
              ` · ${t("studio.subagent.finished")}: ${new Date(s.finishedAt).toLocaleString()}`}
          </div>
        </li>
      ))}
    </ul>
  );
}
