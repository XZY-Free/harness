/**
 * 用户消息 Item（user_message / user_guidance）。
 *
 * content 结构（user_message）：{ text, attachments?, client_message_id }
 * content 结构（user_guidance）：同 user_message，itemState=pending（不进入上下文）
 *
 * 样式：右侧气泡（与 chat/message-row.tsx 用户消息一致）。
 */
"use client";

import type { ClientItem } from "@/lib/client/types";
import { cn } from "@/lib/utils";

interface UserMessageItemProps {
  readonly item: ClientItem;
}

export function UserMessageItem({ item }: UserMessageItemProps) {
  const content = item.content as { text?: string; attachments?: unknown[] };
  const isGuidance = item.item_type === "user_guidance";
  const isPending = item.item_state === "pending";
  const displayText = typeof content?.text === "string" ? content.text.trim() : "";
  if (!displayText) return null;

  return (
    <div className="message-row mb-3 flex justify-end" data-testid="user-message">
      <div
        className={cn(
          "conversation-user-bubble",
          isGuidance ? "border border-warning/30 bg-warning/10" : "bg-muted",
          isPending && "opacity-60",
        )}
      >
        <div className="prose-markdown text-foreground">{displayText}</div>
        {isGuidance && (
          <div className="mt-1 text-2xs text-warning">{isPending ? "引导待确认" : "引导"}</div>
        )}
      </div>
    </div>
  );
}
