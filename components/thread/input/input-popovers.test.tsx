import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSelectorPopover } from "./input-popovers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ModelSelectorPopover", () => {
  it("未手动选择时显示平台默认模型，用户选择后显示新模型", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            data: {
              models: [{ id: "deepseek-v4-flash" }, { id: "auto" }],
              defaultModel: "deepseek-v4-flash",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelSelectorPopover currentModelRef={null} onChange={onChange} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "deepseek-v4-flash" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "deepseek-v4-flash" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "auto" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(onChange).toHaveBeenCalledWith("auto");

    rerender(<ModelSelectorPopover currentModelRef="auto" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "auto" })).toBeTruthy();
  });

  it("current=null 且 /api/models 未返回时，立即显示传入的平台默认模型", async () => {
    // /api/models 挂起（永不 resolve），确保不依赖异步发现即可显示平台默认。
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => undefined)));

    render(
      <ModelSelectorPopover
        currentModelRef={null}
        platformDefaultModelRef="deepseek-v4-flash"
        onChange={vi.fn()}
      />,
    );

    // 同步断言：不应需要等待 /api/models。
    expect(screen.getByRole("button", { name: "deepseek-v4-flash" })).toBeTruthy();
  });

  it("current 非空时优先显示显式选择，覆盖平台默认", () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => undefined)));

    render(
      <ModelSelectorPopover
        currentModelRef="glm-5.2"
        platformDefaultModelRef="deepseek-v4-flash"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "glm-5.2" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "deepseek-v4-flash" })).toBeNull();
  });

  it("无平台默认时回退到 /api/models 的 defaultModel（既有行为保持）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, data: { models: [{ id: "deepseek-v4-flash" }], defaultModel: "deepseek-v4-flash" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    render(<ModelSelectorPopover currentModelRef={null} onChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "deepseek-v4-flash" })).toBeTruthy(),
    );
  });
});
