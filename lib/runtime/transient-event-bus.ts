/**
 * Thread transient 事件总线。
 *
 * response.delta 不进入持久账本，只在当前应用进程内推送给 SSE 订阅者。
 * 短期缓冲用于覆盖“首条消息已开始生成、桌面端随后才建立 SSE”的时间窗。
 */

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

const BUFFER_TTL_MS = 2 * 60 * 1000;
const MAX_BUFFERED_EVENTS_PER_THREAD = 1000;
const listenersByThread = new Map<string, Set<Listener>>();
const bufferByThread = new Map<string, BufferedEvent[]>();

function pruneBuffer(threadId: string, now = Date.now()): BufferedEvent[] {
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
 const live = pruneBuffer(event.threadId);
 const next = [
 ...live,
 {
 event,
 expiresAt: Date.now() + BUFFER_TTL_MS,
 },
 ].slice(-MAX_BUFFERED_EVENTS_PER_THREAD);
 bufferByThread.set(event.threadId, next);

 for (const listener of listenersByThread.get(event.threadId) ?? []) {
 listener(event);
 }
}

export function subscribeThreadTransientEvents(threadId: string, listener: Listener): () => void {
 const listeners = listenersByThread.get(threadId) ?? new Set<Listener>();
 listeners.add(listener);
 listenersByThread.set(threadId, listeners);

 for (const entry of pruneBuffer(threadId)) {
 listener(entry.event);
 }

 return () => {
 const current = listenersByThread.get(threadId);
 current?.delete(listener);
 if (current?.size === 0) listenersByThread.delete(threadId);
 };
}
