/**
 * Turn 运行状态指示（真实状态反馈，非 token streaming）。
 *
 * 事实源：
 * - docs/architecture/product-surfaces-and-admin.md S10-W02/W03。
 *
 * 冻结语义：
 * - 状态只来自正式 Turn 投影（turn_state：accepted/queued → 正在准备...；
 *   running/regenerating → 正在处理...）。waiting_user/completed/failed 等
 *   终态或等待态一律不渲染，交由既有 agent_message / 错误 UI / UserAction UI。
 * - progress.snapshot 是 Provider 的公开进度事实：仅当其携带非空公开 message
 *   时展示该文本；缺失时保持通用文案。禁止推断黑盒 Agent 内部阶段
 *   （如"正在查询政策库"）。
 * - elapsed 时间仅客户端根据 started_at/accepted_at 计算显示，不落业务库，
 *   不定义任何超时失败（超时判定是服务端 Recovery Authority 的职责）。
 * - 纯当前执行状态 UI：不创建 ThreadItem、不进入会话历史/Context/Memory。
 */
"use client";

import type { ClientItem, ClientTurn } from "@/lib/client/types";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

/** 需要运行反馈的非终态 Turn 状态。 */
const ACTIVE_TURN_STATES = new Set(["accepted", "queued", "running", "regenerating"]);

/** elapsed 超过该秒数后文案切换为"仍在处理中..."（不定义失败）。 */
const LONG_RUNNING_SECONDS = 8;

interface TurnRunningIndicatorProps {
  readonly turn: ClientTurn | null;
  readonly items: readonly ClientItem[];
}

/** 取该 Turn 最新 progress.snapshot 携带的公开 message（无则 null）。 */
function latestProgressMessage(turn: ClientTurn, items: readonly ClientItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item || item.turn_id !== turn.id) continue;
    if (item.item_type !== "user_guidance") continue;
    const content = item.content;
    if (!content || typeof content !== "object") continue;
    const record = content as Record<string, unknown>;
    if (record.kind !== "progress.snapshot") continue;
    const message = record.message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return null;
}

/** 客户端 elapsed 秒（started_at ?? accepted_at 起算；非法时间 → 0）。 */
function elapsedSeconds(sinceIso: string | null | undefined, now: number): number {
  if (!sinceIso) return 0;
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) return 0;
  return Math.max(0, Math.floor((now - since) / 1000));
}

export function TurnRunningIndicator({ turn, items }: TurnRunningIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());

  // 运行中每秒刷新 elapsed；不活跃时停止计时（组件不渲染）。
  useEffect(() => {
    if (!turn || !ACTIVE_TURN_STATES.has(turn.turn_state)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [turn]);

  if (!turn || !ACTIVE_TURN_STATES.has(turn.turn_state)) return null;

  const baseLabel =
    turn.turn_state === "running" || turn.turn_state === "regenerating"
      ? "正在处理..."
      : "正在准备...";
  const progressMessage = latestProgressMessage(turn, items);
  const seconds = elapsedSeconds(turn.started_at ?? turn.accepted_at, now);
  const longRunning = seconds >= LONG_RUNNING_SECONDS;

  return (
    <output
      data-testid="turn-running-indicator"
      className="flex items-center gap-2 py-2 text-muted-foreground text-sm"
    >
      <Loader2
        aria-hidden="true"
        className="size-3.5 animate-spin text-primary/80"
        strokeWidth={1.75}
      />
      <span>
        {progressMessage ?? (longRunning ? "仍在处理中..." : baseLabel)}
        {seconds > 0 ? ` ${seconds} 秒` : ""}
      </span>
    </output>
  );
}
