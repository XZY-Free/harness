/**
 * SSE 传输层（S04-C05）。
 *
 * 事实源：
 * - docs/architecture/api-and-events.md （订阅 Event：SSE id = 十进制 event_sequence）
 * - docs/architecture/security.md （SSE 背压与 cursor_expired）
 *
 * 职责：
 * - formatSSEMessage：把 {id, event, data} 格式化为 SSE 文本（id 可选，transient 事件不传 id）。
 * - createSSEStream：构建 ReadableStream<Uint8Array>，提供 enqueue/close 与背压检测。
 *
 * 关键约束（行 322-330）：
 * - 持久 Event 的 SSE id 就是十进制 event_sequence；transient 事件没有 SSE id。
 * - 有界缓冲：使用 CountQueuingStrategy（highWaterMark = SSE_BUFFER_SIZE），
 * desiredSize < 0 表示消费者落后超过缓冲容量，触发 onBackpressure 回调。
 * - 慢客户端断开不拖垮 Event 写入：AbortSignal 清理 interval，stream.cancel 触发 onAbort。
 */
import type { StreamType } from "@/lib/persistence/schema/projection";

/** thread_event 流类型（与 projector.ts 的 THREAD_EVENT_STREAM 一致）。 */
export const THREAD_EVENT_STREAM: StreamType = "thread_event";

/** SSE 有界缓冲大小（条数）。超过即触发背压。 */
export const SSE_BUFFER_SIZE = 100;

/** SSE 消息结构。id 可选——transient 事件不传 id。 */
export interface SSEMessage {
 /** SSE id 字段；持久 Event 为十进制 event_sequence，transient 不传。 */
 id?: number;
 /** SSE event 字段（事件类型）。 */
 event: string;
 /** SSE data 字段；对象自动 JSON.stringify。 */
 data: unknown;
}

/**
 * 格式化一条 SSE 消息为文本。
 *
 * 输出形如：
 * ```
 * id: 52
 * event: item.completed
 * data: {"event_id":"...","sequence":52,...}
 *
 * ```
 * （末尾空行 `\n\n` 终止消息）
 *
 * data 若为字符串则原样输出（支持多行，每行加 `data: ` 前缀）；
 * 其他类型 JSON.stringify 后输出。
 */
export function formatSSEMessage(message: SSEMessage): string {
 const lines: string[] = [];
 if (message.id !== undefined) {
 lines.push(`id: ${message.id}`);
 }
 lines.push(`event: ${message.event}`);
 const dataStr = typeof message.data === "string" ? message.data : JSON.stringify(message.data);
 for (const line of dataStr.split("\n")) {
 lines.push(`data: ${line}`);
 }
 return `${lines.join("\n")}\n\n`;
}

/** createSSEStream 回调选项。 */
export interface SSEStreamOptions {
 /** 缓冲满（desiredSize < 0）时回调；调用方应发送 stream.backpressure 并关闭。 */
 onBackpressure?: () => void;
 /** 流内部错误回调（enqueue 异常等）。 */
 onError?: (error: unknown) => void;
 /** 消费者取消流（客户端断开）回调。 */
 onAbort?: () => void;
}

/** createSSEStream 返回的流句柄。 */
export interface SSEStreamHandle {
 /** ReadableStream，作为 Response body。 */
 readable: ReadableStream<Uint8Array>;
 /** 底层 controller（背压回调中直接 enqueue 最终消息用）。 */
 controller: ReadableStreamDefaultController<Uint8Array> | null;
 /**
 * 发送一条 SSE 消息。
 *
 * @param event SSE event 字段
 * @param data SSE data 字段（对象自动 JSON.stringify）
 * @param id SSE id 字段（可选；持久 Event 传 event_sequence，transient 不传）
 * @returns true 表示成功入队；false 表示流已关闭或触发背压（消息未入队）
 */
 enqueue: (event: string, data: unknown, id?: number) => boolean;
 /** 关闭流。 */
 close: () => void;
}

/**
 * 创建一个 SSE 流（ReadableStream<Uint8Array> + TextEncoder）。
 *
 * 使用 CountQueuingStrategy（highWaterMark = SSE_BUFFER_SIZE）实现有界缓冲：
 * - desiredSize 初始为 SSE_BUFFER_SIZE，每 enqueue 一条减 1，消费者读取后加 1。
 * - desiredSize < 0 表示消费者落后超过缓冲容量，触发 onBackpressure 回调，
 * 当前消息不入队（由回调决定发送 stream.backpressure 并关闭）。
 *
 * 消费者取消流（reader.cancel 或 Response 取消）时触发 cancel → onAbort。
 */
export function createSSEStream(options?: SSEStreamOptions): SSEStreamHandle {
 const encoder = new TextEncoder();
 let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
 let closed = false;

 const stream = new ReadableStream<Uint8Array>(
 {
 start(c) {
 controller = c;
 },
 cancel() {
 closed = true;
 options?.onAbort?.();
 },
 },
 new CountQueuingStrategy({ highWaterMark: SSE_BUFFER_SIZE }),
 );

 const enqueue = (event: string, data: unknown, id?: number): boolean => {
 if (closed || !controller) return false;
 // 背压检测：desiredSize < 0 表示缓冲已满
 if (controller.desiredSize !== null && controller.desiredSize < 0) {
 options?.onBackpressure?.();
 return false;
 }
 const message = formatSSEMessage({ id, event, data });
 try {
 controller.enqueue(encoder.encode(message));
 return true;
 } catch (err) {
 closed = true;
 options?.onError?.(err);
 return false;
 }
 };

 const close = (): void => {
 if (closed) return;
 closed = true;
 if (controller) {
 try {
 controller.close();
 } catch {
 // 流已关闭，忽略
 }
 }
 };

 return { readable: stream, controller, enqueue, close };
}
