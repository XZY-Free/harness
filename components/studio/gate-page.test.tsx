import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StudioGatePage } from "./gate-page";

afterEach(cleanup);

describe("StudioGatePage", () => {
  it("入口门禁使用全视口错误状态，并提供清晰标题与返回入口", () => {
    const view = render(<StudioGatePage status={403} message="没有后台访问权限" fullScreen />);

    expect(view.container.firstElementChild?.className).toContain("min-h-dvh");
    expect(screen.getByRole("heading", { level: 1, name: /403/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回使用端" }).getAttribute("href")).toBe("/chat");
  });

  it("页内门禁不强占整个视口", () => {
    const view = render(<StudioGatePage status={403} message="没有读取权限" />);

    expect(view.container.firstElementChild?.className).not.toContain("min-h-dvh");
  });
});
