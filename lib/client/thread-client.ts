/**
 * 员工端 Thread 客户端（高层 API）。
 *
 * 职责（S10-W01）：
 * - 加载 snapshot（GET /api/v1/threads/{id}/items），建立基线。
 * - 启动 SSE 订阅，按 sequence 增量应用事件。
 * - EVENT_CURSOR_EXPIRED / EVENT_SEQUENCE_GAP → 自动 resnapshot。
 * - 网络中断 → SSE 客户端自动重连（用 lastAppliedEventSequence 作为 Last-Event-ID）。
 *
 * 消费方式：
 * ```ts
 * const client = createThreadClient({ threadId });
 * const unsubscribe = client.store.subscribe((state) => render(state));
 * client.start();
 * // 卸载
 * client.stop();
 * unsubscribe();
 * ```
 *
 * 与 React 集成：见 components/hooks/use-thread.ts。
 */
import { apiPath } from "@/lib/api-fetch";
import { toVisibleError } from "./error-messages";
import { type SSEClientHandle, SSE_DEFAULT_MAX_RETRIES, createSSEClient } from "./sse-client";
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
export function createThreadClient(config: ThreadClientConfig): ThreadClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const store = createThreadStore(createInitialState(config.threadId));
  let sseHandle: SSEClientHandle | null = null;
  let stopped = false;
  let resnapshotInFlight = false;
  // 生命周期代数：start/stop/resnapshot 每次进入新一"代"。任何一代的异步 snapshot
  // 完成时若代数已过期（gen !== generation），即视为失效，不得启动 SSE 或覆盖新句柄。
  // 由此 start/stop/resnapshot 可取消、幂等，任意时刻最多一个活跃 SSE。
  let generation = 0;

  /** 该代是否已过期（旧异步完成必须失效）。 */
  function isStale(gen: number): boolean {
    return gen !== generation;
  }

  async function loadSnapshot(gen: number): Promise<boolean> {
    store.dispatch({ type: "snapshot.loading" });

    let response: Response;
    try {
      response = await fetchImpl(apiPath(`/api/v1/threads/${config.threadId}/items?limit=200`), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      if (isStale(gen)) return false;
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
      if (isStale(gen)) return false;
      store.dispatch({ type: "snapshot.failed", error: visible });
      return false;
    }

    const data = (await response.json()) as ClientItemsResponse;
    if (isStale(gen)) return false;
    store.dispatch({
      type: "snapshot.loaded",
      items: data.items,
      latestEventCursor: data.latest_event_cursor,
    });
    return true;
  }

  function startSSE(): void {
    if (stopped) return;
    // 防御：关闭任何先前句柄，确保同一时刻最多一个活跃 SSE（旧代遗留句柄一并收口）。
    if (sseHandle) {
      sseHandle.close();
      sseHandle = null;
    }
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
            reconnectMax: config.sseMaxRetries ?? SSE_DEFAULT_MAX_RETRIES,
          });
        },
        onEvent: (event) => {
          // 记录 dispatch 前持久游标。摘要 Item 事件只有在本次 dispatch 实际被 reducer
          // 接受并推进游标（lastAppliedEventSequence 前进到 event.sequence）时才允许触发
          // resnapshot。重复 event_id / 旧 sequence / gap 等被 reducer 忽略的事件会返回原
          // state，游标不前进——此时不得再 resnapshot，否则「新 SSE 从 cursor 补发同一事件 →
          // 重放 → 再次 resnapshot」会无限循环（真实长回复完成后反复重连的根因）。
          // 用 dispatch 前后游标值比较，而非对象引用，避免受引用偶然变化影响。
          const lastAppliedBefore = store.getState().lastAppliedEventSequence;
          store.dispatch({ type: "event.received", event });
          const lastAppliedAfter = store.getState().lastAppliedEventSequence;
          const cursorAdvanced =
            lastAppliedBefore < event.sequence && lastAppliedAfter === event.sequence;
          if (requiresSnapshotRefresh(event) && cursorAdvanced && !resnapshotInFlight) {
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
    // 进入新一代：使任何进行中的旧 snapshot 失效；关闭旧 SSE，重新加载并重启。
    generation += 1;
    const gen = generation;
    if (sseHandle) {
      sseHandle.close();
      sseHandle = null;
    }
    const ok = await loadSnapshot(gen);
    if (ok && !stopped) {
      startSSE();
    }
  }

  return {
    store,
    start: async () => {
      generation += 1;
      const gen = generation;
      stopped = false;
      const ok = await loadSnapshot(gen);
      if (ok && !stopped) {
        startSSE();
      }
    },
    stop: () => {
      // 进入新一代：进行中的 snapshot 立即失效，不产生 SSE。
      generation += 1;
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
