/**
 * 员工端 Thread 客户端（高层 API）。
 *
 * 职责（S10-W01）：
 * - 加载 snapshot（GET /api/threads/{id}/items），建立基线。
 * - 启动 SSE 订阅，按 sequence 增量应用事件。
 * - EVENT_CURSOR_EXPIRED / EVENT_SEQUENCE_GAP → 自动 resnapshot。
 * - 网络中断 → SSE 客户端自动重连（用 lastAppliedEventSequence 作为 Last-Event-ID）。
 *
 * A11（执行代际）：
 * - 每次建立新连接时**重置代际比较基准**（服务端发号只保证单进程单调，跨连接不可比），
 *   等待本连接的第一条 `stream.generation` 权威基线。
 * - 收到畸形/缺失代际的 delta、或同 epoch 换 Owner/Attempt 的协议冲突 → 丢弃该 delta 并做
 *   **有界**权威刷新；超限后不再刷新，交由下一次权威基线纠正，绝不无限重连。
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
import { classifyTransientDelta, createInitialState } from "./thread-reducer";
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

/**
 * A11：窗口内有界的权威刷新次数上限。
 *
 * 畸形代际或协议冲突可能连续出现；超限后不再刷新，避免"每条坏消息 → 重连"退化成无限重连。
 */
export const MAX_AUTHORITATIVE_REFRESHES_PER_WINDOW = 3;
/** A11：权威刷新计数窗口（毫秒）。 */
export const AUTHORITATIVE_REFRESH_WINDOW_MS = 30_000;

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

  /**
   * A11：权威刷新的有界记忆（窗口内时间戳）。
   *
   * 畸形代际 / 协议冲突都可能连续出现；刷新必须**有界**，否则每次坏消息都重连会退化成
   * 无限重连。超限后不再刷新，等待下一次权威基线（服务端每有正式事件推进就会重发）纠正。
   */
  const authoritativeRefreshAt: number[] = [];

  /** 该代是否已过期（旧异步完成必须失效）。 */
  function isStale(gen: number): boolean {
    return gen !== generation;
  }

  /**
   * A11：请求一次**有界**的权威刷新（重新读取正式事实并重建连接）。
   *
   * - 窗口外的时间戳被丢弃，只看最近 `AUTHORITATIVE_REFRESH_WINDOW_MS` 内的次数。
   * - 已达上限 → 本次不刷新（不产生任何重连）；由下一次权威基线自行纠正。
   */
  function requestAuthoritativeRefresh(): void {
    if (stopped || resnapshotInFlight) return;
    const now = Date.now();
    while (
      authoritativeRefreshAt.length > 0 &&
      now - (authoritativeRefreshAt[0] as number) >= AUTHORITATIVE_REFRESH_WINDOW_MS
    ) {
      authoritativeRefreshAt.shift();
    }
    if (authoritativeRefreshAt.length >= MAX_AUTHORITATIVE_REFRESHES_PER_WINDOW) return;
    authoritativeRefreshAt.push(now);
    resnapshotInFlight = true;
    void resnapshot().finally(() => {
      resnapshotInFlight = false;
    });
  }

  async function loadSnapshot(gen: number): Promise<boolean> {
    store.dispatch({ type: "snapshot.loading" });

    let response: Response;
    try {
      response = await fetchImpl(apiPath(`/api/threads/${config.threadId}/items?limit=200`), {
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
          // A11：同 epoch 换 Owner/Attempt = 协议冲突 → 停止应用并刷新权威事实。
          // 判定与 reducer 共用同一实现（classifyTransientDelta）；这里只决定"是否刷新"，
          // 正文改动一律由 reducer 按同一判定处理。
          if (classifyTransientDelta(store.getState().generationBaseline, event) === "conflict") {
            requestAuthoritativeRefresh();
          }
          store.dispatch({ type: "stream.delta", event });
        },
        onGeneration: (baseline) => {
          store.dispatch({ type: "stream.generation", baseline });
        },
        onTransientRejected: () => {
          // A11：缺代际 / 畸形 epoch → 该 delta 已被 parser 丢弃；此处只做有界权威刷新。
          requestAuthoritativeRefresh();
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
    // A11：新连接 = 新的比较基准。先丢弃上一连接的暂存与旧基准，等待本连接的第一条
    // `stream.generation`；已显示的临时正文不在这里预先删除（换代由新基线证明）。
    store.dispatch({ type: "stream.generation_reset" });
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
