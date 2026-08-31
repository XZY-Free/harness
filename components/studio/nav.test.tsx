import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioNav } from "./nav";

let pathname = "/studio";

vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/studio/theme-toggle", () => ({
  ThemeToggle: () => <button type="button">切换主题</button>,
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

afterEach(() => {
  cleanup();
  pathname = "/studio";
});

describe("StudioNav 设置式后台导航", () => {
  it("展示返回入口、搜索框和四组清晰的信息架构", () => {
    render(<StudioNav visibleItems={allVisible} />);

    expect(screen.getByRole("link", { name: /返回使用端/ })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "搜索后台菜单" })).toBeTruthy();
    for (const group of ["工作台", "构建", "运行", "治理"]) {
      expect(screen.getByText(group)).toBeTruthy();
    }
  });

  it("搜索时只保留匹配菜单，并提供明确空结果", () => {
    render(<StudioNav visibleItems={allVisible} />);
    const search = screen.getByRole("searchbox", { name: "搜索后台菜单" });

    fireEvent.change(search, { target: { value: "安全" } });
    expect(screen.getByRole("link", { name: "安全与审计" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "智能体" })).toBeNull();

    fireEvent.change(search, { target: { value: "完全不存在" } });
    expect(screen.getByText("没有匹配的菜单")).toBeTruthy();
  });

  it("子路由归属正确并用 aria-current 标明当前菜单", () => {
    pathname = "/studio/skills/skill-1";
    const view = render(<StudioNav visibleItems={allVisible} />);
    expect(screen.getByRole("link", { name: "能力与知识" }).getAttribute("aria-current")).toBe(
      "page",
    );

    pathname = "/studio/audit";
    view.rerender(<StudioNav visibleItems={allVisible} />);
    expect(screen.getByRole("link", { name: "安全与审计" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("权限隐藏的菜单不会因搜索重新出现", () => {
    render(<StudioNav visibleItems={{ ...allVisible, settings: false }} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索后台菜单" }), {
      target: { value: "设置" },
    });
    expect(screen.queryByRole("link", { name: "平台设置" })).toBeNull();
    expect(screen.getByText("没有匹配的菜单")).toBeTruthy();
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
