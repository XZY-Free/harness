/**
 * 员工端共享客户端（S10-W01）。
 *
 * 导出 Web/Desktop 共用的 Thread 投影层。
 *
 * 使用方式（React）：
 * ```tsx
 * import { useThread } from "@/components/hooks/use-thread";
 * function ThreadView({ threadId }: { threadId: string }) {
 * const { items, streamStatus, visibleError } = useThread(threadId);
 * // ...
 * }
 * ```
 *
 * 使用方式（非 React）：
 * ```ts
 * import { createThreadClient } from "@/lib/client";
 * const client = createThreadClient({ threadId });
 * client.store.subscribe((state) => console.log(state));
 * await client.start();
 * ```
 */
export { createThreadClient } from "./thread-client";
export type { ThreadClient, ThreadClientConfig } from "./thread-client";

export { createThreadStore } from "./thread-store";
export type { ThreadStore, ThreadStoreListener } from "./thread-store";

export { threadProjectionReducer, createInitialState } from "./thread-reducer";

export { createSSEClient } from "./sse-client";
export type {
 SSEClientCallbacks,
 SSEClientConfig,
 SSEClientHandle,
} from "./sse-client";

export { toVisibleError, makeLocalVisibleError } from "./error-messages";

export type {
 ClientErrorBody,
 ClientEvent,
 ClientEventPayload,
 ClientItem,
 ClientItemsResponse,
 ClientItemState,
 ClientItemType,
 ClientStreamStatus,
 ClientVisibleError,
 ThreadProjectionAction,
 ThreadProjectionState,
} from "./types";
