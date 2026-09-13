"use client";

import { CodeBlock, Markdown } from "@/components/markdown";
import { apiFetch } from "@/lib/api-fetch";
import {
  type ActivityEntry,
  type ActivityKind,
  mergeActionEntries,
  mergeThinkEntries,
} from "@/lib/client/activity-projection";
import type { ClientTurn } from "@/lib/client/types";
import {
  Check,
  ChevronRight,
  Files,
  LoaderCircle,
  Pencil,
  Search,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { type ComponentProps, useEffect, useRef, useState } from "react";

const ACTIVITY_ICONS = {
  think: LoaderCircle,
  search: Search,
  read: Files,
  write: Pencil,
  exec: SquareTerminal,
  wait: TriangleAlert,
  fail: X,
} as const;

function ActivityIcon({
  kind,
  live = false,
}: { readonly kind: ActivityKind; readonly live?: boolean }) {
  const Glyph = live ? LoaderCircle : ACTIVITY_ICONS[kind];
  return (
    <Glyph aria-hidden="true" strokeWidth={1.4} className={`haic${live ? " animate-spin" : ""}`} />
  );
}

function formatElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "执行记录";
  const sec = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(sec / 60);
  return `用时 ${min ? `${min} 分钟 ` : ""}${sec % 60} 秒`;
}

function ActivityLine({ entry, live }: { readonly entry: ActivityEntry; readonly live: boolean }) {
  // think 字段是运行时已公开的决策说明，不是模型内部推理。沿用正文 Markdown。
  if (entry.phase === "think" && entry.block) {
    return (
      <div className="ha-commentary conversation-copy prose-markdown">
        <Markdown>{entry.block}</Markdown>
      </div>
    );
  }
  const line = (
    <>
      <ActivityIcon kind={entry.kind} live={live} />
      <span className="ha-label" title={entry.label}>
        {entry.label}
      </span>
    </>
  );
  if (!entry.block)
    return (
      <div className="ha-line" data-phase={entry.phase}>
        {line}
      </div>
    );
  return (
    <details className="ha-line-details" data-phase={entry.phase}>
      <summary className="ha-line">
        {line}
        <ChevronRight aria-hidden="true" className="ha-chevron" strokeWidth={1.4} />
      </summary>
      <div className="ha-output">
        <CodeBlock plain>{entry.block}</CodeBlock>
        <div className="ha-output-status">
          {entry.phase === "completed" ? (
            <>
              <Check aria-hidden="true" />
              成功
            </>
          ) : entry.phase === "failed" ? (
            <>
              <X aria-hidden="true" />
              失败
            </>
          ) : entry.phase === "cancelled" ? (
            "未执行"
          ) : entry.phase === "waiting" ? (
            "等待确认"
          ) : (
            "执行中"
          )}
        </div>
      </div>
    </details>
  );
}

export function HarnessActivityFeed({
  entries,
  turnActive,
}: { readonly entries: readonly ActivityEntry[]; readonly turnActive: boolean }) {
  const normalized = mergeThinkEntries(mergeActionEntries(entries));
  // 无正文的 progress 是当前状态，不能作为完成记录反复回放。
  const visible = normalized.filter(
    (entry, index) =>
      entry.phase !== "think" || entry.block || (turnActive && index === normalized.length - 1),
  );
  if (!visible.length) return null;
  return (
    <div className="ha-feed" data-testid="harness-activity-feed">
      {visible.map((entry, index) => (
        <ActivityLine
          key={entry.key}
          entry={entry}
          live={
            turnActive &&
            index === visible.length - 1 &&
            ["think", "proposed", "started"].includes(entry.phase)
          }
        />
      ))}
    </div>
  );
}

export function ActivitySummary({
  entries,
  elapsedMs,
  failed,
  status,
  loading = false,
  error,
  onRetry,
  onToggle,
  open,
}: {
  readonly entries: readonly ActivityEntry[] | null;
  readonly elapsedMs: number | null;
  readonly failed: boolean;
  readonly status?: string;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly onRetry?: () => void;
  readonly onToggle?: ComponentProps<"details">["onToggle"];
  readonly open?: boolean;
}) {
  const label =
    status === "cancelled"
      ? "已停止"
      : status === "interrupted"
        ? "执行中断"
        : failed
          ? "执行失败"
          : formatElapsed(elapsedMs);
  return (
    <details
      className="ha-proc"
      data-testid="harness-activity-summary"
      open={open}
      onToggle={onToggle}
    >
      <summary>
        <span>{label}</span>
        <ChevronRight aria-hidden="true" className="ha-chevron" strokeWidth={1.4} />
      </summary>
      <div className="ha-steps">
        {loading ? (
          <div className="ha-line">
            <ActivityIcon kind="think" live />
            加载执行记录…
          </div>
        ) : null}
        {error ? (
          <div className="ha-line">
            执行记录加载失败
            <button type="button" onClick={onRetry} className="underline underline-offset-4">
              重试
            </button>
          </div>
        ) : null}
        {entries ? <HarnessActivityFeed entries={entries} turnActive={false} /> : null}
        {entries?.length === 0 && !loading && !error ? (
          <div className="ha-line">没有工具操作记录</div>
        ) : null}
      </div>
    </details>
  );
}

/** 同一组件覆盖实时、终态和重载后的历史。终态展开总是读持久记录，避免 ring 截断或重连丢失。 */
export function TurnActivitySummary({
  threadId,
  turn,
  liveEntries = [],
}: {
  readonly threadId: string;
  readonly turn: ClientTurn;
  readonly liveEntries?: readonly ActivityEntry[];
}) {
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(turn.turn_state);
  const [entries, setEntries] = useState<readonly ActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [request, setRequest] = useState(0);
  const [expanded, setExpanded] = useState(!terminal);
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${threadId}:${turn.id}:${terminal}:${request}`;
    if ((terminal && !expanded) || loadedKey.current === key) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void apiFetch(`/api/v1/threads/${threadId}/turns/${turn.id}/activity`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("activity unavailable");
        const body = (await response.json()) as { entries: ActivityEntry[] };
        if (!controller.signal.aborted) {
          loadedKey.current = key;
          setEntries(body.entries);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [threadId, turn.id, terminal, request, expanded]);
  if (!terminal) {
    const combined = [...(entries ?? []), ...liveEntries].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
    return (
      <HarnessActivityFeed entries={combined} turnActive={turn.turn_state !== "waiting_user"} />
    );
  }
  const since = turn.accepted_at ?? turn.started_at;
  const elapsedMs =
    since && turn.finished_at ? Date.parse(turn.finished_at) - Date.parse(since) : null;
  return (
    <ActivitySummary
      entries={entries ?? liveEntries}
      open={expanded}
      elapsedMs={elapsedMs}
      failed={turn.turn_state === "failed"}
      status={turn.turn_state}
      loading={loading}
      error={error}
      onRetry={() => {
        loadedKey.current = null;
        setRequest((n) => n + 1);
      }}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    />
  );
}
