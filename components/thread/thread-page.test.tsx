import type { ClientThread } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useThread: vi.fn(),
  useThreadDetail: vi.fn(),
  useThreadSettings: vi.fn(),
}));

vi.mock("@/components/hooks/use-thread", () => ({ useThread: mocks.useThread }));
vi.mock("@/components/hooks/use-thread-detail", () => ({ useThreadDetail: mocks.useThreadDetail }));
vi.mock("@/components/hooks/use-thread-settings", () => ({
  useThreadSettings: mocks.useThreadSettings,
}));
// 断言落在 ThreadPage → ThreadInput 边界：用受控 mock 捕获传入 props。
vi.mock("@/components/thread/thread-input", () => ({
  ThreadInput: ({ defaultModelRef }: { readonly defaultModelRef?: string }) => (
    <div data-testid="thread-input" data-default-model-ref={defaultModelRef ?? ""} />
  ),
}));
// 其余非目标子组件与数据 hooks 隔离，仅保证两个渲染分支能到达 ThreadInput。
vi.mock("@/components/thread/thread-header", () => ({
  ThreadHeader: () => <div />,
  deriveTaskStatus: () => ({ tone: "idle", label: "空闲" }),
}));
vi.mock("@/components/thread/thread-timeline", () => ({ ThreadTimeline: () => <div /> }));
vi.mock("@/components/thread/turn-failure-notice", () => ({ TurnFailureNotice: () => null }));
vi.mock("@/components/desktop/desktop-workbench", () => ({
  DesktopWorkbench: ({ isOpen }: { readonly isOpen?: boolean }) => (
    <div data-testid="workbench" data-open={String(isOpen)} />
  ),
}));

import { ThreadPage } from "./thread-page";

const thread: ClientThread = {
  id: "t-1",
  title: "测试会话",
  active_goal_id: null,
  default_workspace_id: null,
  default_model_ref: null,
  default_environment_definition_id: null,
  lifecycle_state: "active",
  last_activity_at: "",
  last_event_sequence: 0,
  pending_queue_version_no: 0,
  version_no: 1,
  created_at: "",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.useThread.mockReturnValue({
    items: [],
    streamStatus: "idle",
    reconnectAttempt: 0,
    reconnectMax: 5,
    snapshotStatus: "ready",
    visibleError: null,
    lastAppliedEventSequence: 0,
    resnapshot: vi.fn(),
  });
  mocks.useThreadDetail.mockReturnValue({
    thread,
    activeGoal: null,
    latestTurn: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  mocks.useThreadSettings.mockReturnValue({ patchSettings: vi.fn(), busy: false });
});

describe("ThreadPage 把平台默认模型传给 ThreadInput（Web 与 Desktop 两个渲染分支）", () => {
  it("Web 分支把 defaultModelRef 传给 ThreadInput", () => {
    render(<ThreadPage threadId="t-1" defaultModelRef="deepseek-v4-flash" />);
    expect(screen.getByTestId("thread-input").dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("Desktop 分支把 defaultModelRef 传给 ThreadInput", () => {
    render(<ThreadPage threadId="t-1" variant="desktop" defaultModelRef="deepseek-v4-flash" />);
    expect(screen.getByTestId("thread-input").dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("未传 defaultModelRef 时 ThreadInput 收到空值（向后兼容）", () => {
    render(<ThreadPage threadId="t-1" />);
    expect(screen.getByTestId("thread-input").dataset.defaultModelRef).toBe("");
  });
});

describe("ThreadPage Desktop 输出区", () => {
  it("桌面端默认展示输出工作台，用户无需先猜测隐藏入口", () => {
    render(<ThreadPage threadId="t-1" variant="desktop" />);
    expect(screen.getByTestId("workbench").dataset.open).toBe("true");
    expect(screen.getByRole("button", { name: "收起任务工作台" })).toBeTruthy();
  });
});

describe("ThreadPage 首次加载稳定骨架（不整页替换）", () => {
  /** 切到首次加载态：无任何已渲染内容 + snapshot/detail 均加载中。 */
  const setFirstLoad = () => {
    mocks.useThread.mockReturnValue({
      items: [],
      streamStatus: "idle",
      reconnectAttempt: 0,
      reconnectMax: 5,
      snapshotStatus: "loading",
      visibleError: null,
      lastAppliedEventSequence: 0,
      resnapshot: vi.fn(),
    });
    mocks.useThreadDetail.mockReturnValue({
      thread: null,
      activeGoal: null,
      latestTurn: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });
  };

  it("Web 首次加载仍渲染 ThreadInput 并把 defaultModelRef 透传", () => {
    setFirstLoad();
    render(<ThreadPage threadId="t-1" defaultModelRef="deepseek-v4-flash" />);
    const input = screen.getByTestId("thread-input");
    expect(input.dataset.defaultModelRef).toBe("deepseek-v4-flash");
  });

  it("Web 首次加载 loading 只在消息区，无旧整页 spinner 替换", () => {
    setFirstLoad();
    render(<ThreadPage threadId="t-1" />);
    // 顶部标题占位区仍在（与正常页面同高）
    expect(screen.getByTestId("web-thread-header-placeholder")).toBeTruthy();
    // 消息区局部加载反馈存在
    expect(screen.getByTestId("message-area-loading")).toBeTruthy();
    // 底部 ThreadInput 仍在（未被整页替换）
    expect(screen.getByTestId("thread-input")).toBeTruthy();
    // 旧整页 spinner（"会话加载中"）不再出现
    expect(screen.queryByLabelText("会话加载中")).toBeNull();
  });

  it("Web 首次加载框架 aria-busy 且输入区不可交互（inert/fieldset）", () => {
    setFirstLoad();
    render(<ThreadPage threadId="t-1" />);
    expect(screen.getByTestId("thread-page-frame").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("thread-input-frame").getAttribute("aria-busy")).toBeNull();
    // 输入区 disabled（fieldset）→ 不可交互，不做假提交
    const inputFrame = screen.getByTestId("thread-input-frame") as HTMLFieldSetElement;
    expect(inputFrame.disabled).toBe(true);
  });

  it("Desktop 首次加载保留 desktopTitlebar、消息区局部反馈与底部 ThreadInput，且框架 aria-busy", () => {
    setFirstLoad();
    render(<ThreadPage threadId="t-1" variant="desktop" />);
    expect(screen.getByTestId("desktop-thread-titlebar")).toBeTruthy();
    expect(screen.getByTestId("message-area-loading")).toBeTruthy();
    expect(screen.getByTestId("thread-input")).toBeTruthy();
    expect(screen.getByTestId("thread-page-frame").getAttribute("aria-busy")).toBe("true");
    const inputFrame = screen.getByTestId("thread-input-frame") as HTMLFieldSetElement;
    expect(inputFrame.disabled).toBe(true);
  });
});
