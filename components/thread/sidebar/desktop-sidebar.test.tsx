import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "./desktop-sidebar";
import { SidebarProvider } from "./sidebar-context";

// CmdkPanel 引入 cmdk/dialog，拖入 happy-dom 易碎；overlay drawer 行为与其无关，这里替身。
vi.mock("@/components/thread/command/cmdk-panel", () => ({
  CmdkPanel: () => null,
}));

// next 路由与链接在组件测试里无实际导航，给最小替身以便点击触发 onClick。
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/chat",
  useRouter: () => ({ push: pushMock }),
}));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a href={href} onClick={onClick} {...rest}>
      {children}
    </a>
  ),
}));

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

const threads = [
  { id: "t-1", title: "会话一", primaryAgentId: "a-default" },
  { id: "t-2", title: "会话二", primaryAgentId: "a-default" },
];
const agents = [{ id: "a-default", agentKey: "default", displayName: "助手" }];

function renderSidebar(matches: boolean) {
  const mql = createMatchMedia(matches);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  const utils = render(
    <SidebarProvider>
      <DesktopSidebar threads={threads} agents={agents} currentThreadId="" surface="web" />
    </SidebarProvider>,
  );
  return { mql, ...utils };
}

describe("Web 侧栏 overlay drawer 行为", () => {
  it("≥1180px（固定侧栏）不渲染 backdrop", () => {
    renderSidebar(false);
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });

  it("低于 1180px：展开为 overlay drawer 时出现 backdrop，点击 backdrop 关闭", () => {
    const { mql } = renderSidebar(true);
    // 窄屏初始收起（drawer 关闭），无 backdrop
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();

    // 点击「展开侧栏」打开 drawer → backdrop 出现
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("button", { name: "关闭会话侧栏" })).toBeTruthy();

    // 点击 backdrop 关闭 drawer
    fireEvent.click(screen.getByRole("button", { name: "关闭会话侧栏" }));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();

    act(() => mql.dispatch(false));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });

  it("低于 1180px：overlay drawer 中选择会话后自动关闭", () => {
    renderSidebar(true);
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("button", { name: "关闭会话侧栏" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "会话一" }));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });
});
