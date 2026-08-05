/**
 * Desktop 会话侧栏测试（W3-2）。
 *
 * 覆盖：
 * - 按主智能体分组：有 agent 的会话在分组标题下，未匹配 agent 的平铺顶部。
 * - 当前会话高亮（从 usePathname 推导）。
 * - 品牌行 / 新建会话 / 账号行渲染。
 * - 收起态渲染（展开按钮 + 新建会话图标）。
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

vi.mock("next/navigation", () => ({
  usePathname: () => "/desktop/chat/t1",
  useRouter: () => ({ push: vi.fn() }),
}));

// sidebar-context 依赖 matchMedia 做响应式自动收起（happy-dom 视口 1024px 会触发收起），
// 用可控 mock 固定视口状态：mqMatches=false 模拟宽屏（展开）、true 模拟窄屏（收起）。
let mqMatches = false;
let originalOuterWidth: number;
let originalOuterHeight: number;
let originalScreenWidth: number;
let originalScreenHeight: number;
let originalScreenAvailWidth: number;
let originalScreenAvailHeight: number;
let frameStateListener: ((state: { isFullScreen: boolean }) => void) | null = null;

function setWindowGeometry({
  outerWidth,
  outerHeight,
  screenWidth,
  screenHeight,
  screenAvailWidth = screenWidth,
  screenAvailHeight = screenHeight,
}: {
  outerWidth: number;
  outerHeight: number;
  screenWidth: number;
  screenHeight: number;
  screenAvailWidth?: number;
  screenAvailHeight?: number;
}) {
  Object.defineProperties(window, {
    outerWidth: { configurable: true, value: outerWidth },
    outerHeight: { configurable: true, value: outerHeight },
  });
  Object.defineProperties(window.screen, {
    width: { configurable: true, value: screenWidth },
    height: { configurable: true, value: screenHeight },
    availWidth: { configurable: true, value: screenAvailWidth },
    availHeight: { configurable: true, value: screenAvailHeight },
  });
}

beforeEach(() => {
  mqMatches = false;
  frameStateListener = null;
  (globalThis as Record<string, unknown>).snowDesktop = undefined;
  originalOuterWidth = window.outerWidth;
  originalOuterHeight = window.outerHeight;
  originalScreenWidth = window.screen.width;
  originalScreenHeight = window.screen.height;
  originalScreenAvailWidth = window.screen.availWidth;
  originalScreenAvailHeight = window.screen.availHeight;
  setWindowGeometry({
    outerWidth: 1400,
    outerHeight: 900,
    screenWidth: 2560,
    screenHeight: 1440,
    screenAvailWidth: 2560,
    screenAvailHeight: 1410,
  });
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: mqMatches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => {
  setWindowGeometry({
    outerWidth: originalOuterWidth,
    outerHeight: originalOuterHeight,
    screenWidth: originalScreenWidth,
    screenHeight: originalScreenHeight,
    screenAvailWidth: originalScreenAvailWidth,
    screenAvailHeight: originalScreenAvailHeight,
  });
});

import type { Agent } from "@/lib/persistence/schema/agent";
import type { Thread } from "@/lib/persistence/schema/conversation";
import { DesktopSidebar } from "./desktop-sidebar";
import { SidebarProvider } from "./sidebar-context";

const agents = [
  { id: "a1", displayName: "报表助手", agentKey: "report-agent" },
  { id: "a0", displayName: "默认助手", agentKey: "default" },
] as unknown as readonly Agent[];

const threads = [
  { id: "t1", title: "月度报表整理", primaryAgentId: "a1" },
  { id: "t2", title: "六月发货对账", primaryAgentId: "a1" },
  { id: "t3", title: "随手记录", primaryAgentId: "no-such-agent" },
  { id: "t4", title: "系统兜底会话", primaryAgentId: "a0" },
] as unknown as readonly Thread[];

function renderSidebar(defaultCollapsed = false, hasNativeTitlebar = false) {
  return render(
    <SidebarProvider defaultCollapsed={defaultCollapsed}>
      <DesktopSidebar
        threads={threads}
        agents={agents}
        userName="sunshine"
        hasNativeTitlebar={hasNativeTitlebar}
      />
    </SidebarProvider>,
  );
}

describe("DesktopSidebar", () => {
  it("按主智能体分组，分组标题显示 Agent 名", () => {
    renderSidebar();
    expect(screen.getByText("报表助手")).toBeTruthy();
    expect(screen.getByText("月度报表整理")).toBeTruthy();
    expect(screen.getByText("六月发货对账")).toBeTruthy();
  });

  it("未匹配 Agent 的会话平铺在分组之前", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "会话列表" });
    const html = nav.innerHTML;
    // "随手记录"（未分组）出现在"报表助手"分组标题之前
    expect(html.indexOf("随手记录")).toBeGreaterThan(-1);
    expect(html.indexOf("随手记录")).toBeLessThan(html.indexOf("报表助手"));
  });

  it("系统兜底 default agent 的会话视为未选助手：平铺且不显示其分组", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "会话列表" });
    // 不出现"默认助手"分组标题
    expect(screen.queryByText("默认助手")).toBeNull();
    // 兜底会话平铺在分组之前
    const html = nav.innerHTML;
    expect(html.indexOf("系统兜底会话")).toBeGreaterThan(-1);
    expect(html.indexOf("系统兜底会话")).toBeLessThan(html.indexOf("报表助手"));
  });

  it("当前会话（来自路由）高亮", () => {
    renderSidebar();
    const active = screen.getByText("月度报表整理").closest("a");
    expect(active?.className).toContain("bg-secondary");
    const inactive = screen.getByText("六月发货对账").closest("a");
    expect(inactive?.className).not.toContain("bg-secondary ");
  });

  it("渲染品牌行、新建会话与账号行", () => {
    renderSidebar();
    expect(screen.getByText("SnowHarness")).toBeTruthy();
    expect(screen.getByText("新建会话")).toBeTruthy();
    expect(screen.getByText("会话")).toBeTruthy();
    expect(screen.getByText("sunshine")).toBeTruthy();
    expect(screen.getByLabelText("搜索会话")).toBeTruthy();
    expect(screen.getByLabelText("收起侧栏")).toBeTruthy();
  });

  it("新建会话进入显式创建路由，不复用最近一条会话", () => {
    renderSidebar();

    expect(screen.getByText("新建会话").closest("a")?.getAttribute("href")).toBe("/desktop/new");
  });

  it("浏览器预览不保留原生标题栏空白", () => {
    renderSidebar();

    expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-0");
  });

  it("普通 Desktop 窗口只保留紧凑的红绿灯安全区", () => {
    renderSidebar(false, true);

    expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8");
  });

  it("普通 Desktop 窗口的标题栏控件与三色按钮垂直居中", () => {
    renderSidebar(false, true);

    expect(screen.getByTestId("desktop-titlebar-controls").className).toContain("top-2");
    expect(screen.getByTestId("desktop-titlebar-controls").className).not.toContain("top-1");
  });

  it("窗口拖拽区与标题栏控件物理分离，避免 Electron 吞掉点击", () => {
    renderSidebar(false, true);

    expect(screen.getByTestId("desktop-titlebar-spacer").className).not.toContain(
      "[-webkit-app-region:drag]",
    );
    const dragZone = screen.getByTestId("desktop-titlebar-drag-zone");
    expect(dragZone.className).toContain("left-[140px]");
    expect(dragZone.className).toContain("right-0");
  });

  it("服务端未识别 Electron 时由 preload 的窗口控制能力恢复原生标题栏布局", async () => {
    (globalThis as Record<string, unknown>).snowDesktop = {
      windowControls: {
        getFrameState: vi.fn().mockResolvedValue({ isFullScreen: false }),
        onFrameStateChange: vi.fn(() => vi.fn()),
      },
    };

    renderSidebar(false, false);

    await waitFor(() =>
      expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8"),
    );
    expect(screen.getByTestId("desktop-titlebar-controls").className).toContain("left-20");
  });

  it("最大化窗口仍按普通标题栏布局，避免控件与品牌重叠", () => {
    setWindowGeometry({
      outerWidth: 2560,
      outerHeight: 1410,
      screenWidth: 2560,
      screenHeight: 1440,
      screenAvailWidth: 2560,
      screenAvailHeight: 1410,
    });

    renderSidebar(false, true);

    expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8");
    expect(screen.getByTestId("desktop-titlebar-controls").className).toContain("left-20");
    expect(screen.queryByLabelText("新建会话")).toBeNull();
  });

  it("铺满可用桌面但未全屏时以 Electron 原生状态为准", async () => {
    setWindowGeometry({
      outerWidth: 1470,
      outerHeight: 923,
      screenWidth: 1470,
      screenHeight: 956,
      screenAvailWidth: 1470,
      screenAvailHeight: 923,
    });
    (globalThis as Record<string, unknown>).snowDesktop = {
      windowControls: {
        getFrameState: vi.fn().mockResolvedValue({ isFullScreen: false }),
        onFrameStateChange: vi.fn((listener: (state: { isFullScreen: boolean }) => void) => {
          frameStateListener = listener;
          return vi.fn();
        }),
      },
    };

    renderSidebar(false, true);
    await waitFor(() =>
      expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8"),
    );

    act(() => frameStateListener?.({ isFullScreen: true }));
    expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8");
    expect(screen.getByTestId("desktop-titlebar-brand").textContent).toBe("SnowHarness");
    expect(screen.queryByLabelText("新建会话")).toBeNull();
    expect(screen.getAllByText("SnowHarness")).toHaveLength(1);
    expect(
      Array.from(screen.getByTestId("desktop-titlebar-controls").children).map(
        (element) => element.getAttribute("aria-label") ?? element.textContent,
      ),
    ).toEqual(["SnowHarness", "搜索会话", "收起侧栏"]);

    act(() => frameStateListener?.({ isFullScreen: false }));
    expect(screen.getByTestId("desktop-titlebar-spacer").className).toContain("h-8");
    expect(screen.queryByLabelText("新建会话")).toBeNull();
  });

  it("侧栏折叠时才在标题栏显示新建会话", async () => {
    mqMatches = true;
    (globalThis as Record<string, unknown>).snowDesktop = {
      windowControls: {
        getFrameState: vi.fn().mockResolvedValue({ isFullScreen: false }),
        onFrameStateChange: vi.fn((listener: (state: { isFullScreen: boolean }) => void) => {
          frameStateListener = listener;
          return vi.fn();
        }),
      },
    };

    renderSidebar(false, true);
    await waitFor(() => expect(screen.getByLabelText("展开侧栏")).toBeTruthy());

    expect(screen.getByLabelText("新建会话")).toBeTruthy();

    act(() => frameStateListener?.({ isFullScreen: true }));
    expect(screen.getByLabelText("新建会话")).toBeTruthy();
    expect(screen.queryByTestId("desktop-titlebar-brand")).toBeNull();
  });

  it("收起态（窄视口）只保留标题栏控制，不保留侧栏窄轨", () => {
    mqMatches = true;
    renderSidebar();
    expect(screen.getByLabelText("展开侧栏")).toBeTruthy();
    expect(screen.getByLabelText("搜索会话")).toBeTruthy();
    const sidebar = screen.getByLabelText("会话侧栏");
    expect(sidebar.className).toContain("w-0");
    expect(sidebar.className).toContain("transition-[width]");
  });

  it("标题栏控制独立于零宽侧栏，收起后仍能被 Electron 命中", () => {
    renderSidebar(true, true);

    const controls = screen.getByTestId("desktop-titlebar-controls");
    expect(controls.closest("aside")).toBeNull();
  });

  it("标题栏控制明确退出 Electron 的窗口拖拽区域", () => {
    renderSidebar(false, true);

    expect(screen.getByTestId("desktop-titlebar-controls").className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("标题栏的每个可点击控件独立退出 Electron 的窗口拖拽区域", () => {
    renderSidebar(false, true);

    const searchStyle = screen.getByLabelText("搜索会话").style as CSSStyleDeclaration & {
      WebkitAppRegion?: string;
    };
    const panelStyle = screen.getByLabelText("收起侧栏").style as CSSStyleDeclaration & {
      WebkitAppRegion?: string;
    };
    expect(searchStyle.WebkitAppRegion).toBe("no-drag");
    expect(panelStyle.WebkitAppRegion).toBe("no-drag");
  });
});
