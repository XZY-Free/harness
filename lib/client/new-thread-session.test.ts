import { describe, expect, it, vi } from "vitest";
import { createNewThreadSession, loadThreadShell } from "./new-thread-session";

describe("new thread client session", () => {
  it("loads the employee shell from the formal thread API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer_id: "viewer-1",
          threads: [],
          agents: [{ id: "agent-1", agent_key: "default", display_name: "助手" }],
        }),
      ),
    );

    await expect(loadThreadShell(fetchImpl)).resolves.toMatchObject({ viewer_id: "viewer-1" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/threads", {
      credentials: "include",
      cache: "no-store",
    });
  });

  it("creates a formal Thread and its first Turn", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "分析销售数据" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });

    await expect(
      session.submit({ text: "请帮我分析销售数据", modelRef: "glm-5.2" }),
    ).resolves.toEqual({
      id: "thread-1",
      title: "分析销售数据",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/v1/threads",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "thread-key",
        },
        body: JSON.stringify({ title: "分析销售数据" }),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/v1/threads/thread-1/turns",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "turn-key",
        },
        body: JSON.stringify({
          input: { type: "message", text: "请帮我分析销售数据" },
          selected_model: "glm-5.2",
        }),
      }),
    );
  });

  it("retries a failed first Turn without creating another Thread", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "重试任务" }), { status: 201 }),
      )
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });
    const submission = { text: "重试任务", modelRef: null };

    await expect(session.submit(submission)).rejects.toThrow("消息发送失败");
    await expect(session.submit(submission)).resolves.toMatchObject({ id: "thread-1" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("/api/v1/threads/thread-1/turns");
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      "idempotency-key": "turn-key",
    });
  });
});
