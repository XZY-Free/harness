import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("@/lib/api-fetch", () => ({ apiFetch }));
vi.mock("@/lib/desktop/capabilities", () => ({ getDesktopCapabilities: () => true }));
vi.mock("@/components/thread/thread-page", () => ({
  ThreadPage: ({ threadId }: { readonly threadId: string }) => <div>会话 {threadId}</div>,
}));
vi.mock("@/components/thread/new-thread-page", () => ({
  NewThreadPage: ({
    onSubmit,
  }: {
    readonly onSubmit: (input: {
      readonly text: string;
      readonly agentId: string;
      readonly modelRef: string | null;
    }) => Promise<boolean>;
  }) => (
    <button
      type="button"
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
  window.history.replaceState(null, "", "/desktop/new");
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
            threads: [{ id: existingThreadId, title: "已有会话", primary_agent_id: "agent-1" }],
            agents: [{ id: "agent-1", agent_key: "default", display_name: "助手" }],
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
        body: JSON.stringify({ agent_id: "agent-1", title: "分析销售数据" }),
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
});
