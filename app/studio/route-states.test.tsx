import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudioError from "./error";
import StudioLoading from "./loading";
import StudioNotFound from "./not-found";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

afterEach(cleanup);

describe("Studio 路由状态", () => {
  it("加载状态使用现有 Skeleton 还原页面结构并向读屏说明进度", () => {
    const view = render(<StudioLoading />);

    expect(screen.getByRole("status", { name: "后台页面加载中" })).toBeTruthy();
    expect(view.container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(
      6,
    );
    expect(view.container.querySelector("svg")).toBeNull();
  });

  it("异常状态不泄露内部错误，可重试并返回后台首页", () => {
    const retry = vi.fn();
    render(<StudioError error={new Error("database password leaked")} retry={retry} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "页面暂时无法加载" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("database password leaked");

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "返回后台首页" }).getAttribute("href")).toBe("/studio");
  });

  it("未找到状态提供明确说明与后台返回入口", () => {
    render(<StudioNotFound />);

    expect(screen.getByRole("heading", { name: "没有找到这个页面" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回后台首页" }).getAttribute("href")).toBe("/studio");
  });
});
