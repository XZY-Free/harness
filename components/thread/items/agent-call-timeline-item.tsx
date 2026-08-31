"use client";

import type { ClientAgentCallSummary } from "@/lib/client/types";
import { Bot } from "lucide-react";

interface AgentCallTimelineItemProps {
  readonly call: ClientAgentCallSummary;
}

function callLabel(call: ClientAgentCallSummary): string {
  const name = call.display_name ?? "助手";
  switch (call.state) {
    case "queued":
    case "running":
      return `正在咨询${name}`;
    case "waiting_user":
      return `${name}需要你补充信息`;
    case "completed":
      return `已收到${name}结果`;
    case "failed":
      return `未能取得${name}结果`;
    case "cancelled":
      return `已取消咨询${name}`;
    case "lost":
      return `与${name}的连接已中断`;
    default:
      return `${name}咨询状态已更新`;
  }
}

/** AgentCall 事实行：只展示安全状态摘要，不把调用结果或诊断内容带入员工时间线。 */
export function AgentCallTimelineItem({ call }: AgentCallTimelineItemProps) {
  return (
    <div
      className="mb-2 flex items-center gap-2 pl-1 text-xs text-muted-foreground"
      data-agent-call-id={call.call_id}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
        <Bot aria-hidden="true" className="size-3 stroke-[1.6]" />
      </span>
      <span>{callLabel(call)}</span>
      {call.duration_ms !== null && call.state === "completed" && (
        <span className="text-foreground-subtle">
          {Math.max(1, Math.round(call.duration_ms / 1000))} 秒
        </span>
      )}
    </div>
  );
}
