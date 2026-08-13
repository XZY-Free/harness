import type { ThreadStatus } from "@/lib/db/schema";
import type { UIMessage } from "ai";

/**
 * SnowHarness v2 类型定义。
 */

export type ChatAttachmentData = {
  filename: string;
  text: string;
  charCount: number;
};

export type ChatDataTypes = {
  attachment: ChatAttachmentData;
  artifact: {
    previewUrl: string;
    status: ThreadStatus;
  };
};

export type ChatMessage = UIMessage<unknown, ChatDataTypes> & {
  /** D-3: 消息创建时间（convertToUIMessages 从 DB 带出；useChat 新生成的内存消息无此字段）。 */
  createdAt?: Date;
};

/** 预览运行时状态。 */
export type PreviewStatus = "idle" | "starting" | "ready" | "error";

export type PreviewState = {
  status: PreviewStatus;
  /** status 为 ready 时的可访问预览 URL（喂给 iframe）。 */
  url?: string;
  /** 加载/错误态的提示文案。 */
  message?: string;
};

/** Thread 状态（re-export from schema for convenience） */
export type { ThreadStatus };

/** data-artifact part — 后端自检后推给前端的预览通知 */
export type DataArtifactPart = {
  type: "data-artifact";
  data: {
    previewUrl: string;
    status: ThreadStatus;
  };
};
