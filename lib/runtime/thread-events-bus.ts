/**
 * 12-Thread 事件总线（进程内多播 + 跨实例 DB 轮询补推）。
 *
 * 设计与 onThreadStatusChange 一致：纯内存 Set<listener>，零延迟广播本实例事件；
 * 他实例的事件由 SSE 端点 DB 增量轮询补推（ThreadEvent 表是跨实例真相源）。
 *
 * 广播点：appendThreadEvent 成功插入后调用 broadcastThreadEvent。
 * 订阅点：/api/threads/stream SSE 端点订阅，按 threadId 过滤推给前端面板。
 *
 * 事件类型覆盖：subagent.spawned/joined/failed、tool.approval_requested/resolved、
 * task.started/stopped/failed、qa.check_passed/failed、agent.status_changed。
 * thread status 变更仍走 onThreadStatusChange（保留既有通道，不破坏侧栏）。
 */

export type ThreadEventPayload = {
 threadId: string;
 type: string;
 payload: unknown;
 sequence: number;
 createdAt: Date;
};

type ThreadEventListener = (event: ThreadEventPayload) => void;

const listeners = new Set<ThreadEventListener>();

/** 订阅进程内 ThreadEvent 广播。返回取消订阅函数。 */
export function onThreadEvent(listener: ThreadEventListener): () => void {
 listeners.add(listener);
 return () => {
 listeners.delete(listener);
 };
}

/** 广播一个 ThreadEvent 给所有订阅者（appendThreadEvent 成功后调用）。 */
export function broadcastThreadEvent(event: ThreadEventPayload): void {
 for (const listener of listeners) {
 try {
 listener(event);
 } catch {
 // 单个 listener 抛错不影响其他
 }
 }
}
