import type { ChatAttachmentData, ChatMessage } from "@/lib/types";

export const ATTACHMENT_TEXT_PREFIX = "[附件正文:";

type MessagePart = ChatMessage["parts"][number];

export type AttachmentDataPart = {
 type: "data-attachment";
 id?: string;
 data: ChatAttachmentData;
};

export function isAttachmentDataPart(part: MessagePart): part is AttachmentDataPart {
 if (part.type !== "data-attachment") return false;
 const data = part.data as Partial<ChatAttachmentData> | undefined;
 return (
 typeof data?.filename === "string" &&
 typeof data.text === "string" &&
 typeof data.charCount === "number"
 );
}

export function isAttachmentTextPart(part: MessagePart): boolean {
 return part.type === "text" && part.text.startsWith(ATTACHMENT_TEXT_PREFIX);
}

export function formatAttachmentText(data: ChatAttachmentData): string {
 return `${ATTACHMENT_TEXT_PREFIX} ${data.filename} (${data.charCount} 字符)]\n${data.text}`;
}

function legacyAttachmentData(part: unknown): ChatAttachmentData | null {
 if (!part || typeof part !== "object") return null;
 const candidate = part as {
 type?: unknown;
 filename?: unknown;
 text?: unknown;
 charCount?: unknown;
 };
 if (candidate.type !== "attachment") return null;
 if (
 typeof candidate.filename !== "string" ||
 typeof candidate.text !== "string" ||
 typeof candidate.charCount !== "number"
 ) {
 return null;
 }
 return {
 filename: candidate.filename,
 text: candidate.text,
 charCount: candidate.charCount,
 };
}

export function normalizeAttachmentParts(message: ChatMessage): ChatMessage {
 const parts: ChatMessage["parts"] = [];
 for (const part of message.parts ?? []) {
 const data = isAttachmentDataPart(part) ? part.data : legacyAttachmentData(part);
 if (data) {
 if (!isAttachmentDataPart(part)) {
 parts.push({ type: "data-attachment", data });
 } else {
 parts.push(part);
 }
 parts.push({ type: "text", text: formatAttachmentText(data) });
 continue;
 }
 parts.push(part);
 }
 return { ...message, parts };
}
