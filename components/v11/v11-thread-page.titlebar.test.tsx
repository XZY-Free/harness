import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/hooks/use-v11-thread", () => ({
  useV11Thread: () => ({
    items: [],
    streamStatus: "idle",
    snapshotStatus: "loading",
    visibleError: null,
    lastAppliedEventSequence: 0,
    resnapshot: vi.fn(),
  }),
}));

vi.mock("@/components/hooks/use-v11-thread-detail", () => ({
  useV11ThreadDetail: () => ({
    thread: null,
    activeGoal: null,
    latestTurn: null,
    loading: true,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/hooks/use-v11-thread-settings", () => ({
  useV11ThreadSettings: () => ({
    patchSettings: vi.fn(),
    busy: false,
  }),
}));

vi.mock("./sidebar/sidebar-context", () => ({
  useOptionalSidebar: () => ({
    collapsed: true,
    toggle: vi.fn(),
    setCollapsed: vi.fn(),
  }),
}));

import { ThreadPage } from "./v11-thread-page";

afterEach(cleanup);

describe("ThreadPage Desktop 标题栏", () => {
  it("侧栏收起后拖拽区避开左侧窗口控件和右侧工作台按钮", () => {
    render(<ThreadPage threadId="thread-1" variant="desktop" />);

    const titlebar = screen.getByRole("heading", { name: "新会话" }).parentElement;
    expect(titlebar?.className).not.toContain("[-webkit-app-region:drag]");

    const dragZone = screen.getByTestId("desktop-thread-titlebar-drag-zone");
    expect(dragZone.className).toContain("left-40");
    expect(dragZone.className).toContain("right-14");
  });

  it("侧栏收起时标题避开搜索、折叠和新建会话三个按钮", () => {
    render(<ThreadPage threadId="thread-1" variant="desktop" />);

    const titlebar = screen.getByRole("heading", { name: "新会话" }).parentElement;
    expect(titlebar?.className).toContain("pl-48");
    expect(titlebar?.className).toContain("pr-4");
    expect(titlebar?.className).not.toContain("px-4");
  });
});
