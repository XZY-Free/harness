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
  DesktopSidebar: ({
    threads,
    userName,
  }: {
    readonly threads: readonly {
      readonly id: string;
      readonly latest_turn_state?: string | null;
    }[];
    readonly userName?: string;
  }) => (
    <div data-testid="desktop-sidebar" data-user-name={userName ?? ""}>
      {threads.map((thread) => `${thread.id}:${thread.latest_turn_state ?? "none"}`).join(",")}
    </div>
  ),
}));
vi.mock("@/components/thread/new-thread-page", () => ({
  NewThreadPage: ({
    defaultModelRef,
    onSubmit,
    workbenchOpen,
    onWorkbenchOpenChange,
  }: {
    readonly defaultModelRef?: string;
    readonly workbenchOpen?: boolean;
    readonly onWorkbenchOpenChange?: (open: boolean) => void;
    readonly onSubmit: (submission: {
      readonly text: string;
      readonly agentId: string;
      readonly modelRef: string | null;
    }) => Promise<boolean>;
  }) => (
    <div data-testid="new-thread-page" data-default-model-ref={defaultModelRef ?? ""}>
      <button type="button" onClick={() => onWorkbenchOpenChange?.(true)}>
        展开工作台
      </button>
      <button
        type="button"
        data-workbench-open={String(workbenchOpen)}
        onClick={() =>
          void onSubmit({ text: "请分析销售数据", agentId: "agent-1", modelRef: null })
        }
      >
        发送首条消息
      </button>
    </div>
  ),
}));
vi.mock("@/components/thread/thread-page", () => ({
  ThreadPage: ({
    defaultModelRef,
    threadId,
    onLatestTurnStateChange,
    workbenchOpen,
  }: {
    readonly defaultModelRef?: string;
    readonly threadId: string;
    readonly workbenchOpen?: boolean;
    readonly onLatestTurnStateChange?: (threadId: string, state: string | null) => void;
  }) => (
    <button
      type="button"
      data-testid="thread-page"
      data-default-model-ref={defaultModelRef ?? ""}
      data-workbench-open={String(workbenchOpen)}
      onClick={() => onLatestTurnStateChange?.(threadId, null)}
    >
      更新会话状态
    </button>
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
    viewer_name: "sunshine",
    threads: [{ id: "thread-1", title: "已有会话" }],
    default_model_ref: "deepseek-v4-flash",
  });
});

describe("WebThreadShell 透传平台默认模型", () => {
  it("外壳使用动态视口高度，窗口纵向缩放时不留下固定画布", async () => {
    render(<WebThreadShell threadId={null} />);

    const shell = await screen.findByTestId("web-thread-shell");
    expect(shell.className).toContain("h-dvh");
    expect(shell.className).toContain("w-dvw");
  });

  it("新会话（threadId=null）把 shell.default_model_ref 传给 NewThreadPage", async () => {
    render(<WebThreadShell threadId={null} />);

    await screen.findByTestId("new-thread-page");
    expect(screen.getByTestId("new-thread-page").dataset.defaultModelRef).toBe("deepseek-v4-flash");
    expect(screen.getByTestId("web-thread-shell").className).toContain("fixed");
    expect(screen.getByTestId("web-thread-shell").className).toContain("inset-0");
  });

  it("已有会话把 shell.default_model_ref 传给 ThreadPage", async () => {
    render(<WebThreadShell threadId="thread-1" />);

    await screen.findByTestId("thread-page");
    expect(screen.getByTestId("thread-page").dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("把 shell.viewer_name 传给账户菜单", async () => {
    render(<WebThreadShell threadId={null} />);

    await screen.findByTestId("desktop-sidebar");
    expect(screen.getByTestId("desktop-sidebar").dataset.userName).toBe("sunshine");
  });

  it("新会话提交成功后同一组件树立即切换到 ThreadPage，不触发 router.replace 也不重载 shell", async () => {
    const router = { replace: vi.fn() };
    mocks.useRouter.mockReturnValue(router);
    const created = { id: "created-1", title: "新会话" };
    mocks.createNewThreadSession.mockReturnValue({
      submit: vi.fn().mockResolvedValue(created),
    });

    render(<WebThreadShell threadId={null} />);
    await screen.findByTestId("new-thread-page");
    expect(mocks.loadThreadShell).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "发送首条消息" }));

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

  it("工作台展开状态由 Web 外壳持有，创建会话后保持展开", async () => {
    mocks.createNewThreadSession.mockReturnValue({
      submit: vi.fn().mockResolvedValue({ id: "created-1", title: "新会话" }),
    });
    render(<WebThreadShell threadId={null} />);
    await screen.findByTestId("new-thread-page");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台" }));
    fireEvent.click(screen.getByRole("button", { name: "发送首条消息" }));

    await waitFor(() =>
      expect(screen.getByTestId("thread-page").dataset.workbenchOpen).toBe("true"),
    );
  });

  it("当前会话离开等待状态后立即清除侧栏需要输入标记", async () => {
    mocks.loadThreadShell.mockResolvedValue({
      viewer_id: "viewer-1",
      threads: [{ id: "thread-1", title: "等待确认", latest_turn_state: "waiting_user" }],
      default_model_ref: "deepseek-v4-flash",
    });
    render(<WebThreadShell threadId="thread-1" />);

    expect((await screen.findByTestId("desktop-sidebar")).textContent).toContain(
      "thread-1:waiting_user",
    );
    fireEvent.click(screen.getByTestId("thread-page"));
    await waitFor(() =>
      expect(screen.getByTestId("desktop-sidebar").textContent).toContain("thread-1:none"),
    );
  });
});
