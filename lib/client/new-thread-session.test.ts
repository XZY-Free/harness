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
    expect(fetchImpl).toHaveBeenCalledWith("/api/threads", {
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
      "/api/threads",
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
      "/api/threads/thread-1/turns",
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

  it("uploads first-message attachments after Thread creation and binds them to the Turn", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "附件任务" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "attachment",
            attachment_id: "attachment-1",
            url: "/attachment-1",
            filename: "说明.txt",
            size: 6,
            type: "text/plain",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key", "attachment-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });
    const file = new File(["说明内容"], "说明.txt", { type: "text/plain" });

    await session.submit({ text: "请读取附件", modelRef: null, files: [file] });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/v1/threads/thread-1/attachments",
      expect.objectContaining({
        method: "POST",
        headers: { "idempotency-key": "attachment-key" },
        body: expect.any(FormData),
      }),
    );
    const uploadBody = fetchImpl.mock.calls[1]?.[1]?.body as FormData;
    expect(uploadBody.get("file")).toBe(file);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "/api/v1/threads/thread-1/turns",
      expect.objectContaining({
        body: JSON.stringify({
          input: { type: "message", text: "请读取附件" },
          workspace_attachment_ids: ["attachment-1"],
        }),
      }),
    );
  });

  it("binds a selected Desktop workspace when creating the Thread", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "检查项目" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });

    await session.submit({
      text: "检查这个项目",
      modelRef: null,
      workspaceId: "workspace-1",
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/threads",
      expect.objectContaining({
        body: JSON.stringify({ title: "检查这个项目", workspace_id: "workspace-1" }),
      }),
    );
  });

  it("sends preferred agent_use when the employee explicitly selected an Agent", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "年假查询" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });

    await session.submit({ text: "我今年还有多少年假？", modelRef: null, agentId: "agent-1" });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/threads/thread-1/turns",
      expect.objectContaining({
        body: JSON.stringify({
          input: { type: "message", text: "我今年还有多少年假？" },
          agent_use: { mode: "preferred", agent_id: "agent-1" },
        }),
      }),
    );
  });

  it("omits agent_use when no Agent was selected", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "普通任务" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    const keys = ["thread-key", "turn-key"];
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => keys.shift() ?? "unexpected",
    });

    await session.submit({ text: "帮我总结这段话", modelRef: null });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/threads/thread-1/turns",
      expect.objectContaining({
        body: JSON.stringify({ input: { type: "message", text: "帮我总结这段话" } }),
      }),
    );
  });

  it("surfaces the server error message for no eligible route (09 §11)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "无路由任务" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "BUSINESS_CONSTRAINT_VIOLATION",
              message: "Agent action 无 eligible route（agentId=agent-1）",
            },
          }),
          { status: 422 },
        ),
      );
    const session = createNewThreadSession({
      fetchImpl,
      idempotencyKeyFactory: () => "key-1",
    });

    await expect(
      session.submit({ text: "选了不存在的 Agent", modelRef: null, agentId: "agent-1" }),
    ).rejects.toThrow("Agent action 无 eligible route（agentId=agent-1）");
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
    expect(fetchImpl.mock.calls[2]?.[0]).toBe("/api/threads/thread-1/turns");
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      "idempotency-key": "turn-key",
    });
  });
});
