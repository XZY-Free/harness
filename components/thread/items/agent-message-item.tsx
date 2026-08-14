/**
 * Agent 消息 Item（agent_message）——W3-3 全宽正文形态（方案 §4.1）。
 *
 * content 结构：{ text }
 *
 * 形态（视觉基准：03 原型 .msg-ai）：
 * - 正式回复 = 全宽正文，无气泡、无边框、无底色（"结论层"）。
 * - 流式中（pending）末尾显示闪烁光标。
 * - 失败显示错误提示行。
 */
"use client";

import type { ClientItem } from "@/lib/client/types";

interface AgentMessageItemProps {
  readonly item: ClientItem;
}

export function AgentMessageItem({ item }: AgentMessageItemProps) {
  const content = item.content as { text?: string };
  const isPending = item.item_state === "pending";
  const isFailed = item.item_state === "failed";
  const displayText = typeof content?.text === "string" ? content.text : "";
  if (!displayText && !isPending && !isFailed) return null;

  return (
    <div className="message-row mb-5">
      <div className="conversation-copy prose-markdown text-foreground">
        {displayText}
        {isPending && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-[7px] animate-pulse rounded-[1px] bg-foreground align-middle"
          />
        )}
      </div>
      {isFailed && <div className="mt-1 text-2xs text-destructive">生成失败</div>}
    </div>
  );
}
