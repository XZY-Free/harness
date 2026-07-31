import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopBrowserSurface } from "./desktop-browser-surface";

const tab = {
  id: "tab-1",
  threadId: "thread-1",
  url: "https://example.com",
  title: "Example",
  favicon: null,
  loadState: "loaded",
  canGoBack: true,
  canGoForward: false,
  incognito: false,
  createdAt: 1,
  updatedAt: 1,
  error: null,
};

const secondTab = {
  ...tab,
  id: "tab-2",
  url: "https://example.org",
  title: "Second",
};

const browser = {
  createTab: vi.fn(),
  closeTab: vi.fn(),
  switchTab: vi.fn(),
  reorderTabs: vi.fn(),
  navigate: vi.fn(),
  setBounds: vi.fn(),
  getTabs: vi.fn(),
  getActiveTab: vi.fn(),
  hideViews: vi.fn(),
  subscribe: vi.fn(),
  restoreTabs: vi.fn(),
  getLockState: vi.fn(),
  cancelAi: vi.fn(),
  onLockStateChange: vi.fn(),
  onTabUpdate: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  browser.getTabs.mockResolvedValue([]);
  browser.createTab.mockResolvedValue(tab);
  browser.getActiveTab.mockResolvedValue(tab);
  browser.navigate.mockResolvedValue(true);
  browser.reorderTabs.mockResolvedValue(true);
  browser.setBounds.mockResolvedValue(true);
  browser.hideViews.mockResolvedValue(true);
  browser.subscribe.mockResolvedValue(true);
  browser.restoreTabs.mockResolvedValue(true);
  browser.getLockState.mockResolvedValue(false);
  browser.cancelAi.mockResolvedValue(true);
  browser.onLockStateChange.mockReturnValue(() => undefined);
  browser.onTabUpdate.mockReturnValue(() => undefined);
  (globalThis as unknown as { snowDesktop?: unknown }).snowDesktop = {
    capabilities: {
      version: 1,
      serverOrigin: "http://localhost:3000",
      appVersion: "0.1.0",
      ipcChannels: [],
      deviceId: null,
    },
    device: { getRegistration: vi.fn() },
    bridge: {
      getState: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      onStateChange: vi.fn(),
    },
    browser,
  };
});

afterEach(() => {
  cleanup();
  (globalThis as unknown as { snowDesktop?: unknown }).snowDesktop = undefined;
});

describe("DesktopBrowserSurface", () => {
  it("Thread 没有 tab 时创建本地 tab 并加载初始 URL", async () => {
    render(
      <DesktopBrowserSurface
        threadId="thread-1"
        userId="user-1"
        initialUrl="https://example.com"
      />,
    );

    await waitFor(() => {
      expect(browser.restoreTabs).toHaveBeenCalledWith("thread-1", "user-1");
      expect(browser.createTab).toHaveBeenCalledWith("thread-1", "https://example.com/", "user-1", {
        activate: true,
      });
    });
    expect(screen.getByDisplayValue("https://example.com")).toBeTruthy();
  });

  it("地址栏回车导航当前 tab", async () => {
    browser.getTabs.mockResolvedValue([tab]);
    render(<DesktopBrowserSurface threadId="thread-1" userId="user-1" initialUrl={null} />);

    const address = await screen.findByLabelText("地址");
    fireEvent.change(address, { target: { value: "https://openai.com" } });
    fireEvent.keyDown(address, { key: "Enter" });

    await waitFor(() => {
      expect(browser.navigate).toHaveBeenCalledWith("thread-1", "tab-1", {
        type: "navigate",
        threadId: "thread-1",
        tabId: "tab-1",
        url: "https://openai.com",
      });
    });
  });

  it("内容区尺寸变化后立即更新 WebContentsView bounds", async () => {
    browser.getTabs.mockResolvedValue([tab]);
    const resizeObserver = { callback: null as ResizeObserverCallback | null };
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeObserver.callback = callback;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    render(<DesktopBrowserSurface threadId="thread-1" userId="user-1" initialUrl={null} />);
    const viewport = await screen.findByTestId("desktop-browser-viewport");
    vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({
      x: 500,
      y: 120,
      left: 500,
      top: 120,
      right: 1100,
      bottom: 820,
      width: 600,
      height: 700,
      toJSON: () => ({}),
    });
    resizeObserver.callback?.([], {} as ResizeObserver);

    await waitFor(() => {
      expect(browser.setBounds).toHaveBeenCalledWith(
        "thread-1",
        "tab-1",
        { x: 500, y: 120, width: 600, height: 700 },
        window.devicePixelRatio,
      );
    });
  });

  it("卸载时隐藏当前 Thread 的所有 native views", async () => {
    browser.getTabs.mockResolvedValue([tab]);
    const view = render(
      <DesktopBrowserSurface threadId="thread-1" userId="user-1" initialUrl={null} />,
    );
    await screen.findByLabelText("地址");
    view.unmount();
    expect(browser.hideViews).toHaveBeenCalledWith("thread-1");
  });

  it("工作台拖拽期间隐藏 native view，避免它截获分隔线的指针事件", async () => {
    browser.getTabs.mockResolvedValue([tab]);
    render(
      <DesktopBrowserSurface
        threadId="thread-1"
        userId="user-1"
        initialUrl={null}
        suspendNativeView
      />,
    );

    await screen.findByLabelText("地址");
    await waitFor(() => expect(browser.hideViews).toHaveBeenCalledWith("thread-1"));
  });

  it("AI 持锁时显示停止并接管，点击后请求 Server 取消", async () => {
    browser.getLockState.mockResolvedValue(true);
    render(<DesktopBrowserSurface threadId="thread-1" userId="user-1" initialUrl={null} />);

    const takeover = await screen.findByRole("button", { name: "停止并接管" });
    fireEvent.click(takeover);

    await waitFor(() => expect(browser.cancelAi).toHaveBeenCalledWith("thread-1"));
  });

  it("拖动标签页后通过 IPC 持久化新顺序", async () => {
    browser.getTabs.mockResolvedValue([tab, secondTab]);
    browser.getActiveTab.mockResolvedValue(tab);
    render(<DesktopBrowserSurface threadId="thread-1" userId="user-1" initialUrl={null} />);

    const first = await screen.findByRole("button", { name: "Example" });
    const second = screen.getByRole("button", { name: "Second" });
    const dataTransfer = { effectAllowed: "none", dropEffect: "none" };
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second.parentElement as HTMLElement, { dataTransfer });
    fireEvent.drop(second.parentElement as HTMLElement, { dataTransfer });

    await waitFor(() => {
      expect(browser.reorderTabs).toHaveBeenCalledWith("thread-1", ["tab-2", "tab-1"]);
    });
  });
});
