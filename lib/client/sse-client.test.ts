import { describe, expect, it, vi } from "vitest";
import { createSSEClient } from "./sse-client";

describe("createSSEClient transient events", () => {
  it("解析没有持久 id 的 response.delta", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            [
              "event: response.delta",
              'data: {"transient_id":"delta-1","thread_id":"thread-1","turn_id":"turn-1","occurred_at":"2026-07-21T00:00:00.000Z","payload":{"delta":"你好"}}',
              "",
              "",
            ].join("\n"),
          ),
        );
      },
    });
    const onTransient = vi.fn();
    const handle = createSSEClient(
      {
        threadId: "thread-1",
        getLastEventId: () => null,
        fetchImpl: vi.fn().mockResolvedValue(new Response(body, { status: 200 })),
      },
      {
        onOpen: vi.fn(),
        onEvent: vi.fn(),
        onTransient,
        onReconnecting: vi.fn(),
        onCursorExpired: vi.fn(),
        onFailed: vi.fn(),
      },
    );

    handle.start();
    await vi.waitFor(() => {
      expect(onTransient).toHaveBeenCalledWith({
        transient_id: "delta-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        occurred_at: "2026-07-21T00:00:00.000Z",
        delta: "你好",
      });
    });
    handle.close();
  });
});
