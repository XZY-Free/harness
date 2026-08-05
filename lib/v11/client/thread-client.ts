/**
 * V11 员工端 Thread 客户端（高层 API）。
 *
 * 职责（S10-W01）：
 * - 加载 snapshot（GET /api/v1/threads/{id}/items），建立基线。
 * - 启动 SSE 订阅，按 sequence 增量应用事件。
 * - EVENT_CURSOR_EXPIRED / EVENT_SEQUENCE_GAP → 自动 resnapshot。
 * - 网络中断 → SSE 客户端自动重连（用 lastAppliedEventSequence 作为 Last-Event-ID）。
 *
 * 消费方式：
 * ```ts
 * const client = createV11ThreadClient({ threadId });
 * const unsubscribe = client.store.subscribe((state) => render(state));
 * client.start();
 * // 卸载
 * client.stop();
 * unsubscribe();
 * ```
 *
 * 与 React 集成：见 components/hooks/use-v11-thread.ts。
 */
import { apiPath } from "../../api-fetch";
import { toVisibleError } from "./error-messages";
import { type SSEClientHandle, V11_SSE_DEFAULT_MAX_RETRIES, createSSEClient } from "./sse-client";
import { createInitialState } from "./thread-reducer";
import { type ThreadStore, createThreadStore } from "./thread-store";
import type { ClientErrorBody, ClientEvent, ClientItemsResponse } from "./types";

/** Thread 客户端配置。 */
export interface ThreadClientConfig {
  readonly threadId: string;
  /** 自定义 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** SSE 最大重试次数。 */
  readonly sseMaxRetries?: number;
  /** SSE 基础退避毫秒数。 */
  readonly sseBaseBackoffMs?: number;
}

/** Thread 客户端。 */
export interface ThreadClient {
  readonly store: ThreadStore;
  /** 启动：先加载 snapshot，成功后启动 SSE。 */
  start(): Promise<void>;
  /** 停止：关闭 SSE，不重新加载。 */
  stop(): void;
  /** 强制重新加载 snapshot（用于错误恢复）。 */
  resnapshot(): Promise<void>;
}

/**
 * Item 事件有时只携带内容哈希而非完整投影；此时不能凭摘要构造消息，需重读权威快照。
 */
export function requiresSnapshotRefresh(event: ClientEvent): boolean {
  if (event.event_type !== "item.created" && event.event_type !== "item.updated") return false;
  const payload = event.payload;
  return !payload || typeof payload !== "object" || !("item" in payload);
}

/** 创建 Thread 客户端。 */
export function createV11ThreadClient(config: ThreadClientConfig): ThreadClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const store = createThreadStore(createInitialState(config.threadId));
  let sseHandle: SSEClientHandle | null = null;
  let stopped = false;
  let resnapshotInFlight = false;

  async function loadSnapshot(): Promise<boolean> {
    store.dispatch({ type: "snapshot.loading" });

    let response: Response;
    try {
      response = await fetchImpl(apiPath(`/api/v1/threads/${config.threadId}/items?limit=200`), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      store.dispatch({
        type: "snapshot.failed",
        error: {
          code: "NETWORK_ERROR",
          title: "网络异常",
          description: "无法连接服务器，请检查网络后再试。",
          retryable: true,
          recoveryAction: "reload_page",
          requestId: null,
        },
      });
      return false;
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      let errorBody: ClientErrorBody | null = null;
      try {
        errorBody = JSON.parse(bodyText) as ClientErrorBody;
      } catch {
        // ignore
      }
      const visible = errorBody
        ? toVisibleError(errorBody)
        : {
            // 非 JSON 错误响应 = 请求未到应用层（Nginx 404 HTML / 网关拦截），
            // 不能映射成"会话不存在"误导员工。
            code: "UPSTREAM_INVALID_RESPONSE",
            title: "服务响应异常",
            description:
              "服务器未返回有效数据，可能是网关或部署配置问题。请稍后重试，若持续出现请联系管理员。",
            retryable: true,
            recoveryAction: "reload_page" as const,
            requestId: null,
          };
      store.dispatch({ type: "snapshot.failed", error: visible });
      return false;
    }

    const data = (await response.json()) as ClientItemsResponse;
    store.dispatch({
      type: "snapshot.loaded",
      items: data.items,
      latestEventCursor: data.latest_event_cursor,
    });
    return true;
  }

  function startSSE(): void {
    if (stopped) return;
    sseHandle = createSSEClient(
      {
        threadId: config.threadId,
        getLastEventId: () => {
          const cursor = store.getState().latestEventCursor;
          return cursor?.sequence ?? null;
        },
        fetchImpl,
        maxRetries: config.sseMaxRetries,
        baseBackoffMs: config.sseBaseBackoffMs,
      },
      {
        onOpen: () => {
          store.dispatch({ type: "stream.status", status: "open" });
        },
        onReconnecting: (attempt) => {
          store.dispatch({
            type: "stream.status",
            status: "reconnecting",
            reconnectAttempt: attempt,
            reconnectMax: config.sseMaxRetries ?? V11_SSE_DEFAULT_MAX_RETRIES,
          });
        },
        onEvent: (event) => {
          store.dispatch({ type: "event.received", event });
          if (requiresSnapshotRefresh(event) && !resnapshotInFlight) {
            resnapshotInFlight = true;
            void resnapshot().finally(() => {
              resnapshotInFlight = false;
            });
          }
        },
        onTransient: (event) => {
          store.dispatch({ type: "stream.delta", event });
        },
        onCursorExpired: (error) => {
          store.dispatch({ type: "stream.cursor_expired", error });
          // 自动 resnapshot
          void resnapshot();
        },
        onFailed: (error) => {
          store.dispatch({ type: "stream.failed", error });
        },
      },
    );
    store.dispatch({ type: "stream.status", status: "connecting" });
    sseHandle.start();
  }

  async function resnapshot(): Promise<void> {
    // 关闭旧 SSE，重新加载 snapshot 并重启 SSE
    if (sseHandle) {
      sseHandle.close();
      sseHandle = null;
    }
    const ok = await loadSnapshot();
    if (ok && !stopped) {
      startSSE();
    }
  }

  return {
    store,
    start: async () => {
      stopped = false;
      const ok = await loadSnapshot();
      if (ok && !stopped) {
        startSSE();
      }
    },
    stop: () => {
      stopped = true;
      if (sseHandle) {
        sseHandle.close();
        sseHandle = null;
      }
      store.dispatch({ type: "stream.status", status: "closed" });
    },
    resnapshot,
  };
}
