import type { UIMessage } from "ai";

export type ChatMessage = UIMessage & {
  /** D-3: 消息创建时间（convertToUIMessages 从 DB 带出；useChat 新生成的内存消息无此字段）。 */
  createdAt?: Date;
};
