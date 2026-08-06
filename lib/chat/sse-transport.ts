/**
 * SSE 订阅式 ChatTransport（B-4 断连自动重连 + sequence 续传）。
 *
 * 替代 DefaultChatTransport 的单次 POST 流式模式，改为「POST 提交任务 + GET SSE 订阅」两段式：
 * 1. sendMessages：POST /api/chat → 响应 { ok, data: { runId } }。
 * 2. 拿到 runId 后 GET /api/threads/[threadId]/stream?runId=xxx 订阅 SSE。
 * 3. SSE 的 data: { "sequence": N, "chunk": <UIMessageChunk> }\n\n 用自定义 SSE parser 解析。
 *
 * useChat 契约不变（sendMessages 返回 UIMessageChunk 流），仅传输层从「POST 直流」变「POST+SSE」。
 * 后端执行生命周期独立于本次 HTTP 请求（runner 托管），切走/刷新不杀执行（B-1）。
 *
 * stop：useChat 的 stop() 触发 abortSignal → 中断 SSE fetch；后端 runner 仍跑，
 * 由用户点停止按钮调 /api/threads/[id]/cancel 显式 cancel（见 chat-panel stop 逻辑）。
 *
 * B-4 断连重连：SSE 非主动断开（网络抖动 / 服务重启）时，transport 内部自动重新订阅。
 * 后端为每个 chunk 附带 sequence；前端记录 lastSeq，重连时传 afterSeq，
 * 后端先从 DB 补 chunk，再接 broadcaster 实时流。sequence 去重避免重复显示旧 chunk。
 * 用 data-artifact chunk 作为「run 正常完成」终止信号；abortSignal 触发=用户主动停止。
 * 重连 3 次（1s/2s/4s 退避）仍失败 → onReconnectStateChange("failed")，UI 报错不静默转圈。
 */

import { apiPath } from "@/lib/api-fetch";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

/** SSE 事件结构。 */
interface SseEvent {
 event?: string;
 data?: string;
 id?: string;
}

/** 后端 SSE data 包装：每个 chunk 附带 sequence，用于断点续传。 */
interface SequencedData {
 sequence: number;
 chunk: UIMessageChunk;
}

/** 简单 SSE 文本解析器（data/event/id/heartbeat/done）。 */
function createSseParser(): TransformStream<string, SseEvent> {
 let buffer = "";
 return new TransformStream<string, SseEvent>({
 transform(chunk, controller) {
 buffer += chunk;
 const lines = buffer.split("\n");
 buffer = lines.pop() ?? "";

 let current: SseEvent = {};
 for (const line of lines) {
 if (line === "") {
 if (current.data !== undefined || current.event !== undefined) {
 controller.enqueue(current);
 current = {};
 }
 continue;
 }
 if (line.startsWith(":")) continue;
 const colonIndex = line.indexOf(":");
 if (colonIndex === -1) continue;
 const field = line.slice(0, colonIndex);
 let value = line.slice(colonIndex + 1);
 if (value.startsWith(" ")) value = value.slice(1);
 if (field === "data") {
 current.data = current.data ? `${current.data}\n${value}` : value;
 } else if (field === "event") {
 current.event = value;
 } else if (field === "id") {
 current.id = value;
 }
 }
 },
 flush(controller) {
 if (buffer.length > 0) {
 const line = buffer;
 buffer = "";
 if (line !== "" && !line.startsWith(":")) {
 const colonIndex = line.indexOf(":");
 if (colonIndex !== -1) {
 const field = line.slice(0, colonIndex);
 let value = line.slice(colonIndex + 1);
 if (value.startsWith(" ")) value = value.slice(1);
 if (field === "data" || field === "event" || field === "id") {
 controller.enqueue({ [field]: value } as SseEvent);
 }
 }
 }
 }
 },
 });
}

export interface SseChatTransportInitOptions {
 /** POST 提交端点。默认 /api/chat。 */
 api?: string;
 /** SSE 订阅端点模板，{threadId}/{runId} 占位。默认 /api/threads/{threadId}/stream?runId={runId}。 */
 streamApi?: string;
 /** 自定义 fetch（测试注入）。 */
 fetch?: typeof globalThis.fetch;
 /** 组装请求 body 的钩子（与 DefaultChatTransport.prepareSendMessagesRequest 同语义）。 */
 prepareSendMessagesRequest?: (args: {
 api: string;
 id: string;
 messages: UIMessage[];
 body: Record<string, unknown>;
 trigger: "submit-message" | "regenerate-message";
 messageId: string | undefined;
 }) => { body?: Record<string, unknown>; headers?: Record<string, string> };
 /**
 * B-4：重连状态回调。SSE 非主动断开（网络抖动 / 服务重启）触发重连时通知 UI，
 * 让对话面显示「连接中断，正在重连…」。idle=恢复正常，reconnecting=重连中，failed=重连失败。
 */
 onReconnectStateChange?: (state: "idle" | "reconnecting" | "failed") => void;
 /** B-4：重连退避毫秒序列，默认 [1000, 2000, 4000]。序列长度即最大重连次数。测试可注入短值。 */
 backoffMs?: number[];
 /** POST 成功后的回调（用于清理编辑重发状态等）。 */
 onSendSuccess?: () => void;
}

export class SseChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
 implements ChatTransport<UI_MESSAGE>
{
 private readonly api: string;
 private readonly streamApiTemplate: string;
 private readonly fetchFn: typeof globalThis.fetch;
 private readonly prepareSendMessagesRequest?: SseChatTransportInitOptions["prepareSendMessagesRequest"];
 private readonly onReconnectStateChange?: SseChatTransportInitOptions["onReconnectStateChange"];
 private readonly onSendSuccess?: SseChatTransportInitOptions["onSendSuccess"];
 private readonly backoffMs: number[];
 /** B-4：最近一次 sendMessages 的 chatId/runId，供 reconnectToStream 重新订阅。 */
 private lastChatId: string | null = null;
 private lastRunId: string | null = null;

 constructor(options: SseChatTransportInitOptions = {}) {
 // apiPath：部署带 basePath（/snowharness）时给裸路径补前缀；无 basePath 时恒等。
 this.api = apiPath(options.api ?? "/api/chat");
 this.streamApiTemplate = apiPath(
 options.streamApi ?? "/api/threads/{threadId}/stream?runId={runId}",
 );
 // globalThis.fetch 解绑后调用会丢 this → "Illegal invocation"。bind 回 globalThis。
 this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
 this.prepareSendMessagesRequest = options.prepareSendMessagesRequest;
 this.onReconnectStateChange = options.onReconnectStateChange;
 this.onSendSuccess = options.onSendSuccess;
 this.backoffMs = options.backoffMs ?? [1000, 2000, 4000];
 }

 async sendMessages(
 options: {
 trigger: "submit-message" | "regenerate-message";
 chatId: string;
 messageId: string | undefined;
 messages: UI_MESSAGE[];
 abortSignal: AbortSignal | undefined;
 // biome-ignore lint/suspicious/noExplicitAny: ChatRequestOptions 跨版本字段，透传
 } & any,
 ): Promise<ReadableStream<UIMessageChunk>> {
 const baseBody: Record<string, unknown> = {
 ...options.body,
 id: options.chatId,
 messages: options.messages,
 trigger: options.trigger,
 messageId: options.messageId,
 };
 const prepared = this.prepareSendMessagesRequest?.({
 api: this.api,
 id: options.chatId,
 messages: options.messages,
 body: baseBody,
 trigger: options.trigger,
 messageId: options.messageId,
 });
 const body = prepared?.body ?? baseBody;
 const headers = { "Content-Type": "application/json", ...(prepared?.headers ?? {}) };

 // Step 1：POST 提交任务，拿 runId（非流式 JSON 响应）
 console.log("[SSE Transport] 🚀 开始发送消息", {
 chatId: options.chatId,
 messageCount: options.messages.length,
 timestamp: new Date().toISOString(),
 });

 const submitResponse = await this.fetchFn(this.api, {
 method: "POST",
 headers,
 body: JSON.stringify(body),
 credentials: "same-origin",
 signal: options.abortSignal,
 });
 if (!submitResponse.ok) {
 const text = await submitResponse.text().catch(() => "");
 console.error("[SSE Transport] ❌ POST失败", {
 status: submitResponse.status,
 statusText: submitResponse.statusText,
 errorBody: text.slice(0, 500),
 });
 throw new Error(text || "提交执行任务失败");
 }
 const submitJson = (await submitResponse.json().catch(() => null)) as {
 ok?: boolean;
 data?: { runId?: string };
 runId?: string;
 } | null;
 const runId = submitJson?.data?.runId ?? submitJson?.runId;

 console.log("[SSE Transport] ✅ POST成功，获取runId", {
 runId,
 fullResponse: JSON.stringify(submitJson).slice(0, 300),
 });

 if (!runId) {
 console.error("[SSE Transport] ❌ 响应中无runId", { submitJson });
 throw new Error("未收到 runId");
 }

 // B-4：记录本次 runId，供 reconnectToStream 重新订阅
 this.lastChatId = options.chatId;
 this.lastRunId = runId;

 // POST 成功后回调（用于清理编辑重发状态）
 this.onSendSuccess?.();

 // Step 2：GET SSE 订阅 runId，返回带断连重连的韧性流（S5-3）
 console.log("[SSE Transport] 🔄 开始订阅SSE流", {
 chatId: options.chatId,
 runId,
 });
 return this.createResilientStream(options.chatId, runId, options.abortSignal);
 }

 /**
 * B-4：重连到已有 run 的流（ChatTransport 接口契约 + 手动重连入口）。
 *
 * 用 sendMessages 时记录的 lastRunId 重新订阅。run 已不在内存或 chatId 不匹配 → null。
 * 返回带断连重连的韧性流，useChat 消费时同样享受自动重连。
 */
 async reconnectToStream(
 options: { chatId: string } & Record<string, unknown>,
 ): Promise<ReadableStream<UIMessageChunk> | null> {
 const chatId = options.chatId;
 const runId = this.lastRunId;
 if (!chatId || !runId || chatId !== this.lastChatId) return null;
 return this.createResilientStream(chatId, runId, undefined);
 }

 /**
 * 预设目标 runId，供后续 useChat.resumeStream() → reconnectToStream() 使用。
 *
 * 页面刷新/首次打开旧 thread 时，transport 没有 lastRunId 缓存。
 * 先调 setTargetRun 写入，再调 useChat 的 resumeStream()，
 * reconnectToStream 即可命中正确的 runId 并建立 SSE 订阅。
 */
 setTargetRun(chatId: string, runId: string): void {
 this.lastChatId = chatId;
 this.lastRunId = runId;
 }

 /**
 * 打开一次 SSE 订阅并解析为 { sequence, chunk } 流。
 *
 * 请求带 afterSeq，后端先从 DB 补 chunk，再接 broadcaster 实时流。
 * SSE data 格式为 `{ sequence, chunk }`，这里提取 sequence 供去重与重连续传。
 * heartbeat / done event 直接忽略；旧格式（无 sequence 的纯 UIMessageChunk）兼容处理。
 */
 private async openChunkStream(
 chatId: string,
 runId: string,
 abortSignal: AbortSignal | undefined,
 afterSeq: number,
 ): Promise<ReadableStream<SequencedData>> {
 const streamUrl = this.streamApiTemplate
 .replace("{threadId}", encodeURIComponent(chatId))
 .replace("{runId}", encodeURIComponent(runId));
 const url = new URL(
 streamUrl,
 typeof window !== "undefined" ? window.location.href : "http://localhost",
 );
 if (afterSeq >= 0) {
 url.searchParams.set("afterSeq", String(afterSeq));
 }

 console.log("[SSE Transport] 🔗 建立SSE连接", {
 url: url.toString(),
 afterSeq,
 timestamp: new Date().toISOString(),
 });

 const streamResponse = await this.fetchFn(url.toString(), {
 method: "GET",
 headers: { Accept: "text/event-stream" },
 credentials: "same-origin",
 signal: abortSignal,
 });

 console.log("[SSE Transport] 📡 SSE响应到达", {
 ok: streamResponse.ok,
 status: streamResponse.status,
 statusText: streamResponse.statusText,
 hasBody: !!streamResponse.body,
 });

 if (!streamResponse.ok || !streamResponse.body) {
 console.error("[SSE Transport] ❌ SSE连接失败", {
 status: streamResponse.status,
 statusText: streamResponse.statusText,
 });
 throw new Error(streamResponse.statusText || "订阅执行流失败");
 }

 let chunkCount = 0;
 let lastChunkTime = Date.now();

 return streamResponse.body
 .pipeThrough(new TextDecoderStream())
 .pipeThrough(createSseParser())
 .pipeThrough(
 new TransformStream<SseEvent, SequencedData>({
 transform(event, controller) {
 if (event.event === "heartbeat") {
 console.log("[SSE Transport] 💓 heartbeat");
 return;
 }
 if (event.event === "done") {
 console.log("[SSE Transport] ✅ 流结束(done事件)");
 return;
 }
 if (!event.data) {
 console.warn("[SSE Transport] ⚠️ 空data字段", { event: event.event });
 return;
 }

 chunkCount++;
 const now = Date.now();
 const interval = now - lastChunkTime;
 lastChunkTime = now;

 try {
 const parsed = JSON.parse(event.data);

 console.log(`[SSE Transport] 📦 收到chunk #${chunkCount}`, {
 event: event.event,
 sequence: parsed.sequence,
 chunkType: parsed.chunk?.type ?? parsed.type,
 dataPreview: event.data.slice(0, 150),
 intervalMs: interval,
 totalChunks: chunkCount,
 });

 if (parsed.sequence !== undefined && parsed.chunk) {
 controller.enqueue({
 sequence: parsed.sequence,
 chunk: parsed.chunk as UIMessageChunk,
 });
 } else if (parsed.type) {
 // 兼容旧格式：直接是 UIMessageChunk（无 sequence）
 console.log("[SSE Transport] 兼容旧格式chunk");
 controller.enqueue({ sequence: -1, chunk: parsed as UIMessageChunk });
 }
 } catch {
 // 忽略无法解析的 data
 }
 },
 }),
 );
 }

 /**
 * 构造带断连重连 + sequence 去重续传的韧性流，对 useChat 透明。
 *
 * - lastSeq：已转发给 useChat 的最大 sequence。重连后后端会按 afterSeq 过滤 DB chunks，
 * broadcaster 仍会回放历史；这里用 sequence <= lastSeq 跳过，只续传新产出。
 * - sawTerminal：收到 data-artifact chunk = run 正常完成（onFinish 发出），流结束不重连。
 * - abortSignal.aborted：用户主动 stop，流结束不重连。
 * - 重连后仍无新产出（gotNewThisRound=false）= run 已终态（完成/失败/不在内存），不再重连。
 * - 退避 1s/2s/4s，最多 3 次；超限 onReconnectStateChange("failed")，UI 报错不静默转圈。
 */
 private createResilientStream(
 chatId: string,
 runId: string,
 abortSignal: AbortSignal | undefined,
 ): ReadableStream<UIMessageChunk> {
 const self = this;
 let lastSeq = -1;
 let attempt = 0;
 let sawTerminal = false;
 let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
 let closed = false;
 const maxAttempts = self.backoffMs.length;
 const backoffMs = self.backoffMs;

 const safeClose = () => {
 if (closed) return;
 closed = true;
 try {
 controller?.close();
 } catch {
 // 已关闭，忽略
 }
 };

 // 退避等待，abortSignal 触发时立即解除（让 stop 不被退避拖延）
 const sleep = (ms: number) =>
 new Promise<void>((resolve) => {
 const t = setTimeout(() => {
 clearTimeout(t);
 resolve();
 }, ms);
 abortSignal?.addEventListener(
 "abort",
 () => {
 clearTimeout(t);
 resolve();
 },
 { once: true },
 );
 });

 async function pump(): Promise<void> {
 if (closed) return;
 let gotNewThisRound = false;
 let connectFailed = false;

 console.log("[SSE Transport] 🔄 pump()开始", {
 attempt,
 lastSeq,
 closed,
 timestamp: new Date().toISOString(),
 });

 try {
 const stream = await self.openChunkStream(chatId, runId, abortSignal, lastSeq);
 // 重连成功恢复流（首次 attempt=0 本就 idle，无需通知）
 if (attempt > 0) {
 console.log(`[SSE Transport] ✅ 重连成功 (第${attempt}次)`);
 self.onReconnectStateChange?.("idle");
 }
 const reader = stream.getReader();
 let readCount = 0;
 try {
 for (;;) {
 if (closed) break;
 const { done, value } = await reader.read();
 if (done) {
 console.log("[SSE Transport] 📖 流读取完成", { readCount, attempt });
 break;
 }
 if (!value) continue;
 // 按 sequence 去重（兼容无 sequence 的旧格式，用 -1 兜底）
 if (value.sequence !== -1 && value.sequence <= lastSeq) {
 console.log("[SSE Transport] ⏭️ 跳过旧chunk", {
 receivedSeq: value.sequence,
 lastSeq,
 });
 continue;
 }
 readCount++;
 const chunk = value.chunk;
 const chunkType = (chunk as { type: string }).type;

 console.log(`[SSE Transport] ➡️ 转发chunk #${readCount}`, {
 sequence: value.sequence,
 chunkType,
 attempt,
 });

 // 审计修复：仅 data-artifact 为终态信号。error chunk 是 mid-stream 通知，
 // run 可能在 onError 后继续产出（如多步工具调用中单步失败但后续成功）。
 // 原实现把 error 也当终态 → 客户端提前断连，丢失后续所有 chunk。
 if (chunkType === "data-artifact") {
 console.log("[SSE Transport] 🏁 收到终态信号(data-artifact)");
 sawTerminal = true;
 }
 controller?.enqueue(chunk);
 if (value.sequence !== -1) lastSeq = value.sequence;
 gotNewThisRound = true;
 }
 } finally {
 reader.releaseLock();
 }
 } catch (streamError) {
 connectFailed = true;
 console.error("[SSE Transport] ❌ pump()异常", {
 attempt,
 error: streamError instanceof Error ? streamError.message : String(streamError),
 willRetry: attempt < maxAttempts,
 });
 }
 if (closed) {
 console.log("[SSE Transport] 🔒 流已关闭");
 return;
 }
 // 正常完成 / 用户主动停止 → 结束
 if (sawTerminal || abortSignal?.aborted) {
 console.log("[SSE Transport] ✅ 正常结束", { sawTerminal, aborted: abortSignal?.aborted });
 safeClose();
 return;
 }
 // 重连后成功订阅但无新产出 = run 已终态（完成/失败/不在内存），正常结束不报错
 if (attempt > 0 && !gotNewThisRound && !connectFailed) {
 console.log("[SSE Transport] ℹ️ 重连后无新产出，run可能已结束");
 safeClose();
 return;
 }
 // 异常断开 → 退避重连
 if (attempt < maxAttempts) {
 attempt++;
 const delay = backoffMs[attempt - 1] ?? 4000;
 console.log(`[SSE Transport] ⏳ 准备重连 (第${attempt}次, 延迟${delay}ms)`);
 self.onReconnectStateChange?.("reconnecting");
 await sleep(delay);
 if (abortSignal?.aborted || closed) {
 safeClose();
 return;
 }
 await pump();
 } else {
 console.error(`[SSE Transport] ❌ 重连次数耗尽 (${maxAttempts}次)`);
 self.onReconnectStateChange?.("failed");
 safeClose();
 }
 }

 return new ReadableStream<UIMessageChunk>({
 start(ctl) {
 controller = ctl;
 void pump();
 },
 cancel() {
 closed = true;
 },
 });
 }
}
