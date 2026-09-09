import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "./desktop-sidebar";
import { SidebarProvider } from "./sidebar-context";

const logoutClientSessionMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/client/logout", () => ({ logoutClientSession: logoutClientSessionMock }));

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
  logoutClientSessionMock.mockReset();
});

function createMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: "(max-width: 84.9375rem)",
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
  { id: "t-1", title: "会话一", latest_turn_state: "waiting_user" as const },
  { id: "t-2", title: "会话二" },
];

function renderSidebar(matches: boolean, userName = "sunshine") {
  const mql = createMatchMedia(matches);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  const utils = render(
    <SidebarProvider>
      <DesktopSidebar threads={threads} currentThreadId="" surface="web" userName={userName} />
    </SidebarProvider>,
  );
  return { mql, ...utils };
}

describe("Web 侧栏 overlay drawer 行为", () => {
  it("空数据时不伪造项目层级，会话直接进入真实会话列表", () => {
    renderSidebar(false);
    expect(screen.queryByText("项目")).toBeNull();
    expect(screen.queryByLabelText("SnowHarness 项目")).toBeNull();
    expect(screen.getByRole("link", { name: /会话一/ })).toBeTruthy();
  });

  it("账号菜单以真实身份建立层级，并与侧栏保持等距边缘", () => {
    renderSidebar(false);
    fireEvent.click(screen.getByRole("button", { name: "sunshine" }));

    const menu = screen.getByRole("menu", { name: "sunshine" });
    expect(within(menu).getByText("sunshine")).toBeTruthy();
    expect(within(menu).queryByText("设置")).toBeNull();
    const logoutItem = within(menu).getByRole("menuitem", { name: "退出登录" });
    expect(logoutItem).toBeTruthy();
    expect(logoutItem.className).not.toContain("focus:bg-destructive/[0.06]");
    expect(menu.className).toContain("w-[calc(var(--sidebar-width)-1.5rem)]");
    expect(menu.className).toContain("rounded-2xl");
    expect(menu.getAttribute("data-align")).toBe("start");
  });

  it("点击退出登录会调用服务端会话退出", async () => {
    logoutClientSessionMock.mockResolvedValue(undefined);
    renderSidebar(false);
    fireEvent.click(screen.getByRole("button", { name: "sunshine" }));

    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));

    expect(logoutClientSessionMock).toHaveBeenCalledOnce();
  });

  it("侧栏宽度由共享流式变量控制，不把桌面宽度写死进组件", () => {
    renderSidebar(false);

    const shell = screen.getByTestId("desktop-sidebar-shell");
    const panel = screen.getByTestId("desktop-sidebar-panel");
    expect(shell.className).toContain("w-[var(--sidebar-width)]");
    expect(shell.className).toContain("max-[84.9375rem]:h-auto");
    expect(panel.className).toContain("w-[var(--sidebar-width)]");
    expect(`${shell.className} ${panel.className}`).not.toContain("w-[276px]");
  });

  it("会话等待用户决定时在侧栏显示低干扰的需要输入状态", () => {
    renderSidebar(false);
    const thread = screen.getByRole("link", { name: /会话一/ });
    expect(thread.textContent).toContain("需要用户输入");
    expect(thread.querySelector('[data-thread-status="needs-input"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "会话二" }).textContent).not.toContain("需要用户输入");
  });

  it("宽屏固定侧栏不渲染 backdrop", () => {
    renderSidebar(false);
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });

  it("窄屏展开为 overlay drawer 时出现 backdrop，点击 backdrop 关闭", () => {
    const { mql } = renderSidebar(true);
    // 窄屏初始收起（drawer 关闭），无 backdrop
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();

    // 点击「展开侧栏」打开 drawer → backdrop 出现
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    const closeArea = screen.getByRole("button", { name: "关闭会话侧栏" });
    expect(closeArea.className).toContain("left-[calc(");
    expect(screen.getByTestId("desktop-sidebar-backdrop").className).toContain("backdrop-blur");
    const panel = screen.getByTestId("desktop-sidebar-panel");
    expect(panel.className).toContain("max-[84.9375rem]:rounded-");
    expect(panel.className).toContain("max-[84.9375rem]:shadow-");

    // 点击 backdrop 关闭 drawer
    fireEvent.click(screen.getByRole("button", { name: "关闭会话侧栏" }));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();

    act(() => mql.dispatch(false));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });

  it("窄屏 overlay drawer 中选择会话后自动关闭", () => {
    renderSidebar(true);
    fireEvent.click(screen.getByRole("button", { name: "展开侧栏" }));
    expect(screen.getByRole("button", { name: "关闭会话侧栏" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /会话一/ }));
    expect(screen.queryByRole("button", { name: "关闭会话侧栏" })).toBeNull();
  });
});
