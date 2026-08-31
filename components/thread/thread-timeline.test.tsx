import type { ClientItem, ClientTurn } from "@/lib/client/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTimeline } from "./thread-timeline";

let timelineScrollHeight = 900;
const timelineClientHeight = 300;
const resizeCallbacks: ResizeObserverCallback[] = [];

function agentItem(text: string): ClientItem {
  return {
    id: "agent-1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "assistant_message",
    item_state: "pending",
    content: { text },
    created_at: "2026-08-14T00:00:00.000Z",
  };
}

function triggerResize(): void {
  act(() => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  timelineScrollHeight = 900;
  resizeCallbacks.length = 0;

  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "log" ? timelineScrollHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.getAttribute("role") === "log" ? timelineClientHeight : 0;
    },
  });
  HTMLElement.prototype.scrollTo = vi.fn(function scrollTo(
    this: HTMLElement,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    this.scrollTop =
      typeof options === "number" ? (y ?? options) : (options?.top ?? this.scrollTop);
  }) as typeof HTMLElement.prototype.scrollTo;

  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ThreadTimeline 底部锚定", () => {
  it("初次加载已有长会话时直接定位到底部", () => {
    render(<ThreadTimeline items={[agentItem("已有回复")]} streamStatus="open" />);

    expect(screen.getByRole("log").scrollTop).toBe(timelineScrollHeight);
  });

  it("位于底部时，同一条流式消息内容增长也继续跟随", () => {
    const view = render(<ThreadTimeline items={[agentItem("第一段")]} streamStatus="open" />);
    const timeline = screen.getByRole("log");
    expect(timeline.scrollTop).toBe(900);

    timelineScrollHeight = 1100;
    view.rerender(
      <ThreadTimeline items={[agentItem("第一段，第二段继续增长")]} streamStatus="open" />,
    );

    expect(timeline.scrollTop).toBe(1100);
  });

  it("程序定位后的延迟 scroll 事件不会误判为用户上滚，后续重排仍保持底部", () => {
    render(<ThreadTimeline items={[agentItem("已有长回复")]} streamStatus="open" />);
    const timeline = screen.getByRole("log");
    expect(timeline.scrollTop).toBe(900);

    // 真实浏览器中 Markdown/字体可在程序定位后继续增高；随后到达的 scroll 事件
    // 不是用户意图，不能因为瞬时 bottomGap > 100 就解除底部锚定。
    timelineScrollHeight = 1320;
    fireEvent.scroll(timeline);
    triggerResize();

    expect(timeline.scrollTop).toBe(1320);
  });

  it("用户主动上滚后，流式增长和内容 resize 都不抢回底部", () => {
    const view = render(<ThreadTimeline items={[agentItem("第一段")]} streamStatus="open" />);
    const timeline = screen.getByRole("log");

    timeline.scrollTop = 200;
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);
    timelineScrollHeight = 1200;
    view.rerender(
      <ThreadTimeline items={[agentItem("第一段，第二段继续增长")]} streamStatus="open" />,
    );
    triggerResize();

    expect(timeline.scrollTop).toBe(200);
  });

  it("用户滚回底部后恢复跟随，ResizeObserver 高度变化也保持底部", () => {
    const view = render(<ThreadTimeline items={[agentItem("第一段")]} streamStatus="open" />);
    const timeline = screen.getByRole("log");

    timeline.scrollTop = 200;
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);
    timeline.scrollTop = timelineScrollHeight - timelineClientHeight;
    fireEvent.wheel(timeline);
    fireEvent.scroll(timeline);

    timelineScrollHeight = 1100;
    view.rerender(
      <ThreadTimeline items={[agentItem("第一段，第二段继续增长")]} streamStatus="open" />,
    );
    expect(timeline.scrollTop).toBe(1100);

    timelineScrollHeight = 1300;
    triggerResize();
    expect(timeline.scrollTop).toBe(1300);
  });
});

describe("ThreadTimeline Agent 使用事实", () => {
  const userItem: ClientItem = {
    id: "user-1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "user_message",
    item_state: "completed",
    content: { text: "查询我的年假余额" },
    created_at: "2026-08-31T01:00:00.000Z",
  };

  it("偏好标签与真实 AgentCall 时间线分开显示", () => {
    const turn = {
      id: "turn-1",
      agent_use: { mode: "preferred", agent_id: "hr-agent", display_name: "人力助手" },
      actual_agent_calls: {
        count: 1,
        active_call_id: null,
        last_state: "completed",
        selected_agent_called: true,
        selected_but_unused: false,
        calls: [
          {
            call_id: "call-1",
            parent_invocation_id: "inv-1",
            agent_id: "hr-agent",
            display_name: "人力助手",
            action_id: "action-1",
            state: "completed",
            created_at: "2026-08-31T01:00:01.000Z",
            started_at: "2026-08-31T01:00:01.000Z",
            waiting_at: null,
            finished_at: "2026-08-31T01:00:02.000Z",
            duration_ms: 1000,
            error_code: null,
          },
        ],
      },
    } as unknown as ClientTurn;

    render(<ThreadTimeline items={[userItem]} turns={[turn]} streamStatus="open" />);

    expect(screen.getByText("优先助手：人力助手")).toBeTruthy();
    expect(screen.getByText("已收到人力助手结果")).toBeTruthy();
  });

  it("selected but unused 只显示偏好，不伪造已咨询", () => {
    const turn = {
      id: "turn-1",
      agent_use: { mode: "preferred", agent_id: "hr-agent", display_name: "人力助手" },
      actual_agent_calls: {
        count: 0,
        active_call_id: null,
        last_state: null,
        selected_agent_called: false,
        selected_but_unused: true,
        calls: [],
      },
    } as unknown as ClientTurn;

    render(<ThreadTimeline items={[userItem]} turns={[turn]} streamStatus="open" />);

    expect(screen.getByText("优先助手：人力助手")).toBeTruthy();
    expect(screen.queryByText(/正在咨询|已收到.*结果/)).toBeNull();
  });
});
