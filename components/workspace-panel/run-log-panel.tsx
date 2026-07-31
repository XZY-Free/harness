"use client";

/**
 * V10 Phase 1：运行日志面板。
 *
 * 两类日志源（V10：删除浏览器 console/network 轮询，Web 无服务端浏览器）：
 * - ThreadRun 事件：从 /api/threads/[id]/messages 轮询，展示活跃 run + 消息/工具调用时间线
 * - AppRuntime 日志：从 /api/threads/[id]/runtime/logs 轮询，展示 dev server stdout/stderr 尾部
 *
 * 支持按来源过滤（全部 / ThreadRun / AppRuntime）。
 */
import { Icon } from "@/components/icons";
import { apiFetch } from "@/lib/api-fetch";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 3000;

type ActiveRun = {
  id: string;
  status: string;
  startedAt: string | null;
  lastSeenAt: string | null;
  canSubscribe: boolean;
} | null;

type LogEntry = {
  id: string;
  kind: "user" | "assistant" | "tool";
  label: string;
  detail?: string;
  time?: string;
};

type MessagesResponse = {
  ok?: boolean;
  data?: Array<{
    id: string;
    role: string;
    createdAt?: string | Date;
    parts?: Array<{ type: string; [k: string]: unknown }>;
  }>;
  activeRun?: ActiveRun;
};

type RuntimeLogResponse = {
  ok?: boolean;
  lines?: string[];
  hasLog?: boolean;
  truncated?: boolean;
  totalLines?: number;
};

type SourceFilter = "all" | "threadrun" | "runtime";

function toEntries(messages: NonNullable<MessagesResponse["data"]>): LogEntry[] {
  const out: LogEntry[] = [];
  for (const m of messages) {
    const time = m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt;
    if (m.role === "user") {
      const textPart = m.parts?.find((p) => p.type === "text") as { text?: string } | undefined;
      out.push({
        id: m.id,
        kind: "user",
        label: "用户消息",
        detail: textPart?.text?.slice(0, 120),
        time,
      });
    } else if (m.role === "assistant") {
      const toolParts =
        m.parts?.filter((p) => p.type === "tool-invocation" || p.type === "tool-call") ?? [];
      if (toolParts.length > 0) {
        for (let i = 0; i < toolParts.length; i++) {
          const tp = toolParts[i] as { toolName?: string; state?: string };
          out.push({
            id: `${m.id}:tool:${i}`,
            kind: "tool",
            label: tp.toolName ?? "工具调用",
            detail: tp.state ? `状态: ${tp.state}` : undefined,
            time,
          });
        }
      } else {
        const textPart = m.parts?.find((p) => p.type === "text") as { text?: string } | undefined;
        if (textPart?.text) {
          out.push({
            id: m.id,
            kind: "assistant",
            label: "助手回复",
            detail: textPart.text.slice(0, 120),
            time,
          });
        }
      }
    }
  }
  return out;
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

export function RunLogPanel({ threadId }: { threadId: string }) {
  const [activeRun, setActiveRun] = useState<ActiveRun>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

  // AppRuntime 日志
  const [runtimeLines, setRuntimeLines] = useState<string[]>([]);
  const [runtimeHasLog, setRuntimeHasLog] = useState(false);
  const [runtimeTruncated, setRuntimeTruncated] = useState(false);

  // 合并两个数据源的轮询，避免多个 setInterval
  const loadAll = useCallback(async () => {
    const results = await Promise.allSettled([
      apiFetch(`/api/threads/${threadId}/messages`, { cache: "no-store" }).then(
        (r) => r.json() as Promise<MessagesResponse>,
      ),
      apiFetch(`/api/threads/${threadId}/runtime/logs`, { cache: "no-store" }).then(
        (r) => r.json() as Promise<RuntimeLogResponse>,
      ),
    ]);

    // ThreadRun 事件
    if (results[0].status === "fulfilled") {
      const json = results[0].value;
      if (json.ok && Array.isArray(json.data)) {
        setActiveRun(json.activeRun ?? null);
        setEntries(toEntries(json.data));
        setError(null);
      }
    }

    // AppRuntime 日志
    if (results[1].status === "fulfilled") {
      const json = results[1].value;
      if (json.ok) {
        setRuntimeLines(json.lines ?? []);
        setRuntimeHasLog(json.hasLog ?? false);
        setRuntimeTruncated(json.truncated ?? false);
      }
    }

    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await loadAll();
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
  }, [loadAll]);

  const showThreadRun = sourceFilter === "all" || sourceFilter === "threadrun";
  const showRuntime = sourceFilter === "all" || sourceFilter === "runtime";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-2)]">
      {/* 活跃 run 卡片 */}
      <section className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3">
        <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-[var(--fg-subtle)]">
          <Icon.terminal size={13} />
          ThreadRun
        </div>
        {activeRun ? (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-mono text-[12px] text-[var(--fg)]">{activeRun.id}</div>
              <div className="text-[11px] text-[var(--fg-subtle)]">
                {activeRun.startedAt ? `开始 ${formatTime(activeRun.startedAt)}` : "运行中"}
                {activeRun.canSubscribe ? " · 可订阅" : ""}
              </div>
            </div>
            <RunStatusBadge status={activeRun.status} />
          </div>
        ) : (
          <div className="text-[12px] text-[var(--fg-subtle)]">当前无活跃运行</div>
        )}
      </section>

      {/* 来源过滤 */}
      <section className="shrink-0 border-b border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
        <div className="flex items-center gap-1">
          <FilterButton
            active={sourceFilter === "all"}
            onClick={() => setSourceFilter("all")}
            label="全部"
          />
          <FilterButton
            active={sourceFilter === "threadrun"}
            onClick={() => setSourceFilter("threadrun")}
            label="ThreadRun"
          />
          <FilterButton
            active={sourceFilter === "runtime"}
            onClick={() => setSourceFilter("runtime")}
            label="AppRuntime"
          />
        </div>
      </section>

      {/* 事件流 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div className="px-2 py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
        )}

        {/* ThreadRun 事件 */}
        {showThreadRun && (
          <section className="border-b border-[var(--border)]">
            <div className="shrink-0 bg-[var(--surface)] px-4 py-1.5 text-[12px] font-medium text-[var(--fg-subtle)]">
              事件流
            </div>
            <div className="px-2 py-2">
              {loading ? (
                <div className="px-2 py-4 text-center text-[12px] text-[var(--fg-subtle)]">
                  加载中…
                </div>
              ) : entries.length === 0 ? (
                <div className="px-2 py-4 text-center text-[12px] text-[var(--fg-subtle)]">
                  暂无事件
                </div>
              ) : (
                entries.map((e) => <EventRow key={e.id} entry={e} />)
              )}
            </div>
          </section>
        )}

        {/* AppRuntime 日志 */}
        {showRuntime && (
          <section className="border-b border-[var(--border)]">
            <div className="shrink-0 bg-[var(--surface)] px-4 py-1.5 text-[12px] font-medium text-[var(--fg-subtle)]">
              AppRuntime{" "}
              {runtimeHasLog
                ? `(${runtimeLines.length} 行${runtimeTruncated ? " · 已截断" : ""})`
                : ""}
            </div>
            <div className="px-2 py-1">
              {!runtimeHasLog ? (
                <div className="px-2 py-3 text-center text-[11px] text-[var(--fg-subtle)]">
                  dev server 未启动或无日志
                </div>
              ) : (
                <RuntimeLogView lines={runtimeLines} />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  onClick,
  label,
}: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] font-medium transition ${
        active
          ? "bg-[var(--surface-2)] text-[var(--fg)]"
          : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--fg)]"
      }`}
    >
      {label}
    </button>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const isRunning = status === "running" || status === "streaming";
  const isError = status === "error" || status === "failed";
  const colorClass = isError
    ? "text-[var(--danger)]"
    : isRunning
      ? "text-[var(--primary)]"
      : "text-[var(--fg-subtle)]";
  return (
    <span className={`flex items-center gap-1 text-[11px] ${colorClass}`}>
      {isRunning && <Icon.spinner size={11} className="animate-spin" />}
      {status}
    </span>
  );
}

function EventRow({ entry }: { entry: LogEntry }) {
  const icon =
    entry.kind === "user" ? (
      <Icon.chat size={12} />
    ) : entry.kind === "tool" ? (
      <Icon.wrench size={12} />
    ) : (
      <Icon.sparkles size={12} />
    );
  const labelColor =
    entry.kind === "user"
      ? "text-[var(--primary)]"
      : entry.kind === "tool"
        ? "text-[var(--fg-muted)]"
        : "text-[var(--fg-subtle)]";
  return (
    <div className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-[var(--surface-2)]">
      <span className="mt-0.5 shrink-0 text-[var(--fg-subtle)]">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`truncate text-[12px] font-medium ${labelColor}`}>{entry.label}</span>
          {entry.time && (
            <span className="shrink-0 font-mono text-[10px] text-[var(--fg-subtle)]">
              {formatTime(entry.time)}
            </span>
          )}
        </div>
        {entry.detail && (
          <div className="mt-0.5 truncate text-[11px] text-[var(--fg-subtle)]">{entry.detail}</div>
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
          {line || "\u00A0"}
        </div>
      ))}
    </div>
  );
}
