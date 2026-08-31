import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessFold } from "./process-fold";

afterEach(cleanup);

describe("ProcessFold 运行过程反馈", () => {
  it("运行中明确展示步骤数，并保持过程内容展开", () => {
    render(
      <ProcessFold running itemCount={2} startedAt={new Date().toISOString()}>
        <div>读取配置</div>
        <div>运行检查</div>
      </ProcessFold>,
    );

    const trigger = screen.getByRole("button", { name: /正在处理/ });
    expect(trigger.textContent).toContain("2 个步骤");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.querySelector(".lucide-loader-circle")).not.toBeNull();
  });

  it("完成态使用完成图标，仍可展开查看过程", () => {
    render(
      <ProcessFold
        running={false}
        itemCount={1}
        startedAt="2026-08-31T10:00:00.000Z"
        endedAt="2026-08-31T10:00:03.000Z"
      >
        <div>读取 route.ts</div>
      </ProcessFold>,
    );

    const trigger = screen.getByRole("button", { name: /已处理 3s/ });
    expect(trigger.textContent).toContain("1 个步骤");
    expect(trigger.querySelector(".lucide-circle-check")).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("读取 route.ts")).toBeTruthy();
  });
});
