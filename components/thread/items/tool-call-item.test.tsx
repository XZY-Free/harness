import type { ClientItem } from "@/lib/client/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCallItem } from "./tool-call-item";

function toolItem(state: ClientItem["item_state"]): ClientItem {
  return {
    id: `tool-${state}`,
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "tool_call",
    item_state: state,
    content: {
      tool_name: "read_file",
      tool_display_name: "读取 route.ts",
      input: { path: "app/api/route.ts" },
      output: { ok: true },
    },
    created_at: "2026-08-31T10:00:00.000Z",
  };
}

afterEach(cleanup);

describe("ToolCallItem 运行明细", () => {
  it("没有展示名时把工具名转换为可读动作，并只显示文件名", () => {
    render(
      <ToolCallItem
        item={{
          ...toolItem("completed"),
          content: { tool_name: "read_file", input: { path: "app/api/route.ts" } },
        }}
      />,
    );

    expect(screen.getByText("读取 route.ts")).toBeTruthy();
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.queryByText("app/api/route.ts")).toBeNull();
  });

  it("完成态用真实状态图标和可访问标签，不使用文本符号冒充图标", () => {
    const { container } = render(<ToolCallItem item={toolItem("completed")} />);

    const status = screen.getByLabelText("工具状态：已完成");
    expect(status.querySelector(".lucide-check")).not.toBeNull();
    expect(container.textContent).not.toContain("✓");
  });

  it("运行态显示旋转图标，点击后展开输入与输出", () => {
    render(<ToolCallItem item={toolItem("pending")} />);

    const trigger = screen.getByRole("button", { name: /读取 route.ts/ });
    const status = screen.getByLabelText("工具状态：执行中");
    expect(status.querySelector(".lucide-loader-circle")).not.toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("输入")).toBeTruthy();
    expect(screen.getByText("输出")).toBeTruthy();
    expect(screen.getByText(/app\/api\/route\.ts/)).toBeTruthy();
  });
});
