/**
 * V11 员工端 SSE 客户端。
 *
 * 事实源：
 * - app/api/v1/threads/[thread_id]/events/route.ts（SSE 响应格式）
 * - docs/solutions/v11-agentkit-platform/11-api-and-event-boundaries.md 
 * - docs/solutions/v11-agentkit-platform-development-plan/10-employee-web-and-desktop-experience.md S10-W07
 *
 * 关键约束：
 * - 浏览器原生 EventSource 不支持自定义 header，不能用 Last-Event-ID；
 * 必须用 fetch + ReadableStream 手动实现 SSE 解析。
 * - 每条事件：id=event_sequence（十进制），event=event_type，data=投影 JSON。
 * - stream.resumed / stream.backpressure 是流控制事件，不进入 reducer 的投影路径。
 * - EVENT_CURSOR_EXPIRED 是 409 + JSON body（不是 SSE 流），需要在 fetch 层捕获。
 *
 * 重连策略：
 * - 网络中断 → 指数退避（500ms / 1s / 2s / 4s / 8s，最大 8s），最多 5 次后 failed。
 * - EVENT_CURSOR_EXPIRED → 立即触发 onCursorExpired，不自动重连。
 * - 409 其他错误 → failed。
 * - 4xx（除 409）→ failed（不自动重试）。
 * - 5xx → 按网络中断处理（自动重试）。
 */
import { apiPath } from "../../api-fetch";
import { makeLocalVisibleError, toVisibleError } from "./error-messages";
import type {
 ClientErrorBody,
 ClientEvent,
 ClientTransientDelta,
 ClientVisibleError,
} from "./types";

/** SSE 客户端回调。 */
export interface SSEClientCallbacks {
 /** 收到事件（已通过基本解析，未做业务去重）。 */
 onEvent(event: ClientEvent): void;
 /** 收到不推进持久游标的模型正文增量。 */
 onTransient(event: ClientTransientDelta): void;
 /** 连接打开（fetch 拿到 200 header）。 */
 onOpen(): void;
 /** 进入重连流程。 */
 onReconnecting(attempt: number): void;
 /** 服务端告知 cursor 过期。 */
 onCursorExpired(error: ClientVisibleError): void;
 /** 无法恢复的失败。 */
 onFailed(error: ClientVisibleError): void;
}

/** SSE 客户端配置。 */
export interface SSEClientConfig {
 /** Thread id。 */
 threadId: string;
 /** 初始 Last-Event-ID（断线重连时由调用方更新）。 */
 getLastEventId(): number | null;
 /** 自定义 fetch（测试用）。 */
 fetchImpl?: typeof fetch;
 /** 最大重试次数。 */
 maxRetries?: number;
 /** 基础退避毫秒数。 */
 baseBackoffMs?: number;
}

/** SSE 客户端句柄。 */
export interface SSEClientHandle {
 /** 启动连接。 */
 start(): void;
 /** 主动关闭（不自动重连）。 */
 close(): void;
 /** 当前是否已关闭。 */
 isClosed(): boolean;
}

/** SSE 断线重连次数上限（UI 展示"正在重新连接 N/M"时的 M）。 */
export const V11_SSE_DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_BACKOFF_MS = 500;

/** 解析 SSE 数据块，返回完整事件列表和剩余缓冲。 */
function parseSSEChunk(buffer: string): {
 events: Array<{ id: string | null; event: string; data: string }>;
 remaining: string;
} {
 const events: Array<{ id: string | null; event: string; data: string }> = [];
 // SSE 规范：事件由空行分隔
 const parts = buffer.split("\n\n");
 // 最后一段可能不完整，保留到下次
 const remaining = parts.pop() ?? "";

 for (const part of parts) {
 if (!part.trim()) continue;
 let id: string | null = null;
 let event = "message";
 const dataLines: string[] = [];
 for (const line of part.split("\n")) {
 if (line.startsWith("id:")) {
 id = line.slice(3).trim();
 } else if (line.startsWith("event:")) {
 event = line.slice(6).trim();
 } else if (line.startsWith("data:")) {
 dataLines.push(line.slice(5).replace(/^ /, ""));
 }
 }
 if (dataLines.length > 0) {
 events.push({ id, event, data: dataLines.join("\n") });
 }
 }
 return { events, remaining };
}

/** 创建 SSE 客户端。 */
export function createSSEClient(
 config: SSEClientConfig,
 callbacks: SSEClientCallbacks,
): SSEClientHandle {
 const fetchImpl = config.fetchImpl ?? fetch;
 const maxRetries = config.maxRetries ?? V11_SSE_DEFAULT_MAX_RETRIES;
 const baseBackoffMs = config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;

 let closed = false;
 let abortController: AbortController | null = null;
 let retryCount = 0;
 let retryTimer: ReturnType<typeof setTimeout> | null = null;

 async function connect(): Promise<void> {
 if (closed) return;

 abortController = new AbortController();
 const lastEventId = config.getLastEventId();
 const headers: Record<string, string> = {
 accept: "text/event-stream",
 };
 if (lastEventId !== null && lastEventId > 0) {
 headers["last-event-id"] = String(lastEventId);
 }

 let response: Response;
 try {
 response = await fetchImpl(apiPath(`/api/v1/threads/${config.threadId}/events`), {
 method: "GET",
 headers,
 credentials: "include",
 signal: abortController.signal,
 cache: "no-store",
 });
 } catch (err) {
 // AbortError：主动 close 或组件卸载，不重连
 if (err instanceof Error && err.name === "AbortError") return;
 scheduleRetry();
 return;
 }

 if (closed) return;

 // 错误分支
 if (!response.ok) {
 const bodyText = await response.text().catch(() => "");
 let errorBody: ClientErrorBody | null = null;
 try {
 errorBody = JSON.parse(bodyText) as ClientErrorBody;
 } catch {
 // 非 JSON 响应
 }

 if (response.status === 409 && errorBody?.error?.code === "EVENT_CURSOR_EXPIRED") {
 callbacks.onCursorExpired(toVisibleError(errorBody));
 return;
 }

 if (response.status >= 500) {
 scheduleRetry();
 return;
 }

 // 4xx：鉴权失败 / 404 / 400 等，不重连
 const visible = errorBody
 ? toVisibleError(errorBody)
 : makeLocalVisibleError({
 code: "RESOURCE_NOT_FOUND",
 retryable: false,
 });
 callbacks.onFailed(visible);
 return;
 }

 if (!response.body) {
 callbacks.onFailed(makeLocalVisibleError({ code: "STREAM_BACKPRESSURE", retryable: true }));
 return;
 }

 // 成功打开
 retryCount = 0;
 callbacks.onOpen();

 // 读取流
 const reader = response.body.getReader();
 const decoder = new TextDecoder();
 let buffer = "";

 try {
 while (!closed) {
 const { done, value } = await reader.read();
 if (done) break;
 buffer += decoder.decode(value, { stream: true });

 const { events, remaining } = parseSSEChunk(buffer);
 buffer = remaining;

 for (const raw of events) {
 // 流控制事件不进入业务路径
 if (raw.event === "stream.backpressure") {
 scheduleRetry();
 return;
 }

 let data: Record<string, unknown>;
 try {
 data = JSON.parse(raw.data) as Record<string, unknown>;
 } catch {
 continue;
 }

 if (raw.event === "response.delta") {
 const payload =
 data.payload && typeof data.payload === "object"
 ? (data.payload as Record<string, unknown>)
 : null;
 if (
 typeof data.transient_id === "string" &&
 typeof data.thread_id === "string" &&
 typeof data.turn_id === "string" &&
 typeof payload?.delta === "string"
 ) {
 callbacks.onTransient({
 transient_id: data.transient_id,
 thread_id: data.thread_id,
 turn_id: data.turn_id,
 occurred_at:
 typeof data.occurred_at === "string"
 ? data.occurred_at
 : new Date().toISOString(),
 delta: payload.delta,
 });
 }
 continue;
 }

 const eventId = typeof data.event_id === "string" ? data.event_id : raw.id;
 const sequence =
 typeof data.sequence === "number"
 ? data.sequence
 : raw.id !== null
 ? Number.parseInt(raw.id, 10)
 : null;
 if (eventId === null || sequence === null || !Number.isFinite(sequence)) {
 continue;
 }

 callbacks.onEvent({
 event_id: eventId,
 sequence,
 schema_version: typeof data.schema_version === "number" ? data.schema_version : 1,
 thread_id: typeof data.thread_id === "string" ? data.thread_id : config.threadId,
 turn_id: typeof data.turn_id === "string" ? data.turn_id : null,
 item_id: typeof data.item_id === "string" ? data.item_id : null,
 occurred_at:
 typeof data.occurred_at === "string" ? data.occurred_at : new Date().toISOString(),
 payload: data.payload,
 event_type: raw.event,
 });
 }
 }
 } catch (err) {
 if (err instanceof Error && err.name === "AbortError") return;
 } finally {
 reader.releaseLock();
 }

 // 流自然结束（不应发生于 SSE；视为网络中断）
 if (!closed) {
 scheduleRetry();
 }
 }

 function scheduleRetry(): void {
 if (closed) return;
 if (retryCount >= maxRetries) {
 callbacks.onFailed(makeLocalVisibleError({ code: "STREAM_BACKPRESSURE", retryable: true }));
 return;
 }
 retryCount += 1;
 callbacks.onReconnecting(retryCount);
 const backoff = Math.min(baseBackoffMs * 2 ** (retryCount - 1), 8000);
 retryTimer = setTimeout(() => {
 void connect();
 }, backoff);
 }

 return {
 start: () => {
 void connect();
 },
 close: () => {
 closed = true;
 if (retryTimer) {
 clearTimeout(retryTimer);
 retryTimer = null;
 }
 if (abortController) {
 abortController.abort();
 abortController = null;
 }
 },
 isClosed: () => closed,
 };
}
