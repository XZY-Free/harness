import { isAttachmentDataPart, isAttachmentTextPart } from "@/lib/chat/attachments";
import type { ChatMessage } from "@/lib/types";
import type { FileUIPart } from "ai";

/**
 * 12-P2-1：chat-panel 辅助函数抽离。
 *
 * 从 components/chat-panel.tsx 内嵌函数抽出，供 MessageRow 等子组件复用。
 */

type ToolPart = {
  state?: string;
  input?: { path?: string; command?: string; summary?: string };
  output?: { ok?: boolean; path?: string; error?: string; url?: string };
};

/** 从消息 parts 中提取图片 file part。 */
export function getImageParts(message: ChatMessage): FileUIPart[] {
  return (
    message.parts?.filter(
      (p): p is FileUIPart => p.type === "file" && p.mediaType.startsWith("image/"),
    ) ?? []
  );
}

/** 从消息 parts 中提取文档附件卡片数据。 */
export function getAttachmentParts(message: ChatMessage) {
  return message.parts?.filter(isAttachmentDataPart).map((p) => p.data) ?? [];
}

/** 从消息 parts 中提取可见文本（排除 attachment text part）。 */
export function getVisibleTextFromMessage(message: ChatMessage): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && !isAttachmentTextPart(part)) {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

export type { ToolPart };
