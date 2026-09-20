import { getEventStreamFloor } from "@/lib/conversations/projection-checkpoint-queries";
import {
  type Principal,
  employeeAuthErrorResponse,
  resolveEmployeePrincipal,
  schemaInvalidTable,
} from "@/lib/conversations/route-helpers";
import {
  type SSEStreamHandle,
  THREAD_EVENT_STREAM,
  createSSEStream,
  formatSSEMessage,
} from "@/lib/conversations/sse-transport";
import {
  getLatestEventSequence,
  getThreadById,
  listThreadEvents,
} from "@/lib/conversations/thread-queries";
/**
 * GET /api/threads/{threadId}/events — 订阅 Event（SSE，，§3.6； 连接配额）。
 *
 * 事实源：docs/architecture/api-and-events.md §3.6、
 *         docs/architecture/security.md §2.2。
 *
 * 行为：
 * 1. 解析员工身份 + 校验 Thread 属于当前员工（非 owner → 404 隐藏式）。
 * 2. 获取 SSE 连接配额：超限 → 429 STREAM_BACKPRESSURE + retry_after_ms。
 * 3. 解析 Last-Event-ID（优先）或 after_sequence 作为游标起点。
 * 4. 校验游标未过期（cursor > 0 时）：cursor < earliest_available_sequence → 409。
 * 5. 创建 SSE 流，发送 stream.resumed {latest_sequence}。
 * 6. 发送已有 backlog（cursor 之后的事件），再轮询新事件（200ms）。
 * 7. 每条持久 Event：id=event_sequence，event=eventType，data=投影 JSON。
 * 8. include_transient=true 时先发 `stream.generation` 权威代际基线，再按 exact tuple 过滤并
 *    投递 response.delta 等 transient 事件（不分配 SSE id）。
 * 9. 缓冲满 → stream.backpressure + 关闭；客户端断开 → 清理 interval + 释放配额。
 *
 * 关键约束：
 * - SSE id 必须等于十进制 event_sequence。
 * - 慢客户端断开不拖垮 Event 写入（AbortSignal + stream.cancel 清理 + 配额释放）。
 * - 连接配额 acquire/release 必须配对（在所有退出路径释放：流关闭/断开/错误）。
 * - 隐藏式 404：Thread 不存在或非 owner 一律 404 RESOURCE_NOT_FOUND。
 * - A11：transient 不得输出在权威代际基线之前 —— 先注册暂存监听器、先发基线，再 drain 暂存。
 */
import { buildStreamBackpressureResponse } from "@/lib/gateway/rate-limit-helpers";
import { getSSEConnectionQuota } from "@/lib/gateway/sse-connection-quota";
import { REQUEST_ID_HEADER, apiError, getRequestId, resourceNotFound } from "@/lib/http";
import type { ThreadEvent } from "@/lib/persistence/schema/conversation";
import {
  type ThreadGenerationBaseline,
  matchesGenerationBaseline,
  sameThreadGenerationTuples,
  serializeThreadGenerationBaseline,
} from "@/lib/runtime/thread-generation";
import { issueThreadGenerationBaseline } from "@/lib/runtime/thread-generation-queries";
import {
  type ThreadTransientEvent,
  type ThreadTransientSubscription,
  subscribeThreadTransientEvents,
} from "@/lib/runtime/transient-event-bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 路径参数上下文。 */
interface RouteContext {
  params: Promise<{ threadId: string }>;
}

/** 轮询间隔（ms）。 */
const POLL_INTERVAL_MS = 200;
/** 单次轮询最多拉取的事件数。 */
const POLL_LIMIT = 100;

/**
 * 解析非负整数字符串。
 *
 * @returns 非负整数；非法（含小数、负号、非数字字符）返回 null。
 */
function parseNonNegInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * 投影 ThreadEvent 为 SSE data JSON（§3.6 行 322-324）。
 *
 * 输出字段：event_id、sequence、schema_version、thread_id、turn_id、item_id、occurred_at、payload。
 * turn_id/item_id 可为 null（如 thread.created 事件）。
 */
function projectEvent(event: ThreadEvent): Record<string, unknown> {
  return {
    event_id: event.id,
    sequence: event.eventSequence,
    schema_version: event.schemaVersion,
    thread_id: event.threadId,
    turn_id: event.turnId,
    item_id: event.itemId,
    occurred_at: event.occurredAt.toISOString(),
    payload: event.payloadJson,
  };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = getRequestId(request);
  const { threadId } = await context.params;

  // 1. 解析员工身份
  let principal: Principal;
  try {
    principal = await resolveEmployeePrincipal(request.headers);
  } catch (err) {
    const authResp = employeeAuthErrorResponse(err, requestId);
    if (authResp) return authResp;
    throw err;
  }

  // 2. 校验 Thread 属于当前员工（非 owner → 404 隐藏式）
  const thread = await getThreadById(principal.tenantId, threadId);
  if (!thread || thread.ownerUserId !== principal.userIdentityId) {
    return resourceNotFound(requestId, `Thread 不存在或无权访问: ${threadId}`);
  }

  // 2.5 获取 SSE 连接配额：超限 → 429 STREAM_BACKPRESSURE
  const sseQuota = getSSEConnectionQuota();
  const quotaResult = sseQuota.acquire(principal.tenantId, principal.userIdentityId, threadId);
  if (!quotaResult.allowed) {
    return buildStreamBackpressureResponse(quotaResult, requestId);
  }

  // 3. 解析游标（Last-Event-ID 优先于 after_sequence）
  const lastEventIdHeader = request.headers.get("last-event-id");
  const url = new URL(request.url);
  const afterSequenceParam = url.searchParams.get("after_sequence");
  const includeTransient = url.searchParams.get("include_transient") !== "false";

  let cursor: number;
  if (lastEventIdHeader) {
    // Last-Event-ID 存在时忽略 after_sequence
    const parsed = parseNonNegInt(lastEventIdHeader);
    if (parsed === null) {
      return schemaInvalidTable(requestId, "Last-Event-ID 必须为非负整数字符串");
    }
    cursor = parsed;
  } else if (afterSequenceParam !== null) {
    const parsed = parseNonNegInt(afterSequenceParam);
    if (parsed === null) {
      return schemaInvalidTable(requestId, "after_sequence 必须为非负整数");
    }
    cursor = parsed;
  } else {
    cursor = 0;
  }

  // 4. 校验游标未过期（仅 cursor > 0 时；cursor=0 表示全新连接，无需校验）
  // 注意：assertEventCursorValid 对 floor 行不存在时一律抛错（视为流不存在），
  // 但 SSE 场景下新 Thread 可能尚未插入 floor 行，此处按 earliest=1 处理。
  if (cursor > 0) {
    const floor = await getEventStreamFloor(THREAD_EVENT_STREAM, threadId);
    const earliest = floor?.earliestAvailableSequence ?? 1;
    if (cursor < earliest) {
      return apiError(
        "EVENT_CURSOR_EXPIRED",
        `Event 游标过期：stream ${threadId} 请求 sequence ${cursor} 早于最早可用 ${earliest}`,
        {
          requestId,
          details: {
            stream_id: threadId,
            requested_sequence: cursor,
            earliest_available_sequence: earliest,
          },
        },
      );
    }
  }

  // 5. 获取最新 sequence（用于 stream.resumed）
  const latestSequence = await getLatestEventSequence(principal.tenantId, threadId);
  const latestSeq = latestSequence ?? 0;

  // 6. 创建 SSE 流
  let streamClosed = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  /** A11 暂存订阅句柄；barrier 打开前只暂存，不投递。 */
  let transientSub: ThreadTransientSubscription | null = null;
  const encoder = new TextEncoder();

  /** 释放 transient 订阅（幂等）。 */
  const releaseTransient = (): void => {
    transientSub?.unsubscribe();
    transientSub = null;
  };

  /** 释放 SSE 连接配额（幂等，仅释放一次）。 */
  let sseReleased = false;
  const releaseSSE = (): void => {
    if (sseReleased) return;
    sseReleased = true;
    sseQuota.release(principal.tenantId, principal.userIdentityId, threadId);
  };

  const handle: SSEStreamHandle = createSSEStream({
    onBackpressure: () => {
      // 缓冲满：直接通过 controller 发送 backpressure 事件（绕过 enqueue 的背压检查），再关闭
      if (handle.controller && !streamClosed) {
        const msg = formatSSEMessage({
          event: "stream.backpressure",
          data: { reason: "buffer_full" },
        });
        try {
          handle.controller.enqueue(encoder.encode(msg));
        } catch {
          // 流已关闭，忽略
        }
      }
      streamClosed = true;
      if (pollInterval) clearInterval(pollInterval);
      releaseTransient();
      releaseSSE();
      handle.close();
    },
    onAbort: () => {
      // 消费者取消流（客户端断开）：清理轮询 + 释放配额
      streamClosed = true;
      if (pollInterval) clearInterval(pollInterval);
      releaseTransient();
      releaseSSE();
    },
  });

  /**
   * A11：把一条 transient 事件投影为 SSE 消息。
   *
   * 必须携带**完整代际**（invocation/attempt/ownership/epoch）；消费侧据此隔离跨代增量。
   */
  const emitTransient = (event: ThreadTransientEvent): void => {
    if (streamClosed) return;
    handle.enqueue(event.type, {
      transient_id: event.transientId,
      thread_id: event.threadId,
      turn_id: event.turnId,
      generation: {
        invocation_id: event.generation.invocationId,
        attempt_id: event.generation.attemptId,
        ownership_id: event.generation.ownershipId,
        lease_epoch: event.generation.leaseEpoch,
      },
      occurred_at: event.occurredAt,
      payload: event.payload,
    });
  };

  // 6.5 A11 初始化 barrier 第 1 步：先注册**暂存**监听器（此时不投递任何东西）。
  //     一次性 buffer 的 drain 结果也进入暂存区，不再像旧实现那样同步输出在基线之前。
  if (includeTransient) {
    transientSub = subscribeThreadTransientEvents(threadId, emitTransient);
  }

  // 7. 发送 stream.resumed（让客户端确认连接建立）
  handle.enqueue("stream.resumed", { latest_sequence: latestSeq });

  // 7.5 A11 初始化 barrier 第 2 步：读取正式执行事实并发出权威代际基线。
  //     来源是 `Turn.activeInvocationId` → 当前 active Ownership，不是"第一条 delta 自报"。
  let generationBaseline: ThreadGenerationBaseline | null = null;
  if (transientSub && !streamClosed) {
    generationBaseline = await issueThreadGenerationBaseline({
      tenantId: principal.tenantId,
      threadId,
      baselineSequence: latestSeq,
    });
    handle.enqueue("stream.generation", serializeThreadGenerationBaseline(generationBaseline));
    // 7.6 A11 初始化 barrier 第 3 步：基线已下发，才打开 barrier。暂存按 exact tuple 过滤，
    //     之后进入实时投递（同一 accept 规则，基线换代时自动跟随最新事实）。
    transientSub.release((event) => matchesGenerationBaseline(event, generationBaseline));
  }

  // 8. 发送已有 backlog（cursor 之后的事件）
  let lastSentSequence = cursor;
  const backlogEvents = await listThreadEvents(principal.tenantId, threadId, {
    afterSequence: lastSentSequence,
    limit: POLL_LIMIT,
  });
  for (const event of backlogEvents) {
    if (streamClosed) break;
    const ok = handle.enqueue(event.eventType, projectEvent(event), event.eventSequence);
    if (!ok) break;
    lastSentSequence = event.eventSequence;
  }

  // 9. 轮询新事件（仅当流未关闭时）
  //
  // A11：正式事件推进即视为"可能有活动执行换代"（接管/恢复/终结都会写正式事件），
  // 此时重读正式事实；代际 tuple 真的变了才重发 `stream.generation`。换代通知丢失时，
  // 下一次权威读取即可纠正 —— 不依赖客户端猜测。
  const refreshGenerationBaseline = async (): Promise<void> => {
    if (!transientSub || streamClosed) return;
    const next = await issueThreadGenerationBaseline({
      tenantId: principal.tenantId,
      threadId,
      baselineSequence: lastSentSequence,
    });
    if (
      generationBaseline &&
      sameThreadGenerationTuples(next.generations, generationBaseline.generations)
    ) {
      return;
    }
    generationBaseline = next;
    handle.enqueue("stream.generation", serializeThreadGenerationBaseline(next));
  };

  let polling = false;
  if (!streamClosed) {
    pollInterval = setInterval(async () => {
      if (streamClosed || polling) return;
      polling = true;
      try {
        const events = await listThreadEvents(principal.tenantId, threadId, {
          afterSequence: lastSentSequence,
          limit: POLL_LIMIT,
        });
        if (streamClosed) return;
        let advanced = false;
        for (const event of events) {
          if (streamClosed) break;
          const ok = handle.enqueue(event.eventType, projectEvent(event), event.eventSequence);
          if (!ok) break;
          lastSentSequence = event.eventSequence;
          advanced = true;
        }
        if (advanced) await refreshGenerationBaseline();
      } catch {
        // 轮询失败不中断流，下次重试
      } finally {
        polling = false;
      }
    }, POLL_INTERVAL_MS);
  }

  // 10. 客户端断开清理（AbortSignal）
  request.signal.addEventListener("abort", () => {
    streamClosed = true;
    if (pollInterval) clearInterval(pollInterval);
    releaseTransient();
    releaseSSE();
    handle.close();
  });

  // 11. 返回 SSE 响应
  return new Response(handle.readable, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      [REQUEST_ID_HEADER]: requestId,
    },
  });
}
