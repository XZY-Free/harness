import type { ClientThread } from "@/lib/client/types";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "./sidebar/sidebar-context";
import { ThreadHeader } from "./thread-header";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "(max-width: 1179px)",
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
    dispatch: (matches: boolean) => {
      mql.matches = matches;
      for (const cb of listeners) cb({ matches } as MediaQueryListEvent);
    },
  };
  return mql;
}

const thread: ClientThread = {
  id: "t-1",
  title: "一个很长很长的会话标题用来验证截断行为不会产生水平溢出",
  active_goal_id: null,
  default_workspace_id: null,
  default_model_ref: "deepseek-v4-flash",
  default_environment_definition_id: null,
  lifecycle_state: "active",
  last_activity_at: "2026-08-14T00:00:00.000Z",
  last_event_sequence: 0,
  pending_queue_version_no: 0,
  version_no: 1,
  created_at: "2026-08-14T00:00:00.000Z",
};

function renderHeader(matches: boolean) {
  const mql = createMatchMedia(matches);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  render(
    <SidebarProvider>
      <ThreadHeader thread={thread} activeGoal={null} latestTurn={null} />
    </SidebarProvider>,
  );
  return mql;
}

function header(): HTMLElement {
  return screen.getByTestId("web-thread-header");
}

describe("ThreadHeader Web 收起态安全 inset", () => {
  it("窄屏收起侧栏时为左上角固定控件预留左内边距（不重叠标题）", () => {
    renderHeader(true);
    expect(header().className).toContain("pl-32");
  });

  it("宽屏侧栏展开时不额外左移，标题仍截断不产生水平溢出", () => {
    const mql = renderHeader(false);
    expect(header().className).not.toContain("pl-32");

    // 放大→缩小 跨断点缩放，标题始终截断（truncate）且元信息行允许换行
    act(() => mql.dispatch(true));
    expect(header().className).toContain("pl-32");
    // 标题本身截断，不产生水平溢出
    expect(header().querySelector("h1")?.className).toContain("flex-1");
    expect(header().querySelector("h1")?.className).toContain("truncate");
    expect(screen.getByText("空闲").parentElement?.className).toContain("whitespace-nowrap");
    expect(screen.getByRole("heading")).toBeTruthy();
  });
});
