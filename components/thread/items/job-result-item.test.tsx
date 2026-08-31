import type { ClientItem } from "@/lib/client/types";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobResultItem } from "./job-result-item";

afterEach(cleanup);

describe("JobResultItem 后台任务卡片", () => {
  it("用中文标题与真实完成图标表达状态，不直接显示内部 job_type", () => {
    const item: ClientItem = {
      id: "job-item-1",
      turn_id: "turn-1",
      item_sequence: 1,
      item_type: "job_result",
      item_state: "completed",
      content: { job_type: "internal_sync_job", status: "completed" },
      created_at: "2026-08-31T10:00:00.000Z",
    };

    const { container } = render(<JobResultItem item={item} />);
    expect(screen.getByText("后台任务")).toBeTruthy();
    expect(container.querySelector(".lucide-circle-check")).not.toBeNull();
    expect(screen.queryByText("internal_sync_job")).toBeNull();
  });
});
