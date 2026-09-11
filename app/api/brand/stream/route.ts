import { getBrandStore } from "@/lib/branding/brand-store";

export const dynamic = "force-dynamic";

/**
 * GET /api/brand/stream → Web 侧品牌失效信号 SSE。
 *
 * 只推信号（revision/etag），不推状态全文；消费者收到后以 ETag 拉取 /api/brand。
 * 心跳 60s 仅保活；断线由客户端在 navigation/focus 时再校验兜底（品牌极少变更）。
 */
export async function GET(): Promise<Response> {
  const store = getBrandStore();
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* 连接已断开：enqueue 抛错即忽略，cancel 会清理订阅 */
        }
      };
      send(": connected\n\n");
      unsubscribe = store.subscribe((snapshot) => {
        send(
          `event: brand\ndata: ${JSON.stringify({
            revision: snapshot.contract.revision,
            etag: snapshot.etag,
          })}\n\n`,
        );
      });
      heartbeat = setInterval(() => send(": heartbeat\n\n"), 60_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
