"use client";

import { useThreadEvents } from "@/components/hooks/use-thread-events";
import { t } from "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";

/**
 * V3.2 Stage E：Studio 后台任务面板（client，只读）。
 *
 * 列出当前 thread 的 BackgroundTask（id/种类/命令/状态/端口/启动时间）。
 * 空状态「当前 thread 无后台任务」。
 *
 * 12-P1-3：改为 SSE 事件驱动刷新——订阅 task.started/stopped/failed 事件，
 * 收到事件后调 refresh() 拉最新数据。SSE 断线时自动降级轮询。
 */

type Task = {
  id: string;
  kind: string;
  command: string;
  runtimeType: string;
  status: string;
  pid: number | null;
  containerName: string | null;
  port: number | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  lastActivityAt: string;
};

const STATUS_TONE: Record<string, string> = {
  running: "text-[var(--ok)]",
  starting: "text-[var(--primary)]",
  stopped: "text-[var(--fg-muted)]",
  failed: "text-[var(--danger)]",
  cancelled: "text-[var(--fg-muted)]",
  orphaned: "text-[var(--warn)]",
};

export function BackgroundTaskPanel({ threadId }: { threadId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/studio/api/threads/${threadId}/tasks`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { tasks: Task[] } };
      setTasks(body.data?.tasks ?? []);
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

  // 12-P1-3：SSE 事件驱动刷新——收到 task 相关事件或降级轮询通知时 refresh
  useThreadEvents({
    threadId,
    onEvent: (ev) => {
      if (
        ev.type === "task.started" ||
        ev.type === "task.stopped" ||
        ev.type === "task.failed" ||
        ev.type === "__fallback__"
      ) {
        void refresh();
      }
    },
  });

  if (loading) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.task.loading")}</div>;
  }
  if (error) {
    return <div className="text-[13px] text-[var(--danger)]">{error}</div>;
  }
  if (tasks.length === 0) {
    return <div className="text-[13px] text-[var(--fg-muted)]">{t("studio.task.empty")}</div>;
  }

  return (
    <ul className="flex flex-col gap-1.5">
      {tasks.map((t) => (
        <li
          key={t.id}
          className="flex items-start gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px]"
        >
          <span className="w-20 shrink-0 font-medium text-[var(--fg)]">{t.kind}</span>
          <span className={`w-20 shrink-0 ${STATUS_TONE[t.status] ?? "text-[var(--fg-muted)]"}`}>
            {t.status}
          </span>
          <span className="flex-1 break-all text-[var(--fg-muted)]" title={t.command}>
            {t.command}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--fg-subtle)]">
            {t.port != null ? `:${t.port}` : t.runtimeType}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--fg-subtle)]">
            {new Date(t.startedAt).toLocaleTimeString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
