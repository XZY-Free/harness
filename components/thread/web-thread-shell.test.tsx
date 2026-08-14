import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useRouter: vi.fn(),
  loadThreadShell: vi.fn(),
  createNewThreadSession: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => mocks.useRouter() }));
vi.mock("@/lib/client/new-thread-session", () => ({
  loadThreadShell: mocks.loadThreadShell,
  createNewThreadSession: mocks.createNewThreadSession,
}));
vi.mock("@/components/thread/sidebar/desktop-sidebar", () => ({
  DesktopSidebar: () => <div data-testid="desktop-sidebar" />,
}));
vi.mock("@/components/thread/new-thread-page", () => ({
  NewThreadPage: ({
    defaultModelRef,
    onSubmit,
  }: {
    readonly defaultModelRef?: string;
    readonly onSubmit: (submission: {
      readonly text: string;
      readonly agentId: string;
      readonly modelRef: string | null;
    }) => Promise<boolean>;
  }) => (
    <button
      type="button"
      data-testid="new-thread-page"
      data-default-model-ref={defaultModelRef ?? ""}
      onClick={() => void onSubmit({ text: "请分析销售数据", agentId: "agent-1", modelRef: null })}
    >
      发送首条消息
    </button>
  ),
}));
vi.mock("@/components/thread/thread-page", () => ({
  ThreadPage: ({ defaultModelRef }: { readonly defaultModelRef?: string }) => (
    <div data-testid="thread-page" data-default-model-ref={defaultModelRef ?? ""} />
  ),
}));

import { WebThreadShell } from "./web-thread-shell";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.useRouter.mockReturnValue({ replace: vi.fn() });
  mocks.createNewThreadSession.mockReturnValue({ submit: vi.fn().mockResolvedValue({ id: "t" }) });
  mocks.loadThreadShell.mockResolvedValue({
    viewer_id: "viewer-1",
    threads: [{ id: "thread-1", title: "已有会话", primary_agent_id: "agent-1" }],
    agents: [{ id: "agent-1", agent_key: "default", display_name: "助手" }],
    default_model_ref: "deepseek-v4-flash",
  });
});

describe("WebThreadShell 透传平台默认模型", () => {
  it("新会话（threadId=null）把 shell.default_model_ref 传给 NewThreadPage", async () => {
    render(<WebThreadShell threadId={null} />);

    await screen.findByTestId("new-thread-page");
    expect(screen.getByTestId("new-thread-page").dataset.defaultModelRef).toBe(
      "deepseek-v4-flash",
    );
  });

  it("已有会话把 shell.default_model_ref 传给 ThreadPage", async () => {
    render(<WebThreadShell threadId="thread-1" />);

    await screen.findByTestId("thread-page");
    expect(screen.getByTestId("thread-page").dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("新会话提交成功后同一组件树立即切换到 ThreadPage，不触发 router.replace 也不重载 shell", async () => {
    const router = { replace: vi.fn() };
    mocks.useRouter.mockReturnValue(router);
    const created = { id: "created-1", title: "新会话", primary_agent_id: "agent-1" };
    mocks.createNewThreadSession.mockReturnValue({
      submit: vi.fn().mockResolvedValue(created),
    });

    render(<WebThreadShell threadId={null} />);
    await screen.findByTestId("new-thread-page");
    expect(mocks.loadThreadShell).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("new-thread-page"));

    // 同一组件树直接切到 ThreadPage，不出现 shell loading
    await waitFor(() => expect(screen.getByTestId("thread-page")).toBeTruthy());
    expect(screen.queryByTestId("new-thread-page")).toBeNull();
    // loadThreadShell 仍只调用一次（shell 未卸载重挂载）
    expect(mocks.loadThreadShell).toHaveBeenCalledTimes(1);
    // 不再走 App Router 导航（避免卸载 shell）
    expect(router.replace).not.toHaveBeenCalled();
    // 地址栏经 history.replaceState 更新
    expect(window.location.pathname).toBe("/chat/created-1");
  });
});
