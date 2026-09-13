import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppearanceSetting } from "./appearance-setting";

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.classList.remove("dark", "light");
});

describe("AppearanceSetting 外观设置", () => {
  it("切换暗色立即生效并持久化", () => {
    render(<AppearanceSetting />);

    fireEvent.click(screen.getByRole("button", { name: "暗色" }));

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("snow-theme")).toBe("dark");
  });

  it("跟随系统清除显式深浅色并回落系统偏好", () => {
    localStorage.setItem("snow-theme", "dark");
    render(<AppearanceSetting />);

    fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));

    expect(localStorage.getItem("snow-theme")).toBe("system");
    // jsdom matchMedia 恒为 matches=false → 系统偏好=亮色
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("挂载时恢复已保存的选择", () => {
    localStorage.setItem("snow-theme", "dark");
    render(<AppearanceSetting />);

    expect(screen.getByRole("button", { name: "暗色" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "跟随系统" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});
