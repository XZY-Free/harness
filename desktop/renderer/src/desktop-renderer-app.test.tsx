import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch, getDesktopBridge } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getDesktopBridge: vi.fn(),
}));

vi.mock("@/lib/api-fetch", () => ({ apiFetch }));
vi.mock("@/lib/desktop/capabilities", () => ({
  getDesktopCapabilities: () => true,
  getDesktopBridge,
}));
vi.mock("@/components/thread/thread-page", () => ({
  ThreadPage: ({
    threadId,
    defaultModelRef,
  }: {
    readonly threadId: string;
    readonly defaultModelRef?: string;
  }) => (
    <div data-testid="desktop-thread-page" data-default-model-ref={defaultModelRef ?? ""}>
      会话 {threadId}
    </div>
  ),
}));
vi.mock("@/components/thread/new-thread-page", () => ({
  NewThreadPage: ({
    onSubmit,
    defaultModelRef,
  }: {
    readonly onSubmit: (input: {
      readonly text: string;
      readonly agentId: string;
      readonly modelRef: string | null;
    }) => Promise<boolean>;
    readonly defaultModelRef?: string;
  }) => (
    <button
      type="button"
      data-testid="desktop-new-thread-page"
      data-default-model-ref={defaultModelRef ?? ""}
      onClick={() =>
        void onSubmit({ text: "请帮我分析销售数据", agentId: "agent-1", modelRef: "glm-5.2" })
      }
    >
      发送首条消息
    </button>
  ),
}));
vi.mock("@/components/thread/sidebar/desktop-sidebar", () => ({
  DesktopSidebar: ({ threads }: { readonly threads: readonly { id: string }[] }) => (
    <div data-testid="desktop-thread-list">{threads.map((thread) => thread.id).join(",")}</div>
  ),
}));

// Vitest 的 JSX 转换使用 classic runtime；生产 Vite 使用 automatic runtime。
// 先提供测试运行时需要的全局 React，再动态加载被测模块。
(globalThis as Record<string, unknown>).React = React;
const { DesktopRendererApp } = await import("./desktop-renderer-app");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.history.replaceState(null, "", "/desktop");
});

describe("DesktopRendererApp", () => {
  it("打开新建页时不创建会话，发送首条消息后才创建并加入侧栏", async () => {
    const existingThreadId = "6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf";
    const createdThreadId = "6fd2a5b8-4d43-43e5-a436-80adb4f73b23";
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            viewer_id: "viewer-1",
            threads: [{ id: existingThreadId, title: "已有会话" }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: createdThreadId, title: "分析销售数据" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );

    render(<DesktopRendererApp />);

    await screen.findByRole("button", { name: "发送首条消息" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("desktop-thread-list").textContent).not.toContain(createdThreadId);

    fireEvent.click(screen.getByRole("button", { name: "发送首条消息" }));

    await waitFor(() => {
      expect(screen.getByTestId("desktop-thread-list").textContent).toContain(createdThreadId);
    });
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/threads",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "分析销售数据" }),
      }),
    );
    expect(apiFetch).toHaveBeenNthCalledWith(
      3,
      `/api/v1/threads/${createdThreadId}/turns`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          input: { type: "message", text: "请帮我分析销售数据" },
          selected_model: "glm-5.2",
        }),
      }),
    );
  });

  it("把 shell.default_model_ref 透传给新会话与已有会话页面", async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            viewer_id: "viewer-1",
            threads: [{ id: "thread-1", title: "已有会话" }],
            default_model_ref: "deepseek-v4-flash",
          }),
        ),
      ),
    );

    window.history.replaceState(null, "", "/desktop");
    render(<DesktopRendererApp />);
    const newPage = await screen.findByTestId("desktop-new-thread-page");
    expect(newPage.dataset.defaultModelRef).toBe("deepseek-v4-flash");

    cleanup();
    const existingThreadId = "6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf";
    window.history.replaceState(null, "", `/desktop/chat/${existingThreadId}`);
    render(<DesktopRendererApp />);
    const threadPage = await screen.findByTestId("desktop-thread-page");
    expect(threadPage.dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("shell 加载成功后发起设备注册，成功后连接 Bridge（幂等、无视觉噪音）", async () => {
    const register = vi
      .fn()
      .mockResolvedValue({ ok: true, tenantId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" });
    const connect = vi.fn();
    getDesktopBridge.mockReturnValue({
      device: { register },
      bridge: { connect },
    });
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer_id: "viewer-1",
          threads: [{ id: "thread-1", title: "已有会话" }],
        }),
      ),
    );

    window.history.replaceState(null, "", "/desktop/chat/6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf");
    render(<DesktopRendererApp />);
    await screen.findByTestId("desktop-thread-page");
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("设备注册失败时保持 disconnected，不连接 Bridge 也不打断页面", async () => {
    const register = vi.fn().mockResolvedValue({ ok: false, code: "network_error" });
    const connect = vi.fn();
    getDesktopBridge.mockReturnValue({
      device: { register },
      bridge: { connect },
    });
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer_id: "viewer-1",
          threads: [{ id: "thread-1", title: "已有会话" }],
        }),
      ),
    );

    window.history.replaceState(null, "", "/desktop/chat/6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf");
    render(<DesktopRendererApp />);
    await screen.findByTestId("desktop-thread-page");
    await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(connect).not.toHaveBeenCalled();
  });
});
