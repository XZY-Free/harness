"use client";

import { apiFetch, apiPath } from "@/lib/api-fetch";
/**
 * 过程透明日志流（合同 v2.3，Web/Desktop 共用一份实现）。
 *
 * - 活跃回合：追加日志流；每行整行即展开/收起开关（无行级箭头）；运行中行 spinner，落定换类型图标；
 * - 完成/失败：全过程收敛为单行「用时 X · 已执行 N 步操作」（默认收起、顶层保留箭头），
 *   展开后每步仍可再展开到最小单元（思考摘要 / 命令 / 命令+结果）；
 * - 历史回合：TurnActivitySummary 首次展开时懒加载 GET .../turns/{turn}/activity；
 * - 无时间戳、无卡片背景；失败回合失败卡片由既有 TurnFailureNotice 担当主角。
 */
import type { ActivityEntry, ActivityKind } from "@/lib/client/activity-projection";
import type { ClientTurn } from "@/lib/client/types";
import { useState } from "react";

type IconKind = ActivityKind | "spin" | "chev" | "fail";

function ActivityIcon({ kind }: { readonly kind: IconKind }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
  } as const;
  switch (kind) {
    case "spin":
      return (
        <svg aria-hidden="true" {...common} className="haic spin">
          <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
      );
    case "chev":
      return (
        <svg aria-hidden="true" {...common} className="haic chev">
          <path d="m9 18 6-6-6-6" />
        </svg>
      );
    case "fail":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "think":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
        </svg>
      );
    case "search":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      );
    case "read":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <path d="M4 5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 0-2 2V5Z" />
          <path d="M4 19a2 2 0 0 1 2-2h14" />
        </svg>
      );
    case "write":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z" />
        </svg>
      );
    case "wait":
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <path d="M12 3 2 21h20L12 3Zm0 7v5m0 3v.5" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden="true" {...common} className="haic">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="m7 9 3 3-3 3M13 15h4" />
        </svg>
      );
  }
}

function formatElapsed(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return m > 0 ? `${m} 分 ${r} 秒` : `${r} 秒`;
}

/** 单行日志：整行即展开/收起开关；有 block 才可展开。 */
function ActivityLine({
  entry,
  live,
}: {
  readonly entry: ActivityEntry;
  readonly live: boolean;
}) {
  const summary = (
    <span className={`ha-line${live ? " live" : ""}${entry.risk ? " risk" : ""}`}>
      <ActivityIcon kind={live ? "spin" : entry.kind} />
      <span>{entry.label}</span>
    </span>
  );
  if (!entry.block) {
    return <div className="ha-leaf">{summary}</div>;
  }
  return (
    <details className="ha-line-details">
      <summary>{summary}</summary>
      <pre className="ha-code">{entry.block}</pre>
    </details>
  );
}

/** 活跃回合日志流（追加流；turn 终态时调用方改渲染收敛条）。 */
export function HarnessActivityFeed({
  entries,
  turnActive,
}: {
  readonly entries: readonly ActivityEntry[];
  readonly turnActive: boolean;
}) {
  if (entries.length === 0) return null;
  const lastIndex = entries.length - 1;
  return (
    <div className="ha-feed" data-testid="harness-activity-feed">
      {entries.map((entry, index) => {
        const live =
          turnActive &&
          index === lastIndex &&
          (entry.phase === "think" ||
            entry.phase === "proposed" ||
            entry.phase === "started" ||
            entry.phase === "waiting");
        return <ActivityLine key={entry.key} entry={entry} live={live} />;
      })}
    </div>
  );
}

/** 收敛条（完成/失败共用）：默认收起、顶层箭头保留；展开为同一日志结构。 */
export function ActivitySummary({
  entries,
  elapsedMs,
  failed,
  stepCount,
}: {
  readonly entries: readonly ActivityEntry[];
  readonly elapsedMs: number | null;
  readonly failed: boolean;
  readonly stepCount: number;
}) {
  if (entries.length === 0) return null;
  const label = failed
    ? `执行失败 · 已执行 ${stepCount} 步操作`
    : `用时 ${formatElapsed(elapsedMs ?? 0)} · 已执行 ${stepCount} 步操作`;
  return (
    <details className={`ha-proc${failed ? " fail" : ""}`} data-testid="harness-activity-summary">
      <summary>
        <ActivityIcon kind="chev" />
        {failed ? <ActivityIcon kind="fail" /> : null}
        <span className="ha-lab">{label}</span>
      </summary>
      <div className="ha-steps">
        {entries.map((entry) => (
          <ActivityLine key={entry.key} entry={entry} live={false} />
        ))}
      </div>
    </details>
  );
}

/** 历史回合收敛条：首次展开懒加载 activity 端点（与 live 同结构）。 */
export function TurnActivitySummary({
  threadId,
  turn,
}: {
  readonly threadId: string;
  readonly turn: ClientTurn;
}) {
  const [entries, setEntries] = useState<readonly ActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const failed = turn.turn_state === "failed" || turn.turn_state === "cancelled";
  const stepCount = entries ? entries.filter((e) => e.phase === "completed").length : 0;
  const elapsedMs =
    turn.started_at && turn.finished_at
      ? Date.parse(turn.finished_at) - Date.parse(turn.started_at)
      : turn.accepted_at && turn.finished_at
        ? Date.parse(turn.finished_at) - Date.parse(turn.accepted_at)
        : null;

  return (
    <details
      className={`ha-proc${failed ? " fail" : ""}`}
      data-testid="harness-activity-summary"
      onToggle={(event) => {
        const open = (event.target as HTMLDetailsElement).open;
        if (!open || entries !== null || loading) return;
        setLoading(true);
        void apiFetch(apiPath(`/api/v1/threads/${threadId}/turns/${turn.id}/activity`))
          .then(async (response) => {
            if (!response.ok) return;
            const body = (await response.json()) as { data?: { entries?: ActivityEntry[] } };
            setEntries(body.data?.entries ?? []);
          })
          .catch(() => setEntries([]))
          .finally(() => setLoading(false));
      }}
    >
      <summary>
        <ActivityIcon kind="chev" />
        {failed ? <ActivityIcon kind="fail" /> : null}
        <span className="ha-lab">
          {failed
            ? `执行失败${entries ? ` · 已执行 ${stepCount} 步操作` : ""}`
            : `用时 ${formatElapsed(elapsedMs ?? 0)}${entries ? ` · 已执行 ${stepCount} 步操作` : ""}`}
        </span>
      </summary>
      <div className="ha-steps">
        {loading ? <div className="ha-leaf">加载中…</div> : null}
        {entries?.map((entry) => (
          <ActivityLine key={entry.key} entry={entry} live={false} />
        ))}
      </div>
    </details>
  );
}
