import type { ClientItem } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChildThreadItem } from "./child-thread-item";

afterEach(cleanup);

describe("ChildThreadItem 协作任务卡片", () => {
  it("用统一图标与中文信息展示，不向员工暴露内部 Agent id", () => {
    const item: ClientItem = {
      id: "child-item-1",
      turn_id: "turn-1",
      item_sequence: 1,
      item_type: "child_thread",
      item_state: "completed",
      content: {
        child_thread_id: "child-thread-1",
        target_agent_id: "agent-internal-123456",
        state: "completed",
        summary: "已完成资料整理",
      },
      created_at: "2026-08-31T10:00:00.000Z",
    };

    const { container } = render(<ChildThreadItem item={item} />);
    expect(screen.getByText("协作任务")).toBeTruthy();
    expect(container.querySelector(".lucide-users-round")).not.toBeNull();
    expect(screen.queryByText(/agent-internal/)).toBeNull();
    expect(screen.getByRole("link", { name: /查看协作任务/ })).toBeTruthy();
  });
});
