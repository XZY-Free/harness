"use client";

/**
 * 运行日志面板（V10 Phase 1，AppRuntime 精简版）。
 *
 * 日志源：AppRuntime dev server 日志——从 /api/v1/threads/{thread_id}/runtime/logs 轮询，
 * 展示运行时 stdout/stderr 尾部。旧 ThreadRun /api/threads/[id]/messages 事件流
 * 已随本地执行体系移除，本面板只消费 AppRuntime 日志。
 */
import { Icon } from "@/components/icons";
import { apiFetch } from "@/lib/api-fetch";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 3000;

type RuntimeLogResponse = {
  ok?: boolean;
  lines?: string[];
  hasLog?: boolean;
  truncated?: boolean;
  totalLines?: number;
};

export function RunLogPanel({ threadId }: { threadId: string }) {
  const [runtimeLines, setRuntimeLines] = useState<string[]>([]);
  const [runtimeHasLog, setRuntimeHasLog] = useState(false);
  const [runtimeTruncated, setRuntimeTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadLogs = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/v1/threads/${threadId}/runtime/logs`, { cache: "no-store" });
      const json = (await res.json()) as RuntimeLogResponse;
      if (json.ok) {
        setRuntimeLines(json.lines ?? []);
        setRuntimeHasLog(json.hasLog ?? false);
        setRuntimeTruncated(json.truncated ?? false);
        setError(null);
      }
    } catch {
      setError("日志加载失败");
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await loadLogs();
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = window.setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadLogs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-2)]">
      <section className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
        <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--fg-subtle)]">
          <Icon.terminal size={13} />
          AppRuntime{" "}
          {runtimeHasLog ? `(${runtimeLines.length} 行${runtimeTruncated ? " · 已截断" : ""})` : ""}
        </div>
      </section>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="px-2 py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
        )}
        {loading ? (
          <div className="px-2 py-4 text-center text-[12px] text-[var(--fg-subtle)]">加载中…</div>
        ) : !runtimeHasLog ? (
          <div className="px-2 py-3 text-center text-[11px] text-[var(--fg-subtle)]">
            dev server 未启动或无日志
          </div>
        ) : (
          <RuntimeLogView lines={runtimeLines} />
        )}
      </div>
    </div>
  );
}

function RuntimeLogView({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 自动滚动到底部（dev server 日志是追加的）
  useEffect(() => {
    if (scrollRef.current && lines.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines.length]);
  return (
    <div
      ref={scrollRef}
      className="max-h-[200px] overflow-y-auto rounded bg-[var(--surface)] p-2 font-mono text-[11px] leading-5 text-[var(--fg-muted)]"
    >
      {lines.map((line, i) => (
        <div key={`log-${i}-${line.slice(0, 20)}`} className="whitespace-pre-wrap break-all">
          {line || " "}
        </div>
      ))}
    </div>
  );
}
