import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TurnFailureNotice } from "./turn-failure-notice";

afterEach(cleanup);

describe("TurnFailureNotice", () => {
  it("失败 Turn 给出可重试的中文提示，不暴露供应商错误正文", () => {
    render(<TurnFailureNotice turnState="failed" errorCode="MODEL_EXECUTION_FAILED" />);
    expect(screen.getByRole("alert").textContent).toContain("本次回复失败");
    expect(screen.getByRole("alert").textContent).toContain("重新发送");
    expect(screen.getByRole("alert").textContent).not.toContain("MODEL_EXECUTION_FAILED");
  });

  it("非失败状态不显示提示", () => {
    const { container } = render(<TurnFailureNotice turnState="completed" errorCode={null} />);
    expect(container.childElementCount).toBe(0);
  });
});
