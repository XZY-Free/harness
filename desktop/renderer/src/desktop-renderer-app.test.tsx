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
    onLatestTurnStateChange,
    workbenchOpen,
  }: {
    readonly threadId: string;
    readonly defaultModelRef?: string;
    readonly workbenchOpen?: boolean;
    readonly onLatestTurnStateChange?: (threadId: string, state: string | null) => void;
  }) => (
    <button
      type="button"
      data-testid="desktop-thread-page"
      data-default-model-ref={defaultModelRef ?? ""}
      data-workbench-open={String(workbenchOpen)}
      onClick={() => onLatestTurnStateChange?.(threadId, null)}
    >
      会话 {threadId}
    </button>
  ),
}));
vi.mock("@/components/thread/new-thread-page", () => ({
  NewThreadPage: ({
    onSubmit,
    defaultModelRef,
    workbenchOpen,
    onWorkbenchOpenChange,
    workspaceName,
    onWorkspaceSelect,
    workspaceId,
  }: {
    readonly onSubmit: (input: {
      readonly text: string;
      readonly agentId: string;
      readonly modelRef: string | null;
      readonly workspaceId?: string | null;
    }) => Promise<boolean>;
    readonly defaultModelRef?: string;
    readonly workbenchOpen?: boolean;
    readonly onWorkbenchOpenChange?: (open: boolean) => void;
    readonly workspaceName?: string | null;
    readonly onWorkspaceSelect?: () => void;
    readonly workspaceId?: string | null;
  }) => (
    <div
      data-testid="desktop-new-thread-page"
      data-default-model-ref={defaultModelRef ?? ""}
      data-workspace-name={workspaceName ?? ""}
    >
      <button type="button" onClick={() => onWorkbenchOpenChange?.(true)}>
        展开工作台
      </button>
      <button type="button" onClick={onWorkspaceSelect}>
        选择本地目录
      </button>
      <button
        type="button"
        data-workbench-open={String(workbenchOpen)}
        onClick={() =>
          void onSubmit({
            text: "请帮我分析销售数据",
            agentId: "agent-1",
            modelRef: "glm-5.2",
            workspaceId,
          })
        }
      >
        发送首条消息
      </button>
    </div>
  ),
}));
vi.mock("@/components/thread/sidebar/desktop-sidebar", () => ({
  DesktopSidebar: ({
    threads,
    userName,
  }: {
    readonly threads: readonly { id: string; latest_turn_state?: string | null }[];
    readonly userName?: string;
  }) => (
    <div data-testid="desktop-thread-list" data-user-name={userName ?? ""}>
      {threads.map((thread) => `${thread.id}:${thread.latest_turn_state ?? "none"}`).join(",")}
    </div>
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
  it("未登录时显示登录页，认证成功后进入 Desktop 会话页", async () => {
    apiFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "AUTHENTICATION_REQUIRED" } }), {
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true, return_to: "/desktop" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ viewer_id: "viewer-1", viewer_name: "sunshine", threads: [] }),
        ),
      );

    render(<DesktopRendererApp />);

    expect(await screen.findByLabelText("SnowHarness 登录")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await screen.findByTestId("desktop-new-thread-page");
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/auth/login?returnTo=%2Fdesktop",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("打开新建页时不创建会话，发送首条消息后才创建并加入侧栏", async () => {
    const existingThreadId = "6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf";
    const createdThreadId = "6fd2a5b8-4d43-43e5-a436-80adb4f73b23";
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            viewer_id: "viewer-1",
            viewer_name: "sunshine",
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
          agent_use: { mode: "preferred", agent_id: "agent-1" },
        }),
      }),
    );
  });

  it("选择本地目录后在新会话中显示目录名，并把 workspace_id 带入创建请求", async () => {
    const selectDirectory = vi.fn().mockResolvedValue({
      ok: true,
      workspaceId: "workspace-1",
      bindingId: "binding-1",
      displayName: "snow_harness",
    });
    getDesktopBridge.mockReturnValue({
      device: { register: vi.fn().mockResolvedValue({ ok: true, tenantId: "tenant-1" }) },
      bridge: { connect: vi.fn() },
      workspace: { selectDirectory },
    });
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            viewer_id: "viewer-1",
            viewer_name: "sunshine",
            threads: [],
            default_model_ref: "deepseek-v4-flash",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "thread-1", title: "分析销售数据" }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );

    render(<DesktopRendererApp />);
    await screen.findByTestId("desktop-new-thread-page");
    fireEvent.click(screen.getByRole("button", { name: "选择本地目录" }));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-new-thread-page").dataset.workspaceName).toBe(
        "snow_harness",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "发送首条消息" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/v1/threads",
      expect.objectContaining({
        body: JSON.stringify({ title: "分析销售数据", workspace_id: "workspace-1" }),
      }),
    );
  });

  it("把 shell.default_model_ref 透传给新会话与已有会话页面", async () => {
    apiFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            viewer_id: "viewer-1",
            viewer_name: "sunshine",
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

  it("把 shell.viewer_name 传给账户菜单，不显示内部用户 ID", async () => {
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer_id: "viewer-1",
          viewer_name: "sunshine",
          threads: [],
          default_model_ref: "deepseek-v4-flash",
        }),
      ),
    );

    render(<DesktopRendererApp />);

    const sidebar = await screen.findByTestId("desktop-thread-list");
    expect(sidebar.dataset.userName).toBe("sunshine");
  });

  it("工作台展开状态由 Desktop 外壳持有，创建会话后保持展开", async () => {
    const createdThreadId = "6fd2a5b8-4d43-43e5-a436-80adb4f73b23";
    apiFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ viewer_id: "viewer-1", threads: [], default_model_ref: "model-1" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: createdThreadId, title: "分析销售数据" })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ turn: { id: "turn-1" } }), { status: 201 }),
      );
    render(<DesktopRendererApp />);
    await screen.findByTestId("desktop-new-thread-page");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台" }));
    fireEvent.click(screen.getByRole("button", { name: "发送首条消息" }));

    await waitFor(() =>
      expect(screen.getByTestId("desktop-thread-page").dataset.workbenchOpen).toBe("true"),
    );
  });

  it("当前会话完成用户操作后同步清除桌面侧栏等待标记", async () => {
    const threadId = "6c34a4f3-1b47-4acb-9b2e-7bdbff3e04cf";
    apiFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          viewer_id: "viewer-1",
          threads: [{ id: threadId, title: "等待确认", latest_turn_state: "waiting_user" }],
          default_model_ref: "deepseek-v4-flash",
        }),
      ),
    );
    window.history.replaceState(null, "", `/desktop/chat/${threadId}`);
    render(<DesktopRendererApp />);

    expect((await screen.findByTestId("desktop-thread-list")).textContent).toContain(
      `${threadId}:waiting_user`,
    );
    fireEvent.click(screen.getByTestId("desktop-thread-page"));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-thread-list").textContent).toContain(`${threadId}:none`),
    );
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
