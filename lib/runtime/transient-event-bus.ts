/**
 * Thread transient 事件总线。
 *
 * response.delta 不进入持久账本，只在当前应用进程内推送给 SSE 订阅者。
 * transient 事件没有 SSE id、断线后不重放（见 docs/architecture/api-and-events.md），
 * 因此短期缓冲只用于覆盖“事件先产生、首个 listener 尚未建立”的短暂竞态。
 *
 * 一次性缓冲语义：
 * - 已有活跃 listener 时，publish 只实时投递，绝不写入重放 buffer。
 * - 无 listener 期间产生的事件才进入一次性 buffer；首个 subscribe 原子 drain（取出并
 *   删除）后最多重放一次，之后不再可见。
 * - 因此 unsubscribe/reconnect 后，已实时投递过的事件绝不会被新 listener 再放一遍。
 *
 * Next dev 会把本模块编译进多个 route chunk（publish 与 subscribe 可能落在不同
 * bundle 实例），模块级 Map 无法跨实例共享状态，导致同一 Node 进程内的流式增量
 * 丢失。因此总线状态挂在 globalThis 的 Symbol.for 稳定键上，使不同 module 实例
 * 共享同一份 listeners 与一次性 buffer——仍限定“当前应用进程”，不引入 Redis/DB/
 * 持久账本。TTL、每线程缓冲上限、清理语义保持不变。
 */

import { SSE_BUFFER_SIZE } from "@/lib/conversations/sse-transport";

export interface ThreadTransientEvent {
  readonly transientId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type Listener = (event: ThreadTransientEvent) => void;

interface BufferedEvent {
  readonly event: ThreadTransientEvent;
  readonly expiresAt: number;
}

interface BusState {
  readonly listenersByThread: Map<string, Set<Listener>>;
  readonly bufferByThread: Map<string, BufferedEvent[]>;
}

const BUFFER_TTL_MS = 2 * 60 * 1000;

/**
 * 一次性缓冲上限（条数）。
 *
 * 与服务端 SSE 有界缓冲对齐并保留余量：同步重放 buffer 到新订阅者时，若超过
 * SSE_BUFFER_SIZE 会直接填爆 CountQueuingStrategy，触发 SSE 背压并 close（真实
 * 失败循环）。取 SSE_BUFFER_SIZE 的一半，给 stream.resumed 与持久 backlog 留出
 * 余量；同时足以覆盖“首个 listener 建立前”的短竞态窗口。
 */
export const MAX_BUFFERED_EVENTS_PER_THREAD = Math.floor(SSE_BUFFER_SIZE / 2);

/** Symbol.for 在跨模块实例/跨 bundle 时解析为同一符号，从而共享同一进程级状态。 */
const STATE_KEY = Symbol.for("snowharness.threadTransientEventBus.state");

function getBusState(): BusState {
  const g = globalThis as { [STATE_KEY]?: BusState };
  let state = g[STATE_KEY];
  if (!state) {
    state = {
      listenersByThread: new Map<string, Set<Listener>>(),
      bufferByThread: new Map<string, BufferedEvent[]>(),
    };
    g[STATE_KEY] = state;
  }
  return state;
}

/** 清理某线程 buffer 中已过期的条目，返回仍有效的条目（不删除整体）。 */
function pruneBuffer(threadId: string, now = Date.now()): BufferedEvent[] {
  const { bufferByThread } = getBusState();
  const current = bufferByThread.get(threadId) ?? [];
  const live = current.filter((entry) => entry.expiresAt > now);
  if (live.length === 0) {
    bufferByThread.delete(threadId);
  } else if (live.length !== current.length) {
    bufferByThread.set(threadId, live);
  }
  return live;
}

export function publishThreadTransientEvent(event: ThreadTransientEvent): void {
  const { bufferByThread, listenersByThread } = getBusState();
  const listeners = listenersByThread.get(event.threadId);

  // 已有活跃 listener：事件只实时投递，绝不写入重放 buffer。
  // 若在投递的同时入 buffer，重连后的新 listener 会把同一批增量再放一遍（真实失败循环
  // 根因：整条 Turn 的 response.delta 被反复同步重放直至触发 SSE 背压）。
  if (listeners && listeners.size > 0) {
    for (const listener of listeners) listener(event);
    return;
  }

  // 无 listener（事件先于首个 SSE 建立产生）：进入一次性 buffer，由下一 listener 迟到消费。
  const live = pruneBuffer(event.threadId);
  const next = [
    ...live,
    {
      event,
      expiresAt: Date.now() + BUFFER_TTL_MS,
    },
  ].slice(-MAX_BUFFERED_EVENTS_PER_THREAD);
  bufferByThread.set(event.threadId, next);
}

export function subscribeThreadTransientEvents(threadId: string, listener: Listener): () => void {
  const { bufferByThread, listenersByThread } = getBusState();
  const listeners = listenersByThread.get(threadId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByThread.set(threadId, listeners);

  // 原子 drain：取出当前一次性 buffer 并立即删除，最多重放一次。
  // 此函数同步执行，add-listener 与 drain 之间不会被 publish 插队；之后产生的 transient
  // 事件走实时投递（不回流 buffer），因此重连/后续 listener 不会再看到这批已 drain 的历史。
  const drained = pruneBuffer(threadId);
  bufferByThread.delete(threadId);
  for (const entry of drained) {
    listener(entry.event);
  }

  return () => {
    const current = listenersByThread.get(threadId);
    current?.delete(listener);
    if (current?.size === 0) listenersByThread.delete(threadId);
  };
}
