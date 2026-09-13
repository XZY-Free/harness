import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavClusters, StudioNav } from "./nav";

let pathname = "/studio";

vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const allVisible = {
  agents: true,
  capabilities: true,
  conversations: true,
  runtime: true,
  observability: true,
  security: true,
  operations: true,
  settings: true,
} as const;

const sparseVisible = {
  agents: true,
  capabilities: false,
  conversations: false,
  runtime: true,
  observability: false,
  security: false,
  operations: false,
  settings: true,
} as const;

afterEach(() => {
  cleanup();
  pathname = "/studio";
});

describe("StudioNav 侧栏改版 v3", () => {
  it("头部仅返回动作：无搜索框、无产品标题、无主题入口", () => {
    render(<StudioNav visibleItems={allVisible} />);

    expect(screen.getAllByRole("link", { name: /返回使用端/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText("搜索设置与功能")).toBeNull();
    expect(screen.queryByText("SnowHarness")).toBeNull();
    expect(screen.queryByRole("button", { name: /切换主题|切换到/ })).toBeNull();
  });

  it("渐进分组标签：组内可见项 ≥2 显示，＝1 隐藏", () => {
    const view = render(<StudioNav visibleItems={allVisible} />);
    for (const group of ["构建", "运行", "治理"]) {
      expect(screen.getAllByText(group).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("工作台")).toBeNull();

    view.rerender(<StudioNav visibleItems={sparseVisible} />);
    for (const group of ["工作台", "构建", "运行", "治理"]) {
      expect(screen.queryByText(group)).toBeNull();
    }
    for (const item of ["总览", "智能体", "Runtime 与环境", "平台设置"]) {
      expect(screen.getAllByRole("link", { name: item }).length).toBeGreaterThan(0);
    }
  });

  it("全栏与 rail 同时挂载，rail 用 aria-label 提供可访问名", () => {
    render(<StudioNav visibleItems={allVisible} />);

    expect(screen.getAllByRole("navigation", { name: "管理后台" }).length).toBe(2);
    expect(screen.getAllByRole("link", { name: "智能体" }).length).toBe(2);
  });

  it("子路由归属正确并用 aria-current 标明当前菜单", () => {
    pathname = "/studio/skills/skill-1";
    const view = render(<StudioNav visibleItems={allVisible} />);
    const capabilityLinks = screen.getAllByRole("link", { name: "能力与知识" });
    expect(capabilityLinks.length).toBe(2);
    for (const link of capabilityLinks) {
      expect(link.getAttribute("aria-current")).toBe("page");
    }

    pathname = "/studio/audit";
    view.rerender(<StudioNav visibleItems={allVisible} />);
    for (const link of screen.getAllByRole("link", { name: "安全与审计" })) {
      expect(link.getAttribute("aria-current")).toBe("page");
    }
  });

  it("权限隐藏的菜单不渲染；总览恒可见", () => {
    const view = render(<StudioNav visibleItems={{ ...allVisible, settings: false }} />);
    expect(screen.queryByRole("link", { name: "平台设置" })).toBeNull();

    view.rerender(
      <StudioNav
        visibleItems={{
          agents: false,
          capabilities: false,
          conversations: false,
          runtime: false,
          observability: false,
          security: false,
          operations: false,
          settings: false,
        }}
      />,
    );
    // 总览没有 navId（常驻菜单），fail-closed 下仍是唯一入口
    expect(screen.getAllByRole("link", { name: "总览" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "智能体" })).toBeNull();
  });

  it("无任何可见簇时给出空态（NavClusters 直测）", () => {
    render(<NavClusters pathname="/studio" groups={[]} />);
    expect(screen.getByText("没有可见菜单")).toBeTruthy();
  });

  it("移动抽屉关闭时不挂载可聚焦内容，打开后才渲染并可由遮罩移除", () => {
    render(<StudioNav visibleItems={allVisible} />);

    expect(screen.queryByRole("navigation", { name: "移动后台菜单" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开导航" }));
    const drawer = screen.getByRole("navigation", { name: "移动后台菜单" });
    expect(within(drawer).getByRole("link", { name: /返回使用端/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "关闭后台菜单" }));
    expect(screen.queryByRole("navigation", { name: "移动后台菜单" })).toBeNull();
  });

  it("路由切换后卸载已打开的移动抽屉", () => {
    const view = render(<StudioNav visibleItems={allVisible} />);
    fireEvent.click(screen.getByRole("button", { name: "展开导航" }));
    expect(screen.getByRole("navigation", { name: "移动后台菜单" })).toBeTruthy();

    pathname = "/studio/runtime";
    view.rerender(<StudioNav visibleItems={allVisible} />);

    expect(screen.queryByRole("navigation", { name: "移动后台菜单" })).toBeNull();
  });
});
