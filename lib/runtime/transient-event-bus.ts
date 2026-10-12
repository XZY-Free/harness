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
 *   删除）后最多消费一次，之后不再可见。
 * - 因此 unsubscribe/reconnect 后，已实时投递过的事件绝不会被新 listener 再放一遍。
 *
 * A11 初始化 barrier（本模块的关键不变量）：
 * - **drain 不等于投递**。subscribe 只把一次性 buffer 搬到订阅句柄的暂存区，不调用 listener。
 *   调用方拿到权威代际基线（`stream.generation`）后调用 `release(accept)`，暂存才按 exact
 *   tuple 过滤并投递；此后实时事件同样经 `accept` 过滤。
 * - 修掉的缺口：旧实现"同步 drain 立即投递"，会让旧代际的增量输出在权威基线之前，客户端
 *   于是把它当新代际正文拼接（复审报告 §9）。暂存区与一次性 buffer 同上限，保持有界。
 *
 * Next dev 会把本模块编译进多个 route chunk（publish 与 subscribe 可能落在不同
 * bundle 实例），模块级 Map 无法跨实例共享状态，导致同一 Node 进程内的流式增量
 * 丢失。因此总线状态挂在 globalThis 的 Symbol.for 稳定键上，使不同 module 实例
 * 共享同一份 listeners 与一次性 buffer——仍限定“当前应用进程”，不引入 Redis/DB/
 * 持久账本。TTL、每线程缓冲上限、清理语义保持不变。
 */

import { SSE_BUFFER_SIZE } from "@/lib/conversations/sse-transport";
import type { ThreadTransientGeneration } from "@/lib/runtime/thread-generation";

/**
 * `ThreadTransientEvent.generation` 的执行代际标记（A11）。
 *
 * 定义在同源契约模块 `lib/runtime/thread-generation.ts`：服务端发布与浏览器解析必须使用
 * 同一份定义（invocation/attempt/ownership/epoch），因此不在这里另立一份。
 */
export interface ThreadTransientEvent {
  readonly transientId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly generation: ThreadTransientGeneration;
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

/**
 * 订阅句柄（A11 初始化 barrier）。
 *
 * 语义：subscribe 之后、release 之前，**任何事件都不会投递给 listener**——包括一次性 buffer
 * 的 drain 结果与这段时间内实时到达的事件，二者都进入 `pendingEvents`（有界）。调用方必须先取到
 * 权威代际基线，再用 `release(accept)` 打开 barrier。
 */
export interface ThreadTransientSubscription {
  /** 尚未投递的暂存事件（到达顺序，最多 `MAX_BUFFERED_EVENTS_PER_THREAD` 条）。 */
  readonly pendingEvents: readonly ThreadTransientEvent[];
  /**
   * 打开 barrier（幂等）。
   *
   * 先按 `accept` 过滤 `pendingEvents` 并投递（返回 false 的丢弃），再进入实时投递：后续事件同样
   * 只在 `accept` 为真时投递。A11 要求调用方在拿到**权威代际基线之后**才调用本方法；
   * 基线之前调用即等于把旧代际增量输出在基线之前。
   */
  release(accept: (event: ThreadTransientEvent) => boolean): void;
  /** 取消订阅（幂等）；未投递的暂存一并丢弃。 */
  unsubscribe(): void;
}

export function subscribeThreadTransientEvents(
  threadId: string,
  listener: Listener,
): ThreadTransientSubscription {
  const { bufferByThread, listenersByThread } = getBusState();
  const pendingEvents: ThreadTransientEvent[] = [];
  let released = false;
  let closed = false;
  let accept: ((event: ThreadTransientEvent) => boolean) | null = null;

  /** publish/订阅句柄内部统一的投递入口：barrier 未打开 → 暂存；打开后 → 过滤后投递。 */
  const deliver = (event: ThreadTransientEvent): void => {
    if (closed) return;
    if (!released) {
      pendingEvents.push(event);
      // 与一次性 buffer 同上限：barrier 打开前的暂存必须有界，否则"基线读取期间"的
      // 高频增量可以无限堆积（旧实现靠同步 drain 规避，代价是丢掉了代际隔离）。
      if (pendingEvents.length > MAX_BUFFERED_EVENTS_PER_THREAD) {
        pendingEvents.splice(0, pendingEvents.length - MAX_BUFFERED_EVENTS_PER_THREAD);
      }
      return;
    }
    if (accept && !accept(event)) return;
    listener(event);
  };

  const listeners = listenersByThread.get(threadId) ?? new Set<Listener>();
  listeners.add(deliver);
  listenersByThread.set(threadId, listeners);

  // 原子 drain：取出当前一次性 buffer 并立即删除，最多消费一次。
  // 注意：**取出即删除**保证"最多一次"，但**不直接调用 listener** —— 交给 barrier 暂存，
  // 等权威基线到来后按 exact tuple 过滤。这正是 A11 修掉的缺口。
  const drained = pruneBuffer(threadId);
  bufferByThread.delete(threadId);
  for (const entry of drained) deliver(entry.event);

  return {
    get pendingEvents(): readonly ThreadTransientEvent[] {
      return pendingEvents;
    },
    release: (acceptFn) => {
      if (released || closed) return;
      released = true;
      accept = acceptFn;
      // 复制后清空：投递过程中若发生嵌套 publish，新事件走实时分支而不是再进暂存。
      const pending = pendingEvents.splice(0, pendingEvents.length);
      for (const event of pending) {
        if (acceptFn(event)) listener(event);
      }
    },
    unsubscribe: () => {
      if (closed) return;
      closed = true;
      const current = listenersByThread.get(threadId);
      current?.delete(deliver);
      if (current?.size === 0) listenersByThread.delete(threadId);
      pendingEvents.length = 0;
    },
  };
}
