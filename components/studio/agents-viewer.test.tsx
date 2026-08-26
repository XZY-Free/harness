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
          version_no: 2,
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

  it("刷新成功后清除旧加载错误并显示最新档案", async () => {
    fetchMock.mockRejectedValueOnce(new Error("temporary failure"));
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: "agent-2",
            agent_key: "hr-assistant",
            display_name: "企业人力智能助手",
            description: null,
            lifecycle_state: "draft",
            current_revision_id: null,
            owner_user_id: "user-1",
            visibility_policy_id: null,
            version_no: 1,
            updated_at: "2026-08-26T00:00:00.000Z",
          },
        ],
        total: 1,
      }),
    );

    const view = render(<AgentsViewer refreshToken={0} />);
    await waitFor(() => expect(screen.getByText("智能体列表加载失败")).toBeTruthy());

    view.rerender(<AgentsViewer refreshToken={1} />);
    await waitFor(() => expect(screen.getByText("企业人力智能助手")).toBeTruthy());
    expect(screen.queryByText("智能体列表加载失败")).toBeNull();
  });
});
