import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { AgentsViewer } from "./agents-viewer";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    Response.json({
      items: [
        {
          id: "agent-1",
          agent_key: "support",
          display_name: "客服智能体",
          description: "回答客户问题",
          lifecycle_state: "enabled",
          current_revision_id: "revision-1",
          owner_user_id: "user-1",
          visibility_policy_id: null,
          updated_at: "2026-08-11T00:00:00.000Z",
        },
      ],
      total: 1,
    }),
  );
});

afterEach(cleanup);

describe("AgentsViewer", () => {
  it("通过统一控制面客户端加载服务端 Agent DTO", async () => {
    render(<AgentsViewer />);

    await waitFor(() => expect(screen.getByText("客服智能体")).toBeTruthy());
    expect(screen.getByText("support")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/admin/api/v1/agents", expect.any(Object));
  });
});
