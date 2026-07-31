/**
 * V11 员工端共享客户端（S10-W01）。
 *
 * 导出 Web/Desktop 共用的 Thread 投影层。
 *
 * 使用方式（React）：
 * ```tsx
 * import { useV11Thread } from "@/components/hooks/use-v11-thread";
 * function ThreadView({ threadId }: { threadId: string }) {
 *   const { items, streamStatus, visibleError } = useV11Thread(threadId);
 *   // ...
 * }
 * ```
 *
 * 使用方式（非 React）：
 * ```ts
 * import { createV11ThreadClient } from "@/lib/v11/client";
 * const client = createV11ThreadClient({ threadId });
 * client.store.subscribe((state) => console.log(state));
 * await client.start();
 * ```
 */
export { createV11ThreadClient } from "./thread-client";
export type { V11ThreadClient, V11ThreadClientConfig } from "./thread-client";

export { createThreadStore } from "./thread-store";
export type { V11ThreadStore, V11ThreadStoreListener } from "./thread-store";

export { threadProjectionReducer, createInitialState } from "./thread-reducer";

export { createSSEClient } from "./sse-client";
export type {
  V11SSEClientCallbacks,
  V11SSEClientConfig,
  V11SSEClientHandle,
} from "./sse-client";

export { toVisibleError, makeLocalVisibleError } from "./error-messages";

export type {
  V11ClientErrorBody,
  V11ClientEvent,
  V11ClientEventPayload,
  V11ClientItem,
  V11ClientItemsResponse,
  V11ClientItemState,
  V11ClientItemType,
  V11ClientStreamStatus,
  V11ClientVisibleError,
  V11ThreadProjectionAction,
  V11ThreadProjectionState,
} from "./types";
