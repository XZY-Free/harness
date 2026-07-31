import { getCurrentUserFromRequest } from "@/lib/auth";
import {
  getThreadByIdForUser,
  getThreadRunByIdForUser,
  listRunTranscriptChunks,
} from "@/lib/db/queries";
import { logger } from "@/lib/logger";
import { redactObjectGlobal } from "@/lib/runtime/secret-redaction";
import type { SequencedChunk } from "@/lib/runtime/thread-runner";
import { cancelRun, getSubscriberCount, subscribe } from "@/lib/runtime/thread-runner";
import type { UIMessageChunk } from "ai";

/**
 * V4 Phase B-1 + V7 S5-3：会话执行流 SSE 端点。
 *
 * GET /api/threads/[id]/stream?runId=xxx&afterSeq=128 → text/event-stream
 *
 * 支持从指定 sequence 后续传：
 * - live run 存在：先从 DB 补 afterSeq 之后的 chunk，再接 broadcaster 实时流。
 * - live run 不存在且 run 已终态：返回 DB 剩余 chunk 后 done。
 * - live run 不存在且 run 未终态：返回 error chunk + done。
 *
 * SSE data 格式为 { sequence, chunk }，前端据此记录最后 sequence 并重连续传。
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300; // B-4：SSE 长连接需放宽到 5min，与 runner reaper 对齐

/** run 的终态集合。 */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stale"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: threadId } = await params;
  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  const afterSeqParam = url.searchParams.get("afterSeq");
  const afterSeq = afterSeqParam ? Number(afterSeqParam) : -1;

  if (!runId) {
    return new Response(JSON.stringify({ error: "missing runId" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (Number.isNaN(afterSeq)) {
    return new Response(JSON.stringify({ error: "invalid afterSeq" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  // 鉴权 + thread 归属校验
  let userId: string;
  try {
    const user = await getCurrentUserFromRequest(request);
    userId = user.id;
  } catch {
    return new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const thread = await getThreadByIdForUser(threadId, userId);
  if (!thread) {
    return new Response(JSON.stringify({ error: "会话不存在或无权访问" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  // run 归属校验：run 必须存在且属于当前 thread/user
  const run = await getThreadRunByIdForUser(runId, userId);
  if (!run || run.threadId !== threadId) {
    return new Response(JSON.stringify({ error: "运行不存在或无权访问" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const liveStream = subscribe(runId);
  const isTerminal = TERMINAL_STATUSES.has(run.status);

  // 构造 chunk 源：DB 续传 + 实时流
  const sources: ReadableStream<SequencedChunk>[] = [];

  // 1. 从 DB 查询 afterSeq 之后的已持久化 chunks
  const dbRows = await listRunTranscriptChunks(runId, { afterSeq });
  if (dbRows.length > 0) {
    sources.push(
      new ReadableStream<SequencedChunk>({
        start(controller) {
          for (const row of dbRows) {
            controller.enqueue({
              sequence: row.sequence,
              chunk: row.payload as UIMessageChunk,
            });
          }
          controller.close();
        },
      }),
    );
  }

  // 2. live run 存在时接上实时流
  if (liveStream) {
    sources.push(liveStream);
  }

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("event: heartbeat\ndata: {}\n\n"));
        } catch {
          // stream 已关闭，忽略
        }
      }, 25_000);

      let endedWithError = false;
      try {
        for (const source of sources) {
          const reader = source.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const payload = JSON.stringify(
                // P1-23: SSE 出口脱敏——chunk 含 assistant 文本/工具输出,可能回显 secret,
                // 经 redactObjectGlobal 替换所有 thread 注册的 secret 明文。
                redactObjectGlobal({ sequence: value.sequence, chunk: value.chunk }),
              );
              controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
            }
          } finally {
            reader.releaseLock();
          }
        }

        // 无 live run 且 run 未终态：给前端明确的 error chunk
        if (!liveStream && !isTerminal) {
          const errorChunk = JSON.stringify({
            type: "error",
            errorText: `运行状态为 ${run.status}，暂时无法续传`,
          });
          controller.enqueue(encoder.encode(`data: ${errorChunk}\n\n`));
          endedWithError = true;
        }
      } catch (err) {
        logger.error("[stream/route] 推送 chunk 失败", { runId, error: String(err) });
        endedWithError = true;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({ status: endedWithError ? "error" : "done" })}\n\n`,
          ),
        );
        controller.close();
      }
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  // 客户端断开时清除心跳 timer
  request.signal.addEventListener(
    "abort",
    () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // P1-6: 最后一个订阅者断开 120s 后,若 run 仍无新订阅, cancelRun 回收资源
      // (reaper 5min 兜底太慢,孤儿 run 持续烧 LLM token/CPU)。多视图重连会在 120s 内
      // 增加订阅者计数,届时不 cancel。cancelRun 内部对已终态 run no-op。
      const timer = setTimeout(() => {
        if (getSubscriberCount(runId) === 0) {
          cancelRun(runId, "no_subscribers_timeout").catch(() => {});
        }
      }, 120_000);
      timer.unref?.();
    },
    { once: true },
  );

  return new Response(sseStream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
    },
  });
}
