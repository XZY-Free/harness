/**
 * V4 Phase B-1：Thread Run 运行管理器（服务端后台执行 + SSE 订阅）。
 *
 * 把 agent 执行生命周期从「绑死当前 HTTP 请求」解耦为「进程内独立运行 + 多客户端订阅」。
 * - POST /api/chat 不再直接返回流式 response，而是 enqueue 一个 run → 立即返回 runId。
 * - GET /api/threads/[id]/stream?runId=xxx 订阅 run 的 UIMessageChunk 流（多视图 + 断连重连回放）。
 * - stop 按钮 → cancel(runId) → AbortController.abort() → streamText 收到 signal 立即停（B-5）。
 * - reaper 定时器回收超时 run（B-2）；cancel 时 flush 已产出消息（B-3）。
 *
 * 设计：RunBroadcaster 多播 + 历史回放。run 内部驱动 createUIMessageStream，逐 chunk 喂给
 * broadcaster；subscribe 时新订阅者先收历史 chunks（追平），再接实时。SSE 断连重连不丢已产出。
 *
 * 对标：Codex 桌面版「任务在服务端跑，会话只是视图」。
 */

import { finalizeThreadRun } from "@/lib/ai/preview-gate";
import {
 clearThreadProjectScope,
 clearThreadRunScope,
 clearThreadSkillScope,
 setThreadProjectScope,
 setThreadRunScope,
} from "@/lib/ai/tool-runtime";
import type { SkillLoadEvidenceEntry } from "@/lib/ai/tools";
import { aiConfig } from "@/lib/config";
import {
 ACTIVE_THREAD_STATUSES,
 appendRunTranscriptChunk,
 appendThreadEvent,
 attachSkillLoadEvidence,
 cancelThreadRun as cancelThreadRunDb,
 completeThreadRun,
 failRunningToolRunsForThread,
 failThreadRun,
 getThreadById,
 heartbeatThreadRun,
 incrementThreadTokens,
 saveMessages,
 updateThreadPreviewUrl,
 updateThreadStatus,
 upsertMessageParts,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { redactObject, redactText } from "@/lib/runtime/secret-redaction";
import { stopAllSubagents } from "@/lib/subagent/registry";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";
import {
 type ModelMessage,
 type UIMessageChunk,
 createUIMessageStream,
 stepCountIs,
 streamText,
} from "ai";

/** 运行状态机。run 一旦进入 done/cancelled/failed 终态即不再变。 */
export type RunStatus = "running" | "done" | "cancelled" | "failed";

/** 提交 run 所需的执行参数（由 route.ts 前置段组装好后传入）。 */
export interface RunParams {
 threadId: string;
 /**
 * 预创建的 ThreadRun id（由 DB 事实源生成）。
 * 未传时回退 generateUUID（向后兼容测试等场景）。
 */
 runId?: string;
 /** 已组装好的 model messages（含 system / history / tools 上下文）。 */
 modelMessages: ModelMessage[];
 system: string;
 /** 模型 id（getChatModel 用）。 */
 modelId: string;
 /** streamText tools（buildTools 产物）。 */
 // biome-ignore lint/suspicious/noExplicitAny: ai SDK tool 类型跨版本复杂，沿用 route.ts 现状
 tools: any;
 /** getChatModel 工厂（避免 runner 直接依赖 provider 模块，便于测试注入）。 */
 // biome-ignore lint/suspicious/noExplicitAny: 同上
 getChatModel: (modelId: string) => any;
 /**
 * 完整化:streamText 失败时标记当前 endpoint 失败(熔断计数)。
 * 可选(未注入则不熔断);route 注入 provider.markCurrentEndpointFailed。
 */
 markEndpointFailed?: () => void;
 /**
 * V8：readSkillFile 加载证据累积器（由 chat route 的 skillContext.evidence 传入）。
 * 运行结束 flush 到 ContextSnapshot.skillLoadEvidence；未使用 Skill 时为 undefined。
 */
 skillLoadEvidence?: SkillLoadEvidenceEntry[];
}

interface LiveRun {
 threadId: string;
 runId: string;
 status: RunStatus;
 startedAt: number;
 abortController: AbortController;
 broadcaster: RunBroadcaster;
 /** cancel/done 时落库的最终 assistant 消息（ onFinish 累积）。 */
 finalMessages: ChatMessage[];
 /**
 * B-3：消息是否已开始落库（onFinish 内 await saveMessages 前置标志）。
 * cancelRun 据此判断是否需要兜底 flush，避免与 onFinish 双写。
 */
 saveStarted: boolean;
 /**
 * B-3：run 完成信号。driveRun 的 reader 循环结束时 resolve（此时 onFinish 已至少
 * 设置好 finalMessages + 启动落库）。cancelRun await 它，避免 abort 后立即读
 * finalMessages 拿到 [] 的竞态导致整条回复落空。
 */
 completionResolve: (() => void) | null;
 completionPromise: Promise<void>;
 /**
 * 审计修复：onFinish 内 finalizeThreadRun 的 Promise。cancelRun await 它，
 * 确保 finalizeThreadRun 的 updateThreadStatus("idle") 先落库，再用 "cancelled"
 * 覆写——替代原 200ms 硬编码 sleep（高负载时 finalize 可能超过 200ms，导致 "idle"
 * 在 "cancelled" 之后落库，最终状态变为 idle 而非 cancelled）。
 */
 finalizeResolve: (() => void) | null;
 finalizePromise: Promise<void>;
 /**
 * 审计修复：取消竞态保护标志。当 cancelRun 的 5s finalize 超时到期但 finalizeThreadRun
 * 仍未完成时，设为 true。onFinish 内的 finalize 完成后检查此标志，若为 true 则跳过
 * updateThreadStatus（防止 "idle" 覆盖 cancelRun 已写入的 "cancelled"）。
 */
 cancelledOverride: boolean;
 /**
 * streamText onFinish 捕获的 token 用量，markDone 写回 ThreadRun 时消费。
 * 若 onFinish 未触发或无用量数据则为 null。
 */
 totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
 /** V7 审计修复：持续刷新 ThreadRun.lastSeenAt，避免长任务被 stale sweep 误判失联。 */
 heartbeatTimer: NodeJS.Timeout | null;
 /** V8：readSkillFile 加载证据累积器（运行结束 flush 到 ContextSnapshot）。 */
 skillLoadEvidence: SkillLoadEvidenceEntry[] | null;
}

const DEFAULT_MAX_RUN_MS = 5 * 60_000; // 5 分钟，与 reaper 对齐
const REAPER_INTERVAL_MS = 30_000;
const THREAD_RUN_HEARTBEAT_MS = 30_000;

/**
 * GLM-5.x 在百炼默认开启较长思考。编码 agent 需要保留少量决策能力，但不能在工具调用前
 * 展开完整文件代码，因此默认降到 minimal；显式环境配置优先，其他模型不擅自传参数。
 */
export function resolveReasoningEffort(modelId: string): string | undefined {
 if (aiConfig.reasoningEffort) return aiConfig.reasoningEffort;
 return /^glm-5(?:\.|$)/i.test(modelId) ? "minimal" : undefined;
}

/** GLM 重试不携带历史 reasoning，避免中断的长思考再次占用上下文并影响工具决策。 */
export function resolveProviderOptions(modelId: string) {
 const reasoningEffort = resolveReasoningEffort(modelId);
 return {
 ...(reasoningEffort ? { openaiCompatible: { reasoningEffort } } : {}),
 ...(/^glm-5(?:\.|$)/i.test(modelId) ? { snowLlm: { clear_thinking: true } } : {}),
 };
}

/**
 * B-2: 解析 run 最大时长（ms）。优先 env `THREAD_RUN_MAX_MS`，缺省/非法回落 DEFAULT_MAX_RUN_MS。
 * 可配：运维不改码即可调整 reaper 超时阈值（长任务环境调大、成本敏感环境调小）。
 */
export function resolveMaxRunMs(): number {
 const raw = process.env.THREAD_RUN_MAX_MS;
 if (!raw) return DEFAULT_MAX_RUN_MS;
 const n = Number(raw);
 return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_MS;
}

const liveRuns = new Map<string, LiveRun>();
let reaperTimer: NodeJS.Timeout | null = null;

/**
 * B-6：全局 thread 状态广播 hub。
 *
 * 任何 thread 的 status 变更（enqueue→executing / markDone→终态 / cancelRun→failed）都广播，
 * /api/threads/stream 全局 SSE 端点订阅它，推给侧栏实时刷新徽标。
 *
 * 双通道：本 hub 负责本实例即时广播（内存 Set<callback>，零延迟）；他实例的变更由 SSE 端点
 * 轮询 DB（listThreadStatusChanges，updateThreadStatus 每次变更同步刷 updatedAt）补推。
 * 跨实例可见性已完整实现，非降级。
 */
type StatusListener = (event: { threadId: string; status: RunStatus; runId: string }) => void;
const statusListeners = new Set<StatusListener>();

/** 订阅全局 thread 状态变更（B-6 全局 SSE 用）。返回取消订阅函数。 */
export function onThreadStatusChange(listener: StatusListener): () => void {
 statusListeners.add(listener);
 return () => statusListeners.delete(listener);
}

function broadcastStatus(threadId: string, runId: string, status: RunStatus): void {
 for (const listener of statusListeners) {
 try {
 listener({ threadId, status, runId });
 } catch {
 // 单个 listener 抛错不影响其他
 }
 }
}

/**
 * RunBroadcaster：一个 run 的多播 + 历史回放 + /S5-3 持久化与续传。
 *
 * - publish(chunk)：分配 run 内 sequence，写入历史 + 推给所有当前订阅者 + 异步落 DB（best-effort）。
 * - subscribe()：返回新 ReadableStream，元素为 { sequence, chunk }；先回放历史，再接实时。
 */
export interface SequencedChunk {
 sequence: number;
 chunk: UIMessageChunk;
}

class RunBroadcaster {
 private history: SequencedChunk[] = [];
 private subscribers = new Set<{ push: (c: SequencedChunk) => void; close: () => void }>();
 private finished = false;
 private nextSequence = 1;
 private threadId: string;
 private runId: string;

 constructor(threadId: string, runId: string) {
 this.threadId = threadId;
 this.runId = runId;
 }

 publish(chunk: UIMessageChunk): void {
 if (this.finished) return;
 const sequence = this.nextSequence++;
 const item: SequencedChunk = { sequence, chunk };
 this.history.push(item);
 for (const sub of this.subscribers) sub.push(item);

 // /S5-3：异步落 DB（best-effort，失败不阻断），sequence 由 broadcaster 前置分配，
 // 保证内存流顺序与 DB 一致。
 void appendRunTranscriptChunk({
 threadId: this.threadId,
 runId: this.runId,
 kind: "ui_message_chunk",
 payload: redactObject(chunk, this.threadId),
 sequence,
 }).catch((err) => {
 logger.warn("[thread-runner] 持久化 transcript chunk 失败", {
 runId: this.runId,
 error: String(err),
 });
 });
 }

 finish(): void {
 if (this.finished) return;
 this.finished = true;
 for (const sub of this.subscribers) sub.close();
 this.subscribers.clear();
 }

 /** 订阅：先回放历史，再接实时。返回的流被消费或取消都不影响其他订阅者。 */
 subscribe(): ReadableStream<SequencedChunk> {
 const self = this;
 const queue: SequencedChunk[] = [...this.history];
 let controller: ReadableStreamDefaultController<SequencedChunk> | null = null;
 let cancelled = false;

 const sub = {
 push: (c: SequencedChunk) => {
 if (!cancelled && controller) controller.enqueue(c);
 },
 close: () => {
 if (!cancelled && controller) {
 try {
 controller.close();
 } catch {
 // 已关闭，忽略
 }
 }
 },
 };

 if (this.finished) {
 // run 已结束：回放历史后立即关闭
 return new ReadableStream<SequencedChunk>({
 start(ctl) {
 for (const c of queue) ctl.enqueue(c);
 ctl.close();
 },
 });
 }

 this.subscribers.add(sub);
 return new ReadableStream<SequencedChunk>({
 start(ctl) {
 controller = ctl;
 // 先回放历史（订阅前的已产出 chunks）
 for (const c of queue) ctl.enqueue(c);
 },
 cancel() {
 cancelled = true;
 // 订阅者主动断开（SSE 关闭）→ 从集合移除，避免内存泄漏与无效推送
 self.subscribers.delete(sub);
 },
 });
 }

 get subscriberCount(): number {
 return this.subscribers.size;
 }
}

/** 启动 reaper 定时器（幂等：已启动则跳过）。服务进程内只跑一个。
 * maxRunMs 缺省读 env `THREAD_RUN_MAX_MS`（resolveMaxRunMs），测试可显式注入。 */
export function startReaper(maxRunMs = resolveMaxRunMs()): void {
 if (reaperTimer) return;
 reaperTimer = setInterval(() => {
 const now = Date.now();
 for (const [runId, run] of liveRuns) {
 if (run.status !== "running") continue;
 if (now - run.startedAt > maxRunMs) {
 logger.warn("[thread-runner] reaper 回收超时 run", {
 runId,
 threadId: run.threadId,
 elapsedMs: now - run.startedAt,
 });
 cancelRun(runId, "reaper_timeout").catch((err) =>
 logger.error("[thread-runner] reaper cancel 失败", { runId, error: String(err) }),
 );
 }
 }
 }, REAPER_INTERVAL_MS);
 // Node 进程退出时不阻塞
 if (reaperTimer && typeof reaperTimer.unref === "function") reaperTimer.unref();
}

/** 停止 reaper（测试用）。 */
export function stopReaper(): void {
 if (reaperTimer) {
 clearInterval(reaperTimer);
 reaperTimer = null;
 }
}

/**
 * 提交一个 run：立即返回 runId，内部异步驱动 streamText。
 *
 * 执行逻辑从 route.ts 执行段原样搬入（usage 落库 / finalizeThreadRun / data-artifact / onError），
 * 保证业务行为不变，仅生命周期托管方从 HTTP 请求改为进程内 runner。
 */
export function enqueue(params: RunParams): string {
 const { threadId, modelMessages, system, modelId, tools, getChatModel, markEndpointFailed } =
 params;
 // runId 优先用 DB 预创建的 ThreadRun id，未传时回退生成（向后兼容）。
 const runId = params.runId ?? generateUUID();
 const abortController = new AbortController();
 const broadcaster = new RunBroadcaster(threadId, runId);

 let completionResolve: (() => void) | null = null;
 const completionPromise = new Promise<void>((resolve) => {
 completionResolve = resolve;
 });
 let finalizeResolve: (() => void) | null = null;
 const finalizePromise = new Promise<void>((resolve) => {
 finalizeResolve = resolve;
 });
 const heartbeatTimer = setInterval(() => {
 void heartbeatThreadRun(runId).catch((err) => {
 logger.warn("[thread-runner] ThreadRun 心跳更新失败", {
 runId,
 threadId,
 error: String(err),
 });
 });
 }, THREAD_RUN_HEARTBEAT_MS);
 if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();

 const run: LiveRun = {
 threadId,
 runId,
 status: "running",
 startedAt: Date.now(),
 abortController,
 broadcaster,
 finalMessages: [],
 saveStarted: false,
 completionResolve,
 completionPromise,
 finalizeResolve,
 finalizePromise,
 cancelledOverride: false,
 totalUsage: null,
 heartbeatTimer,
 skillLoadEvidence: params.skillLoadEvidence ?? null,
 };
 liveRuns.set(runId, run);
 broadcastStatus(threadId, runId, "running"); // B-6：侧栏实时显示「执行中」

 // 异步驱动执行（不阻塞 enqueue 返回 runId）
 void driveRun(run, params).catch((err) => {
 logger.error("[thread-runner] driveRun 未捕获异常", { runId, threadId, error: String(err) });
 markFailed(run, err);
 });

 return runId;
}

function clearRunHeartbeat(run: LiveRun): void {
 if (!run.heartbeatTimer) return;
 clearInterval(run.heartbeatTimer);
 run.heartbeatTimer = null;
}

async function driveRun(run: LiveRun, params: RunParams): Promise<void> {
 const { threadId, modelMessages, system, modelId, tools, getChatModel, markEndpointFailed } =
 params;

 // 读 thread.projectId，注入 per-thread project scope
 // V8 阶段 8：不再读 thread.activeSkillId 注入 skill scope（Skill 不再绑定 thread，
 // 工具权限由 permission policy 处理，见阶段 6）
 const threadRow = await getThreadById(threadId).catch(() => null);
 const projectId = threadRow?.projectId ?? null;
 if (projectId) setThreadProjectScope(threadId, projectId);
 // 注入 runId scope，executeToolRun 创建 ToolRun 时自动归属 ThreadRun。
 setThreadRunScope(threadId, run.runId);
 const providerOptions = resolveProviderOptions(modelId);

 const stream = createUIMessageStream<ChatMessage>({
 execute: ({ writer }) => {
 const result = streamText({
 model: getChatModel(modelId),
 system,
 messages: modelMessages,
 tools,
 stopWhen: stepCountIs(24),
 maxRetries: 3,
 abortSignal: run.abortController.signal, // B-5：cancel 时向上传播给 provider
 ...(aiConfig.maxOutputTokens > 0 ? { maxOutputTokens: aiConfig.maxOutputTokens } : {}),
 ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
 onError: ({ error }) => {
 logger.error("streamText 失败", { threadId, error: String(error) });
 // 完整化:标记当前 endpoint 失败(熔断计数,超阈值切备用 endpoint)
 markEndpointFailed?.();
 // streamText 失败时取消该 thread 活跃子代理，防子代理继续跑到 120s 超时
 //（onFinish 可能不触发，子代理无收尾）。best-effort 不阻塞 error 处理。
 stopAllSubagents(threadId).catch(() => {});
 // : 直接落终态——onFinish 在 onError 后不保证触发,若不主动 markFailed,
 // thread 卡 executing + ThreadRun 卡 running,reaper 要等 maxRunMs 才回收,客户端 423 锁死。
 // LiveRun 状态机守卫防与 onFinish 的 markDone 双写。
 markFailed(run, error).catch((err) =>
 logger.error("[thread-runner] onError markFailed 失败", {
 threadId,
 error: String(err),
 }),
 );
 // 审计修复 M4：不将 provider SDK 原始 error.message 发给前端（可能含 API key、
 // endpoint URL、内部 request ID）。完整错误已落 logger，前端仅收到通用提示。
 const errorChunk: UIMessageChunk = {
 type: "error",
 errorText: "AI 模型调用异常，请稍后重试",
 } as UIMessageChunk;
 run.broadcaster.publish(errorChunk);
 },
 onFinish: async ({ totalUsage }) => {
 // E-7: 用 totalUsage（跨 step 累加），非 usage（仅最后一步，多步 agent 低估）。
 // 落审计事件 + 累加 Thread 冗余列（header 展示免 SUM 事件流）。
 if (totalUsage) {
 const inputTokens = totalUsage.inputTokens ?? 0;
 const outputTokens = totalUsage.outputTokens ?? 0;
 const total = totalUsage.totalTokens ?? inputTokens + outputTokens;
 // 捕获 token 用量到 LiveRun，供 markDone 写回 ThreadRun。
 run.totalUsage = {
 promptTokens: inputTokens,
 completionTokens: outputTokens,
 totalTokens: total,
 };
 if (inputTokens || outputTokens) {
 await appendThreadEvent(
 threadId,
 "agent.usage",
 {
 promptTokens: inputTokens,
 completionTokens: outputTokens,
 totalTokens: total,
 model: modelId,
 },
 run.runId,
 ).catch((err) => {
 // E-7: fail-open 不阻塞流，但记日志（不静默吞错，不向用户弹错）
 logger.warn("[thread-runner] agent.usage 事件落库失败", {
 threadId,
 error: String(err),
 });
 });
 // E-7: 原子累加 Thread 冗余列，fail-open 不阻塞流。
 await incrementThreadTokens(threadId, {
 inputTokens,
 outputTokens,
 totalTokens: total,
 }).catch((err) => {
 // E-7: fail-open 不阻塞流，但记日志（token 是次要用量信息，失败不弹用户）
 logger.warn("[thread-runner] token 用量累加失败", {
 threadId,
 error: String(err),
 });
 });
 }
 }
 // cancel/reaper 已接管终态时，不再运行 finalizeThreadRun。否则空工作区会先被
 // finalize 投影成 idle，随后 cancel 的 CAS 无法写入 cancelled/failed。
 if (run.status !== "running" || run.cancelledOverride) {
 run.finalizeResolve?.();
 return;
 }
 try {
 const artifact = await finalizeThreadRun(threadId);
 const artifactChunk: UIMessageChunk = {
 type: "data-artifact",
 data: artifact,
 } as UIMessageChunk;
 run.broadcaster.publish(artifactChunk);
 } catch (error) {
 await appendThreadEvent(
 threadId,
 "agent.status_changed",
 {
 from: "executing",
 to: "failed",
 reason: "finalize_error",
 },
 run.runId,
 );
 await Promise.all([
 updateThreadPreviewUrl(threadId, null),
 updateThreadStatus(threadId, "failed", ACTIVE_THREAD_STATUSES),
 ]);
 logger.error("自检收尾失败", { threadId, error: (error as Error).message });
 const failChunk: UIMessageChunk = {
 type: "data-artifact",
 data: { previewUrl: "", status: "failed" },
 } as UIMessageChunk;
 run.broadcaster.publish(failChunk);
 } finally {
 // 审计修复：通知 cancelRun finalizeThreadRun 已完成（无论成功/失败），
 // 替代原 200ms sleep 竞态修复。
 run.finalizeResolve?.();
 }
 },
 });
 writer.merge(result.toUIMessageStream());
 },
 generateId: generateUUID,
 // B-3: part 级增量落库——每个 step 边界把已组装的 responseMessage.parts upsert 落库。
 // 中断/抛错时，已完成的 step 的 parts 已持久化，不再依赖 onFinish 一次性整条落库。
 onStepFinish: async ({ responseMessage }) => {
 await upsertMessageParts([
 {
 id: responseMessage.id,
 threadId,
 role: "assistant",
 parts: responseMessage.parts,
 runId: run.runId,
 },
 ]).catch(() => {});
 },
 onFinish: async ({ messages }) => {
 // B-3: 收尾 upsert（捕获最后一个 step 之后的 trailing partial；abort 时 AI SDK 经
 // flush 触发本回调带 partial）。upsert 替代 saveMessages 的 INSERT IGNORE——
 // IGNORE 遇 onStepFinish 已写的 id 不更新，会丢最终 partial。
 const toSave = messages
 .filter((m) => m.role === "assistant")
 .map((m) => ({
 id: m.id,
 threadId,
 role: "assistant" as const,
 parts: m.parts,
 runId: run.runId,
 }));
 // B-3：先置 finalMessages + saveStarted（同步），再 await 落库。
 // 这样 cancelRun await completion 后能据此判断是否需要兜底 flush，避免与这里双写。
 run.finalMessages = messages as ChatMessage[];
 run.saveStarted = true;
 if (toSave.length > 0)
 await upsertMessageParts(toSave).catch((err) => {
 logger.warn("[thread-runner] onFinish upsertMessageParts 失败（fail-open）", {
 threadId,
 runId: run.runId,
 error: String(err),
 });
 });
 },
 });

 // 把 createUIMessageStream 的输出逐 chunk 喂给 broadcaster（多播 + 回放）
 const reader = stream.getReader();
 // 审计修复：跟踪 reader 是否抛错。若 reader 异常，finally 不调 markDone，
 // 让 enqueue 的 .catch → markFailed 处理状态更新与 DB 落库（原 markDone 抢先
 // 置 status="done" 导致 markFailed 守卫 return，DB 永久卡在 executing）。
 let readerThrew = false;
 try {
 for (;;) {
 const { done, value } = await reader.read();
 if (done) break;
 if (value) run.broadcaster.publish(value);
 }
 } catch (err) {
 readerThrew = true;
 throw err; // 让 enqueue 的 .catch 处理
 } finally {
 reader.releaseLock();
 if (!readerThrew) {
 // B-3：reader 循环正常结束 = 流真正完成（onFinish 已至少设置好 finalMessages + 启动落库）。
 // resolve completion，让 cancelRun 不再读到竞态期的空 finalMessages。
 run.completionResolve?.();
 await markDone(run);
 }
 // 审计修复：兜底 resolve finalizePromise，防止 cancelRun 在 onFinish 未触发时永久等待。
 // 若 onFinish 已 resolve，此调用为 no-op（Promise resolve 多次调用安全）。
 run.finalizeResolve?.();
 // 清除 per-thread project/skill scope
 clearThreadProjectScope(threadId);
 clearThreadSkillScope(threadId);
 // 清除 per-thread runId scope
 clearThreadRunScope(threadId);
 }
}

async function markDone(run: LiveRun): Promise<void> {
 if (run.status !== "running") return;
 run.status = "done";
 clearRunHeartbeat(run);
 run.broadcaster.finish();
 liveRuns.delete(run.runId);
 broadcastStatus(run.threadId, run.runId, "done"); // B-6：侧栏切到终态
 // 写回 ThreadRun 终态（completed + token 用量）。fail-open 不阻塞流。
 const tokens = run.totalUsage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
 await completeThreadRun(run.runId, tokens).catch((err) => {
 logger.warn("[thread-runner] completeThreadRun 落库失败（fail-open）", {
 runId: run.runId,
 error: String(err),
 });
 });
 // V8：flush readSkillFile 加载证据到 ContextSnapshot（fail-open）
 await flushSkillLoadEvidence(run);
}

async function markFailed(run: LiveRun, error: unknown): Promise<void> {
 if (run.status !== "running") return;
 run.status = "failed";
 clearRunHeartbeat(run);
 logger.error("[thread-runner] run 失败", {
 runId: run.runId,
 threadId: run.threadId,
 error: String(error),
 });
 run.broadcaster.finish();
 liveRuns.delete(run.runId);
 broadcastStatus(run.threadId, run.runId, "failed"); // B-6：侧栏切到失败
 // 审计修复：reader 异常时 onFinish 不会被调用，finalizePromise 不会 resolve。
 // 在此处 resolve 防止 cancelRun 永久等待。
 run.finalizeResolve?.();
 // 落库线程终态 + 审计事件（修复：markFailed 此前仅更新内存，DB 永远卡在 executing）
 await appendThreadEvent(
 run.threadId,
 "agent.status_changed",
 {
 from: "executing",
 to: "failed",
 reason: "unhandled_error",
 error: redactText(error instanceof Error ? error.message : String(error), run.threadId),
 },
 run.runId,
 ).catch(() => {});
 // 审计修复：将仍在 "running" 的 ToolRun 标记为 "failed"，防止幽灵条目
 // : 限定本 run,防误杀并发新 run 的工具
 await failRunningToolRunsForThread(run.threadId, "run_failed", run.runId).catch(() => {});
 await Promise.all([
 updateThreadPreviewUrl(run.threadId, null),
 updateThreadStatus(run.threadId, "failed", ACTIVE_THREAD_STATUSES),
 ]).catch(() => {});
 // 写回 ThreadRun 终态（failed + error 信息）。fail-open 不阻塞流。
 await failThreadRun(
 run.runId,
 redactText(error instanceof Error ? error.message : String(error), run.threadId),
 ).catch((err) => {
 logger.warn("[thread-runner] failThreadRun 落库失败（fail-open）", {
 runId: run.runId,
 error: String(err),
 });
 });
 // V8：flush readSkillFile 加载证据到 ContextSnapshot（fail-open）
 await flushSkillLoadEvidence(run);
}

/**
 * V8：把 readSkillFile 累积的加载证据 flush 到该 run 最近一条 ContextSnapshot。
 * fail-open：无证据 / 无快照 / 写入失败均不抛出（证据是可观测性数据，不阻断 run 收尾）。
 */
async function flushSkillLoadEvidence(run: LiveRun): Promise<void> {
 if (!run.skillLoadEvidence || run.skillLoadEvidence.length === 0) return;
 await attachSkillLoadEvidence(run.runId, run.skillLoadEvidence).catch((err) => {
 logger.warn("[thread-runner] skillLoadEvidence flush 失败（fail-open）", {
 runId: run.runId,
 error: String(err),
 });
 });
}

/**
 * 取消 run（B-5 abort + B-3 flush）。
 *
 * abort → streamText 收到 signal 停止生成。
 * B-3：abort 后 await run 完成信号（最多 2s），确保 onFinish 已设置 finalMessages + 落库；
 * 若 onFinish 未触发（provider 边缘行为）且 finalMessages 非空，则兜底 flush。
 * saveStarted 标志避免与 onFinish 双写。reason 用于审计事件区分用户取消 / reaper 超时。
 */
export async function cancelRun(runId: string, reason = "user_cancelled"): Promise<void> {
 const run = liveRuns.get(runId);
 if (!run || run.status !== "running") return;
 const timedOut = reason === "reaper_timeout";
 const terminalStatus: RunStatus = timedOut ? "failed" : "cancelled";
 run.status = terminalStatus;
 // 在 abort 前锁定取消语义，阻止已排队的 onFinish/finalize 回写 idle。
 run.cancelledOverride = true;
 clearRunHeartbeat(run);
 if (timedOut) {
 run.broadcaster.publish({
 type: "error",
 errorText: "本次执行长时间没有完成有效动作，已自动停止。请重试。",
 } as UIMessageChunk);
 }
 try {
 run.abortController.abort();
 } catch {
 // abort 幂等
 }
 // 用户停止/abort 时取消该 thread 活跃子代理（防 orphan 继续跑到 120s）
 stopAllSubagents(run.threadId).catch(() => {});

 // B-3：等待 run 真正完成（onFinish 已赋值 finalMessages 并启动落库），避免竞态读到空数组。
 // 2s 超时兜底：onFinish 因 provider 行为未触发时不无限阻塞。
 await Promise.race([
 run.completionPromise,
 new Promise<void>((resolve) => {
 const t = setTimeout(() => {
 clearTimeout(t);
 resolve();
 }, 2000);
 }),
 ]);

 // B-3：仅当 onFinish 未自行落库（saveStarted=false）且确有产出消息时兜底 flush，避免双写。
 if (!run.saveStarted && run.finalMessages.length > 0) {
 try {
 const toSave = run.finalMessages
 .filter((m) => m.role === "assistant")
 .map((m) => ({
 id: m.id,
 threadId: run.threadId,
 role: "assistant" as const,
 parts: m.parts,
 runId: run.runId,
 }));
 if (toSave.length > 0) await upsertMessageParts(toSave);
 } catch (err) {
 logger.warn("[thread-runner] cancel flush 落库失败（fail-open）", {
 runId,
 error: String(err),
 });
 }
 } else if (!run.saveStarted) {
 logger.warn("[thread-runner] cancel 时无已产出消息可落库", { runId, reason });
 }

 await appendThreadEvent(
 run.threadId,
 "agent.status_changed",
 {
 from: "executing",
 to: terminalStatus,
 reason,
 },
 run.runId,
 ).catch(() => {});
 // 审计修复：等待 finalizeThreadRun 真正完成（替代原 200ms 硬编码 sleep）。
 // 高负载/DB 抖动时 finalize 可能超过 200ms，导致 "idle" 在 "cancelled" 之后落库，
 // 最终 DB 状态变为 idle 而非 cancelled。用 Promise + 5s 超时兜底。
 let finalizeCompleted = false;
 await Promise.race([
 run.finalizePromise.then(() => {
 finalizeCompleted = true;
 }),
 new Promise<void>((resolve) => {
 const t = setTimeout(() => {
 clearTimeout(t);
 resolve();
 }, 5000);
 }),
 ]);
 // cancelledOverride 已在 abort 前设置；这里仅记录 finalize 等待超时。
 if (!finalizeCompleted) {
 logger.warn("[thread-runner] cancel 等待 finalize 超时（5s）", {
 runId,
 threadId: run.threadId,
 });
 }
 // 审计修复：将仍在 "running" 的 ToolRun 标记为 "failed"，防止取消后遗留幽灵条目
 // : 限定本 run,防误杀并发新 run 的工具
 await failRunningToolRunsForThread(run.threadId, reason, run.runId).catch(() => {});
 await Promise.all([
 updateThreadPreviewUrl(run.threadId, null),
 updateThreadStatus(run.threadId, terminalStatus, ACTIVE_THREAD_STATUSES),
 ]).catch(() => {});
 // 超时属于执行失败；只有用户主动停止才是 cancelled。
 const persistTerminal = timedOut
 ? failThreadRun(run.runId, reason)
 : cancelThreadRunDb(run.runId, reason);
 await persistTerminal.catch((err) => {
 logger.warn("[thread-runner] cancelThreadRun 落库失败（fail-open）", {
 runId: run.runId,
 error: String(err),
 });
 });
 // V8：flush readSkillFile 加载证据到 ContextSnapshot（fail-open）
 await flushSkillLoadEvidence(run);
 run.broadcaster.finish();
 liveRuns.delete(runId);
 broadcastStatus(run.threadId, runId, terminalStatus);
}

/** 订阅 run 的 SequencedChunk 流（带历史回放 + sequence）。run 不存在或已结束 → null。 */
export function subscribe(runId: string): ReadableStream<SequencedChunk> | null {
 const run = liveRuns.get(runId);
 if (run) return run.broadcaster.subscribe();
 // run 已不在内存（进程重启 / 已完成清理）：返回 null，由调用方返回明确终态 SSE
 return null;
}

/** 查询 run 状态（侧栏徽标 / SSE 握手用）。 */
export function getRunStatus(runId: string): RunStatus | null {
 return liveRuns.get(runId)?.status ?? null;
}

/** : 查询 run 当前 SSE 订阅者数（0 表示无活跃视图,可考虑回收）。 */
export function getSubscriberCount(runId: string): number {
 return liveRuns.get(runId)?.broadcaster.subscriberCount ?? 0;
}

/** 查询 thread 当前是否有活跃 run（B-6 全局状态 SSE 用）。 */
export function getActiveRunForThread(
 threadId: string,
): { runId: string; status: RunStatus; startedAt: number } | null {
 for (const run of liveRuns.values()) {
 if (run.threadId === threadId && run.status === "running") {
 return { runId: run.runId, status: run.status, startedAt: run.startedAt };
 }
 }
 return null;
}
